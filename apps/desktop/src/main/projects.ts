import { createHash, randomBytes } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  addRecording, createProject, parseProject, sequenceDuration, serializeProject, type Project, type Recording,
} from '@momotombo/project-model';
import { IMPORT_VIDEO_TYPES, type ImportedVideo, type ProjectSummary } from '@momotombo/protocol';
import { PROJECT_FILE } from '../shared/brand';
import { dirSize, exists, removeQuiet, safeJoin, writeFileAtomic } from './fsutil';
import { readProjectText, validatedProjectText, writeProjectTextKeepingBackup } from './project-file';
import { tm } from './settings';

const EXTERNAL_EDIT_SETTLE_MS = 80;
const KNOWN_TEXTS_KEPT = 16;
const PEAKS_MAGIC = 'MPK1';
const PEAKS_HEADER = 20;

export interface PeaksStamp { size: number; mtimeMs: number }

interface ExternalEditWatch {
  onEdit: (project: Project) => void;
  knownTexts: string[];
  stop: () => void;
}

/**
 * Projects are folders under one root: project.json + media/ + cache/.
 * Writes are atomic and the previous project.json is kept as project.json.bak.
 */
export class ProjectStore {
  private dirs = new Map<string, string>();
  private writeChain = new Map<string, Promise<unknown>>();
  /** Changes made by create()/forget() while a scan runs, applied over that scan's result. */
  private scanLogs = new Set<Map<string, string | null>>();
  /**
   * Recordings appendRecording() added that no save has carried back yet. Nothing removes an
   * entry from `project.recordings`, so a save without one is a stale copy and gets it back.
   */
  private unconfirmed = new Map<string, Map<string, Recording>>();
  private watches = new Map<string, ExternalEditWatch>();

  constructor(readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.scan();
  }

  /**
   * Rebuilds the id → folder map off to the side and swaps it in at the end, so lookups keep
   * working during the scan. Returns each folder's parsed project.json for callers that need it.
   */
  private async scan(): Promise<Map<string, unknown>> {
    const log = new Map<string, string | null>();
    this.scanLogs.add(log);
    try {
      let entries;
      try { entries = await readdir(this.root, { withFileTypes: true }); } catch { return new Map(); }
      const heads = await Promise.all(entries.filter((e) => e.isDirectory()).map(async (e) => {
        const dir = join(this.root, e.name);
        try { return { dir, json: JSON.parse(await readFile(join(dir, PROJECT_FILE), 'utf8')) as unknown }; } catch { return null; }
      }));
      const found = new Map<string, string>();
      const parsed = new Map<string, unknown>();
      for (const h of heads) {
        const id = (h?.json as { id?: unknown } | null | undefined)?.id;
        if (!h || typeof id !== 'string') continue;
        found.set(id, h.dir);
        parsed.set(h.dir, h.json);
      }
      for (const [id, dir] of log) {
        if (dir === null) found.delete(id);
        else found.set(id, dir);
      }
      this.dirs = found;
      return parsed;
    } finally {
      this.scanLogs.delete(log);
    }
  }

  private noteChange(id: string, dir: string | null): void {
    for (const log of this.scanLogs) log.set(id, dir);
  }

  /** Runs `task` after every earlier write or read-modify-write on this project has settled. */
  private serialized<T>(id: string, task: () => Promise<T>): Promise<T> {
    const prev = this.writeChain.get(id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    this.writeChain.set(id, next);
    const cleanup = () => { if (this.writeChain.get(id) === next) this.writeChain.delete(id); };
    next.then(cleanup, cleanup);
    return next;
  }

  /** Every project folder, freshly scanned. */
  async entries(): Promise<{ id: string; dir: string }[]> {
    await this.scan();
    return [...this.dirs].map(([id, dir]) => ({ id, dir }));
  }

  dirOf(id: string): string {
    const d = this.dirs.get(id);
    if (!d) throw new Error(tm("No se encontró el proyecto"));
    return d;
  }

  resolve(id: string, rel: string): string {
    const p = safeJoin(this.dirOf(id), rel);
    if (!p) throw new Error('Invalid path');
    return p;
  }

  /**
   * Copies a video from the computer into the project (media/imp_…/), so the project stays
   * self-contained and the original file is never touched.
   */
  async importVideo(id: string, src: string): Promise<ImportedVideo> {
    const ext = extname(src).toLowerCase();
    const mime = IMPORT_VIDEO_TYPES[ext];
    if (!mime) throw new Error(tm("Este tipo de archivo no es compatible. Elige MP4, MOV, M4V o WebM."));
    const recordingId = `imp_${randomBytes(6).toString('hex')}`;
    const file = `media/${recordingId}/video${ext}`;
    const dest = this.resolve(id, file);
    await mkdir(dirname(dest), { recursive: true });
    try {
      await copyFile(src, dest);
    } catch (e) {
      await removeQuiet(dirname(dest));
      throw e;
    }
    return { recordingId, file, mime, name: basename(src, extname(src)), bytes: (await stat(dest)).size };
  }

  /** Removes a copied video that turned out not to be playable. */
  async discardImport(id: string, recordingId: string): Promise<void> {
    await removeQuiet(this.resolve(id, `media/${recordingId}`));
  }

  async list(): Promise<ProjectSummary[]> {
    const parsed = await this.scan();
    const summaries = await Promise.all([...this.dirs].map(async ([id, dir]): Promise<ProjectSummary | null> => {
      try {
        const raw = parsed.has(dir) ? parsed.get(dir) : JSON.parse(await readFile(join(dir, PROJECT_FILE), 'utf8'));
        const p = parseProject(raw);
        const [thumbnail, sizeBytes] = await Promise.all([readThumbnail(dir), dirSize(join(dir, 'media'))]);
        return {
          id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
          durationTicks: sequenceDuration(p), recordings: Object.keys(p.recordings).length,
          thumbnail, sizeBytes,
        };
      } catch { return null; }
    }));
    const out = summaries.filter((s): s is ProjectSummary => s !== null);
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out;
  }

  async create(name: string): Promise<{ id: string; dir: string; project: Project }> {
    const project = createProject(name);
    const safe = name.replace(/[^\p{L}\p{N} ._-]+/gu, '').trim().slice(0, 60) || 'Proyecto';
    let dir = join(this.root, `${safe} ${project.id.slice(4, 12)}`);
    let n = 2;
    while (await exists(dir)) dir = join(this.root, `${safe} ${project.id.slice(4, 12)}-${n++}`);
    await mkdir(join(dir, 'media'), { recursive: true });
    await mkdir(join(dir, 'cache'), { recursive: true });
    await writeFileAtomic(join(dir, PROJECT_FILE), serializeProject(project));
    this.dirs.set(project.id, dir);
    this.noteChange(project.id, dir);
    return { id: project.id, dir, project };
  }

  async read(id: string): Promise<Project> {
    return parseProject(JSON.parse(await readProjectText(this.dirOf(id))));
  }

  /**
   * Saves serialized JSON after validating it. Writes for one project are serialized. While an
   * editor watches the project, a save over an edit made outside the app that the editor has not
   * received yet is refused, and that edit is sent to the editor instead.
   */
  async save(id: string, json: string): Promise<void> {
    const project = parseProject(JSON.parse(json));
    if (project.id !== id) throw new Error('Project id does not match');
    const dir = this.dirOf(id);
    await this.serialized(id, async () => {
      if (await this.deliverExternalEdit(id)) throw new Error(tm("El proyecto cambió fuera del editor. Se cargó la versión nueva."));
      await this.write(id, dir, this.keepAppended(id, project));
    });
  }

  private async write(id: string, dir: string, project: Project): Promise<void> {
    const text = validatedProjectText(project);
    this.remember(id, text);
    await writeProjectTextKeepingBackup(dir, text);
  }

  private remember(id: string, text: string): void {
    const known = this.watches.get(id)?.knownTexts;
    if (!known) return;
    known.push(text);
    if (known.length > KNOWN_TEXTS_KEPT) known.shift();
  }

  /** Sends the editor watching `id` an edit made outside the app; true when there was one. */
  private async deliverExternalEdit(id: string): Promise<boolean> {
    const w = this.watches.get(id);
    if (!w) return false;
    const text = await readProjectText(this.dirOf(id)).catch(() => null);
    if (text === null || w.knownTexts.includes(text)) return false;
    let project: Project;
    try { project = parseProject(JSON.parse(text)); } catch { return false; }
    this.remember(id, text);
    w.onEdit(project);
    return true;
  }

  /**
   * Calls `onEdit` with project.json each time a program other than this app rewrites it with a
   * valid project. One project is watched at a time; watching another stops the previous watch.
   */
  async watchExternalEdits(id: string, onEdit: (project: Project) => void): Promise<void> {
    this.stopWatching();
    const dir = this.dirOf(id);
    let settle: ReturnType<typeof setTimeout> | undefined;
    let watcher: FSWatcher;
    try {
      watcher = watch(dir, (_event, name) => {
        if (name !== PROJECT_FILE) return;
        clearTimeout(settle);
        settle = setTimeout(() => void this.serialized(id, () => this.deliverExternalEdit(id)), EXTERNAL_EDIT_SETTLE_MS);
      });
    } catch (e) {
      process.stderr.write(`Cannot watch ${dir} for outside edits: ${String(e)}\n`);
      return;
    }
    const w: ExternalEditWatch = {
      onEdit,
      knownTexts: [await readProjectText(dir).catch(() => '')],
      stop: () => {
        clearTimeout(settle);
        watcher.close();
        if (this.watches.get(id) === w) this.watches.delete(id);
      },
    };
    watcher.on('error', w.stop);
    this.watches.set(id, w);
  }

  stopWatching(): void {
    for (const w of [...this.watches.values()]) w.stop();
  }

  private keepAppended(id: string, project: Project): Project {
    const pending = this.unconfirmed.get(id);
    if (!pending) return project;
    let merged = project;
    for (const [recordingId, recording] of pending) {
      if (recordingId in project.recordings) pending.delete(recordingId);
      else merged = addRecording(merged, recording);
    }
    if (pending.size === 0) this.unconfirmed.delete(id);
    return merged;
  }

  async appendRecording(id: string, recording: Recording): Promise<Project> {
    const dir = this.dirOf(id);
    return this.serialized(id, async () => {
      await this.deliverExternalEdit(id);
      const project = addRecording(await this.read(id), recording);
      await this.write(id, dir, project);
      const pending = this.unconfirmed.get(id) ?? new Map<string, Recording>();
      pending.set(recording.id, recording);
      this.unconfirmed.set(id, pending);
      return project;
    });
  }

  async rename(id: string, name: string): Promise<void> {
    const dir = this.dirOf(id);
    await this.serialized(id, async () => {
      await this.deliverExternalEdit(id);
      const p = await this.read(id);
      await this.write(id, dir, { ...p, name: name.trim() || p.name });
    });
  }

  async setThumbnail(id: string, jpeg: Uint8Array): Promise<void> {
    await writeFileAtomic(join(this.dirOf(id), 'cache', 'thumbnail.jpg'), jpeg);
  }

  async readPeaks(id: string, file: string): Promise<{ stamp: PeaksStamp; data: Uint8Array | null }> {
    const { source, cache } = this.peaksPaths(id, file);
    const info = await stat(source);
    const stamp = { size: info.size, mtimeMs: info.mtimeMs };
    const bytes = await readFile(cache).catch(() => null);
    if (!bytes || bytes.length < PEAKS_HEADER || bytes.toString('latin1', 0, 4) !== PEAKS_MAGIC) return { stamp, data: null };
    const same = bytes.readDoubleLE(4) === stamp.size && bytes.readDoubleLE(12) === stamp.mtimeMs;
    return { stamp, data: same ? bytes.subarray(PEAKS_HEADER) : null };
  }

  async writePeaks(id: string, file: string, stamp: PeaksStamp, data: Uint8Array): Promise<boolean> {
    const { source, cache } = this.peaksPaths(id, file);
    const info = await stat(source);
    if (info.size !== stamp.size || info.mtimeMs !== stamp.mtimeMs) return false;
    const header = Buffer.alloc(PEAKS_HEADER);
    header.write(PEAKS_MAGIC, 0, 'latin1');
    header.writeDoubleLE(stamp.size, 4);
    header.writeDoubleLE(stamp.mtimeMs, 12);
    await mkdir(dirname(cache), { recursive: true });
    await writeFileAtomic(cache, Buffer.concat([header, data]));
    return true;
  }

  private peaksPaths(id: string, file: string): { source: string; cache: string } {
    if (!file.startsWith('media/')) throw new Error('Invalid path');
    const name = `peaks-${createHash('sha256').update(file).digest('hex').slice(0, 20)}.bin`;
    return { source: this.resolve(id, file), cache: join(this.dirOf(id), 'cache', name) };
  }

  forget(id: string): void {
    this.watches.get(id)?.stop();
    this.dirs.delete(id);
    this.unconfirmed.delete(id);
    this.noteChange(id, null);
  }

  async mediaDir(id: string, recordingId: string): Promise<string> {
    const dir = join(this.dirOf(id), 'media', recordingId);
    await mkdir(dir, { recursive: true });
    return dir;
  }
}

async function readThumbnail(dir: string): Promise<string | null> {
  try {
    return `data:image/jpeg;base64,${(await readFile(join(dir, 'cache', 'thumbnail.jpg'))).toString('base64')}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  addRecording, createProject, parseProject, sequenceDuration, serializeProject, type Project, type Recording,
} from '@momotombo/project-model';
import { IMPORT_VIDEO_TYPES, type ImportedVideo, type ProjectSummary } from '@momotombo/protocol';
import { PROJECT_FILE } from '../shared/brand';
import { dirSize, exists, removeQuiet, safeJoin, writeFileAtomic } from './fsutil';
import { tm } from './settings';

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
    return parseProject(JSON.parse(await readFile(join(this.dirOf(id), PROJECT_FILE), 'utf8')));
  }

  /** Saves serialized JSON after validating it. Writes for one project are serialized. */
  async save(id: string, json: string): Promise<void> {
    const project = parseProject(JSON.parse(json));
    if (project.id !== id) throw new Error('Project id does not match');
    const dir = this.dirOf(id);
    await this.serialized(id, () => writeProject(dir, this.keepAppended(id, project)));
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
      const project = addRecording(await this.read(id), recording);
      await writeProject(dir, parseProject(JSON.parse(serializeProject(project))));
      const pending = this.unconfirmed.get(id) ?? new Map<string, Recording>();
      pending.set(recording.id, recording);
      this.unconfirmed.set(id, pending);
      return project;
    });
  }

  async rename(id: string, name: string): Promise<void> {
    const dir = this.dirOf(id);
    await this.serialized(id, async () => {
      const p = await this.read(id);
      await writeProject(dir, parseProject(JSON.parse(serializeProject({ ...p, name: name.trim() || p.name }))));
    });
  }

  async setThumbnail(id: string, jpeg: Uint8Array): Promise<void> {
    await writeFileAtomic(join(this.dirOf(id), 'cache', 'thumbnail.jpg'), jpeg);
  }

  forget(id: string): void {
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

async function writeProject(dir: string, project: Project): Promise<void> {
  const file = join(dir, PROJECT_FILE);
  try {
    const current = await readFile(file);
    await writeFileAtomic(`${file}.bak`, current);
  } catch { /* first save */ }
  await writeFileAtomic(file, serializeProject(project));
}

async function readThumbnail(dir: string): Promise<string | null> {
  try {
    return `data:image/jpeg;base64,${(await readFile(join(dir, 'cache', 'thumbnail.jpg'))).toString('base64')}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

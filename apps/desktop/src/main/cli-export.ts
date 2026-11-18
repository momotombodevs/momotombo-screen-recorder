import { randomBytes } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { lstat, open, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Project } from '@momotombo/project-model';
import type { CliExportJob, CliExportReport, ExportTarget } from '@momotombo/protocol';
import {
  MAX_REQUEST_BYTES, busyReason, nextStatus, outPathProblem, parseExportRequest, projectExportCancelPath, projectExportStatusPath,
  requestFileLocation, staleExportFiles, startStatus, type ExportRequest, type ExportStatus, type RefusalReason,
} from '../shared/export-request';
import { exportBaseName } from '../shared/export-name';
import { exists, writeFileAtomic } from './fsutil';

export type LoadedRequest =
  | { ok: true; request: ExportRequest; dir: string; out: string | null }
  | { ok: false; error: string; dir: string | null; requestId: string | null };

async function readSmallRegularFile(path: string): Promise<string> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await fh.stat();
    if (!info.isFile()) throw new Error('not a regular file');
    if (info.size > MAX_REQUEST_BYTES) throw new Error(`larger than ${MAX_REQUEST_BYTES} bytes`);
    const buffer = Buffer.alloc(MAX_REQUEST_BYTES + 1);
    const { bytesRead } = await fh.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_REQUEST_BYTES) throw new Error(`larger than ${MAX_REQUEST_BYTES} bytes`);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function realFolder(dir: string): Promise<string | null> {
  try {
    const real = await realpath(dir);
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export async function loadExportRequest(
  path: string,
  projects: { root: string; dirOf: (id: string) => Promise<string | null> },
): Promise<LoadedRequest> {
  let text: string;
  try {
    text = await readSmallRegularFile(path);
  } catch (e) {
    return { ok: false, error: `Cannot read the export request ${path}: ${(e as Error).message}`, dir: null, requestId: null };
  }
  const parsed = parseExportRequest(text);
  if (!parsed.ok) return { ok: false, error: parsed.error, dir: null, requestId: null };
  const { request } = parsed;
  const dir = await projects.dirOf(request.projectId);
  if (!dir) return { ok: false, error: `No project with id ${request.projectId}.`, dir: null, requestId: request.requestId };
  if (!request.out) return { ok: true, request, dir, out: null };
  const realParent = await realFolder(dirname(request.out));
  const taken = await lstat(request.out).then(() => true, (e: NodeJS.ErrnoException) => e.code !== 'ENOENT');
  const projectsRoot = (await realFolder(projects.root)) ?? projects.root;
  const problem = outPathProblem(request.out, request.format, { realParent, projectsRoot, taken });
  if (problem || !realParent) return { ok: false, error: problem ?? 'Invalid --out.', dir, requestId: request.requestId };
  return { ok: true, request, dir, out: join(realParent, basename(request.out)) };
}

export const writeStatus = (dir: string, status: ExportStatus): Promise<void> =>
  writeFileAtomic(join(dir, projectExportStatusPath(status.requestId)), `${JSON.stringify(status, null, 2)}\n`);

export function writeStatusNow(dir: string, status: ExportStatus): void {
  const file = join(dir, projectExportStatusPath(status.requestId));
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx');
  try {
    writeSync(fd, `${JSON.stringify(status, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export async function completeFileProblem(outFile: string | null, bytes: number | null): Promise<string | null> {
  if (!outFile || bytes === null) return 'The export finished without a file.';
  const info = await stat(outFile).catch(() => null);
  if (!info?.isFile()) return `The exported file is missing: ${outFile}`;
  if (info.size !== bytes) return `The exported file has ${info.size} bytes, expected ${bytes}: ${outFile}`;
  return null;
}

const KEPT_REQUESTS = 5;

async function pruneExportFiles(dir: string, current: string): Promise<void> {
  const cache = join(dir, 'cache');
  const names = await readdir(cache).catch(() => [] as string[]);
  const entries = await Promise.all(names.map(async (name) => ({ name, mtimeMs: (await stat(join(cache, name)).catch(() => null))?.mtimeMs ?? 0 })));
  await Promise.all(staleExportFiles(entries, KEPT_REQUESTS, current).map((name) => rm(join(cache, name), { force: true })));
}

export interface CliExportHost {
  root: string;
  projectDirs(): Promise<{ id: string; dir: string }[]>;
  readProject(id: string): Promise<Project>;
  busy(): { capturePhase: string; exportsRunning: number };
  issueTarget(path: string): ExportTarget;
  defaultTarget(projectId: string, baseName: string, extension: 'mp4' | 'webm'): Promise<ExportTarget>;
  mediaBase(projectId: string): string;
  showJob(): void;
  restoreThrottling(): void;
  cancelExport(exportId: string): Promise<void>;
  abortInRenderer(requestId: string): void;
  log(line: string): void;
  settled(): void;
  now?: () => Date;
}

interface ActiveJob {
  requestId: string;
  dir: string;
  status: ExportStatus;
  job: CliExportJob | null;
  taken: boolean;
  token: string | null;
  exportId: string | null;
  written: { path: string; bytes: number } | null;
}

export class CliExports {
  private active: ActiveJob | null = null;
  private writes: Promise<void> = Promise.resolve();
  private cancelTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: CliExportHost, private readonly cancelPollMs = 1000) {}

  get busy(): boolean {
    return this.active !== null;
  }

  private now = () => (this.host.now ?? (() => new Date()))();

  private save(dir: string, status: ExportStatus): Promise<void> {
    this.writes = this.writes.then(() => writeStatus(dir, status)).catch((e: unknown) => { this.host.log(`Could not write the export status: ${String(e)}`); });
    return this.writes;
  }

  settled(): Promise<void> {
    return this.writes;
  }

  private async refuse(dir: string, requestId: string, reason: RefusalReason, error: string): Promise<void> {
    await this.save(dir, startStatus(requestId, this.now(), { state: 'refused', reason, error }));
    if (!this.active) this.host.settled();
  }

  private finish(active: ActiveJob, patch: Partial<ExportStatus> & { state: 'done' | 'failed' | 'refused' }): Promise<void> {
    if (this.active !== active) return this.writes;
    this.active = null;
    if (this.cancelTimer) clearInterval(this.cancelTimer);
    this.cancelTimer = null;
    this.host.restoreThrottling();
    const next = nextStatus(active.status, { ...active.status, ...patch }, this.now());
    return (next ? this.save(active.dir, next) : this.writes).then(() => { if (!this.active) this.host.settled(); });
  }

  private async dirOf(id: string): Promise<string | null> {
    return (await this.host.projectDirs()).find((e) => e.id === id)?.dir ?? null;
  }

  private async locate(path: string): Promise<{ dir: string; requestId: string } | null> {
    const where = requestFileLocation(path, this.host.root);
    if (!where) return null;
    const known = (await this.host.projectDirs()).some((e) => e.dir === where.projectDir);
    return known ? { dir: where.projectDir, requestId: where.requestId } : null;
  }

  async accept(path: string): Promise<void> {
    const loaded = await loadExportRequest(path, { root: this.host.root, dirOf: (id) => this.dirOf(id) });
    if (!loaded.ok) {
      this.host.log(`Export request refused: ${loaded.error}`);
      const where = loaded.dir && loaded.requestId ? { dir: loaded.dir, requestId: loaded.requestId } : await this.locate(path);
      if (where) await this.refuse(where.dir, where.requestId, 'invalid-request', loaded.error);
      else if (!this.active) this.host.settled();
      return;
    }
    const { request, dir, out } = loaded;
    const busy = busyReason({ ...this.host.busy(), jobActive: this.active !== null });
    if (busy) {
      await this.refuse(dir, request.requestId, busy.reason, busy.error);
      return;
    }
    const active: ActiveJob = {
      requestId: request.requestId, dir, status: startStatus(request.requestId, this.now()), job: null, taken: false, token: null, exportId: null, written: null,
    };
    this.active = active;
    try {
      const project = await this.host.readProject(request.projectId);
      const variantId = request.variantId ?? project.activeVariantId;
      if (!project.variants.some((v) => v.id === variantId))
        throw new Error(`The project has no format ${variantId}; it has ${project.variants.map((v) => v.id).join(', ')}.`);
      const target = out ? this.host.issueTarget(out) : await this.host.defaultTarget(project.id, exportBaseName(project, variantId), request.format);
      if (this.active !== active) return;
      active.token = target.token;
      active.job = jobFor(request, project, dir, this.host.mediaBase(request.projectId), target);
    } catch (e) {
      this.active = null;
      await this.refuse(dir, request.requestId, 'invalid-request', `The project cannot be exported: ${(e as Error).message}`);
      return;
    }
    await this.save(dir, active.status);
    await pruneExportFiles(dir, request.requestId).catch(() => undefined);
    this.cancelTimer = setInterval(() => void this.checkCancel(), this.cancelPollMs);
    this.host.showJob();
  }

  take(fromMainWindow: boolean): CliExportJob | null {
    const active = this.active;
    if (!fromMainWindow || !active?.job || active.taken) return null;
    active.taken = true;
    return active.job;
  }

  noteBegin(token: string, exportId: string): void {
    if (this.active && this.active.token === token) this.active.exportId = exportId;
  }

  noteEnd(exportId: string, result: { path: string; bytes: number } | null): void {
    if (this.active && this.active.exportId === exportId && result) this.active.written = result;
  }

  async report(report: CliExportReport, fromMainWindow: boolean): Promise<void> {
    const active = this.active;
    if (!fromMainWindow || !active?.taken || report.requestId !== active.requestId) return;
    if (report.state === 'refused') {
      await this.finish(active, { state: 'refused', reason: report.reason ?? 'invalid-request', error: report.error ?? 'Refused.' });
      return;
    }
    if (report.state === 'done') {
      const written = active.written;
      const problem = await completeFileProblem(written?.path ?? null, written?.bytes ?? null);
      await this.finish(active, problem
        ? { state: 'failed', error: problem }
        : { state: 'done', phase: 'done', outFile: written!.path, bytes: written!.bytes });
      return;
    }
    if (report.state === 'failed') {
      await this.finish(active, { state: 'failed', error: report.error, phase: report.phase, progress: report.progress });
      return;
    }
    const next = nextStatus(active.status, { ...report, outFile: null, bytes: null, reason: null }, this.now());
    if (!next || this.active !== active) return;
    active.status = next;
    await this.save(active.dir, next);
  }

  async checkCancel(): Promise<void> {
    const active = this.active;
    if (!active || !(await exists(join(active.dir, projectExportCancelPath(active.requestId))))) return;
    if (this.active !== active) return;
    if (active.exportId) await this.host.cancelExport(active.exportId).catch(() => undefined);
    this.host.abortInRenderer(active.requestId);
    await this.finish(active, { state: 'failed', error: 'Cancelled by momotombo-edit (timeout or interrupt); the partial file was removed.' });
    await rm(join(active.dir, projectExportCancelPath(active.requestId)), { force: true });
  }

  windowLost(): Promise<void> {
    const active = this.active;
    return active?.taken ? this.finish(active, { state: 'failed', error: 'The Momotombo window closed during the export.' }) : this.writes;
  }

  failNow(error: string): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    if (this.cancelTimer) clearInterval(this.cancelTimer);
    const next = nextStatus(active.status, { ...active.status, state: 'failed', error }, this.now());
    if (next) writeStatusNow(active.dir, next);
  }
}

function jobFor(request: ExportRequest, project: Project, dir: string, mediaBase: string, target: ExportTarget): CliExportJob {
  const { requestId, projectId, format, variantId, resolution, fps, quality, includeAudio } = request;
  return {
    requestId,
    opened: { id: projectId, json: project, mediaBase, dir },
    choices: { format, variantId, resolution, fps, quality, includeAudio },
    target,
  };
}

import { constants, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  MAX_REQUEST_BYTES, outPathProblem, projectExportStatusPath, parseExportRequest, type ExportRequest, type ExportStatus,
} from '../shared/export-request';
import { writeFileAtomic } from './fsutil';

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
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
  renameSync(tmp, file);
}

export async function completeFileProblem(outFile: string | null, bytes: number | null): Promise<string | null> {
  if (!outFile || bytes === null) return 'The export finished without a file.';
  const info = await stat(outFile).catch(() => null);
  if (!info?.isFile()) return `The exported file is missing: ${outFile}`;
  if (info.size !== bytes) return `The exported file has ${info.size} bytes, expected ${bytes}: ${outFile}`;
  return null;
}

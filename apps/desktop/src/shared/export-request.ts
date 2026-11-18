import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { ProjectId } from '@momotombo/protocol';

export const EXPORT_REQUEST_FLAG = '--export-request=';
export const MAX_REQUEST_BYTES = 16_384;
export const projectExportStatusPath = (requestId: string): string => `cache/export-status-${requestId}.json`;
export const projectExportRequestPath = (requestId: string): string => `cache/export-request-${requestId}.json`;
export const projectExportCancelPath = (requestId: string): string => `cache/export-cancel-${requestId}`;
const EXPORT_FILE = /^export-(?:status|request|cancel)-(xr_[0-9a-f]{16})(?:\.json)?$/;

export const ExportRequest = z.object({
  requestId: z.string().regex(/^xr_[0-9a-f]{16}$/),
  projectId: ProjectId,
  variantId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  format: z.enum(['mp4', 'webm']),
  resolution: z.enum(['1080', '2160']).optional(),
  fps: z.union([z.literal(30), z.literal(60)]).optional(),
  quality: z.enum(['standard', 'high']).optional(),
  includeAudio: z.boolean().optional(),
  out: z.string().min(1).max(1024).optional(),
}).strict();
export type ExportRequest = z.infer<typeof ExportRequest>;

export const EXPORT_STATES = ['queued', 'running', 'done', 'failed', 'refused'] as const;
export type ExportState = (typeof EXPORT_STATES)[number];
export const TERMINAL_STATES: readonly ExportState[] = ['done', 'failed', 'refused'];

export const REFUSAL_REASONS = ['recording', 'exporting', 'editing-other-project', 'invalid-request'] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export const ExportStatus = z.object({
  requestId: z.string(),
  state: z.enum(EXPORT_STATES),
  progress: z.number().min(0).max(1),
  phase: z.string().nullable(),
  outFile: z.string().nullable(),
  bytes: z.number().int().min(0).nullable(),
  error: z.string().nullable(),
  reason: z.enum(REFUSAL_REASONS).nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type ExportStatus = z.infer<typeof ExportStatus>;

export function exportRequestPathFromArgv(argv: readonly string[]): string | null {
  const arg = argv.find((a) => a.startsWith(EXPORT_REQUEST_FLAG));
  return arg ? arg.slice(EXPORT_REQUEST_FLAG.length) || null : null;
}

export function parseExportRequest(text: string): { ok: true; request: ExportRequest } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `The export request is not valid JSON: ${(e as Error).message}` };
  }
  const parsed = ExportRequest.safeParse(raw);
  if (!parsed.success)
    return { ok: false, error: `Invalid export request: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ')}` };
  return { ok: true, request: parsed.data };
}

export function outPathProblem(
  out: string,
  format: 'mp4' | 'webm',
  facts: { realParent: string | null; projectsRoot: string; taken: boolean },
): string | null {
  if (!isAbsolute(out)) return `--out must be an absolute path: ${out}`;
  if (extname(out).toLowerCase() !== `.${format}`) return `--out must end in .${format} for a ${format} export: ${out}`;
  if (basename(out).startsWith('.')) return `--out must not be a hidden file: ${out}`;
  if (!facts.realParent) return `The folder for --out does not exist: ${out}`;
  if (facts.taken) return `--out already exists; remove it or choose another name: ${out}`;
  const rel = relative(facts.projectsRoot, facts.realParent);
  const inside = rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  if (inside) {
    const parts = rel.split(sep);
    if (parts.length < 2 || parts[1] !== 'exports')
      return `Inside the projects folder an export may only go to a project's exports/ folder: ${out}`;
  }
  return null;
}

export function busyReason(s: { capturePhase: string; exportsRunning: number; jobActive: boolean }): { reason: RefusalReason; error: string } | null {
  if (s.capturePhase !== 'idle' && s.capturePhase !== 'error')
    return { reason: 'recording', error: 'Momotombo is recording; try again when the recording ends.' };
  if (s.exportsRunning > 0 || s.jobActive)
    return { reason: 'exporting', error: 'Momotombo is already exporting; try again when that export ends.' };
  return null;
}

export const parseExportStatus = (raw: unknown): ExportStatus => ExportStatus.parse(raw);

export function statusForRequest(text: string | null, requestId: string): ExportStatus | null {
  if (text === null) return null;
  try {
    const status = ExportStatus.safeParse(JSON.parse(text));
    return status.success && status.data.requestId === requestId ? status.data : null;
  } catch {
    return null;
  }
}

export type ExportReport = Pick<ExportStatus, 'state' | 'progress' | 'phase' | 'outFile' | 'bytes' | 'error' | 'reason'>;

export function startStatus(requestId: string, now: Date, report: Partial<ExportReport> = {}): ExportStatus {
  const state = report.state ?? 'queued';
  return {
    requestId, state, progress: 0, phase: null, outFile: null, bytes: null, error: null, reason: null, ...report,
    startedAt: now.toISOString(), finishedAt: TERMINAL_STATES.includes(state) ? now.toISOString() : null,
  };
}

export function nextStatus(prev: ExportStatus, report: ExportReport, now: Date): ExportStatus | null {
  if (TERMINAL_STATES.includes(prev.state)) return null;
  const done = TERMINAL_STATES.includes(report.state);
  return { ...prev, ...report, progress: report.state === 'done' ? 1 : report.progress, finishedAt: done ? now.toISOString() : null };
}

export function requestFileLocation(path: string, projectsRoot: string): { projectDir: string; requestId: string } | null {
  const parts = relative(resolve(projectsRoot), resolve(path)).split(sep);
  if (parts.length !== 3 || parts[0] === '..' || parts[0] === '' || parts[1] !== 'cache') return null;
  const match = /^export-request-(xr_[0-9a-f]{16})\.json$/.exec(parts[2]!);
  return match ? { projectDir: join(resolve(projectsRoot), parts[0]!), requestId: match[1]! } : null;
}

export function staleExportFiles(entries: readonly { name: string; mtimeMs: number }[], keep: number, current: string): string[] {
  const newest = new Map<string, number>();
  for (const e of entries) {
    const id = EXPORT_FILE.exec(e.name)?.[1];
    if (id) newest.set(id, Math.max(newest.get(id) ?? 0, e.mtimeMs));
  }
  const kept = new Set([current, ...[...newest].filter(([id]) => id !== current).sort((a, b) => b[1] - a[1]).slice(0, keep).map(([id]) => id)]);
  return entries.filter((e) => { const id = EXPORT_FILE.exec(e.name)?.[1]; return id !== undefined && !kept.has(id); }).map((e) => e.name);
}

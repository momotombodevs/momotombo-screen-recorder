import type { ID, Project } from '@momotombo/project-model';
import type { CliExportJob, CliExportReport, ExportTarget } from '@momotombo/protocol';
import { PROFILE } from '../../shared/distribution';
import type { ExportFormat, ExportOptions, ExportProgress, ExportSupport } from './exporter';

export interface ExportChoices {
  variantId: ID;
  format: ExportFormat;
  resolution: '1080' | '2160';
  fps: 30 | 60;
  quality: 'standard' | 'high';
  includeAudio: boolean;
}

export function defaultExportChoices(project: Project): ExportChoices {
  return {
    variantId: project.activeVariantId,
    format: PROFILE.defaultExport,
    resolution: '1080',
    fps: project.sequence.fps.num >= 50 ? 60 : 30,
    quality: 'high',
    includeAudio: true,
  };
}

export function exportOptions(choices: ExportChoices, target: ExportTarget, support: ExportSupport | null): ExportOptions {
  return { ...choices, target, ...(support?.ok ? { route: support.route } : {}) };
}

export const writtenFormat = (choices: Pick<ExportChoices, 'format'>, support: ExportSupport | null): ExportFormat =>
  support?.ok ? support.written : choices.format;

export function cliExportChoices(project: Project, requested: CliExportJob['choices']): { ok: true; choices: ExportChoices } | { ok: false; error: string } {
  const given = Object.fromEntries(Object.entries(requested).filter(([, v]) => v !== undefined)) as Partial<ExportChoices>;
  const choices = { ...defaultExportChoices(project), ...given };
  if (!project.variants.some((v) => v.id === choices.variantId))
    return { ok: false, error: `The project has no format ${choices.variantId}; it has ${project.variants.map((v) => v.id).join(', ')}.` };
  if (!PROFILE.formats.includes(choices.format))
    return { ok: false, error: `This build of Momotombo exports ${PROFILE.formats.join(' or ')}, not ${choices.format}.` };
  return { ok: true, choices };
}

const RUNNING_PHASES: readonly ExportProgress['phase'][] = ['preparing', 'audio', 'video', 'finishing'];

export function cliReport(requestId: string, p: ExportProgress): CliExportReport {
  const base = { requestId, phase: p.phase, progress: p.total > 0 ? Math.min(1, p.frame / p.total) : 0, outFile: null, bytes: null, error: null, reason: null };
  if (RUNNING_PHASES.includes(p.phase)) return { ...base, state: 'running' };
  if (p.phase === 'done') return { ...base, state: 'done', progress: 1, outFile: p.path ?? null, bytes: p.bytes ?? null };
  return { ...base, state: 'failed', error: p.phase === 'cancelled' ? 'The export was cancelled in the app.' : p.message ?? 'The export failed.' };
}

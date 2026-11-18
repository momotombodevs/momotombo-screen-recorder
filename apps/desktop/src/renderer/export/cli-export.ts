import type { CliExportJob, CliExportReport } from '@momotombo/protocol';
import { api } from '../api';
import { EditorStore } from '../state/editor-store';
import { checkExportSupport, runExport, type ExportProgress } from './exporter';
import { cliExportChoices, cliReport, exportOptions } from './options';

const REPORT_INTERVAL_MS = 500;

export async function runCliExport(job: CliExportJob, onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<CliExportReport> {
  const failed = (error: string): CliExportReport => ({
    requestId: job.requestId, state: 'failed', progress: 0, phase: 'preparing', outFile: null, bytes: null, error, reason: null,
  });
  const store = new EditorStore(job.opened);
  await store.loadCursors();
  const { project, cursors, mediaBase } = store.getState();
  const picked = cliExportChoices(project, job.choices);
  if (!picked.ok) return failed(picked.error);
  const { choices } = picked;
  const support = await checkExportSupport(project, choices);
  if (!support.ok) return failed(support.message);
  if (support.written !== choices.format)
    return failed(`This computer cannot write ${choices.format}; it would write ${support.written}. Ask for --format ${support.written}.`);
  let lastSent = 0;
  let lastPhase = '';
  const report = (p: ExportProgress) => {
    onProgress(p);
    const now = performance.now();
    if (p.phase === lastPhase && now - lastSent < REPORT_INTERVAL_MS) return;
    lastSent = now;
    lastPhase = p.phase;
    const r = cliReport(job.requestId, p);
    if (r.state === 'running') void api.reportCliExport(r).catch(() => undefined);
  };
  const result = await runExport(project, cursors, mediaBase, exportOptions(choices, job.target, support), report, signal);
  return cliReport(job.requestId, result);
}

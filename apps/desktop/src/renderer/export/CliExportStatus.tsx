import { useEffect, useRef, useState, type RefObject } from 'react';
import type { CliExportReport } from '@momotombo/protocol';
import { api } from '../api';
import { durationText, t } from '../i18n';
import { Button } from '../ui/controls';
import { Icon } from '../ui/icons';
import { runCliExport } from './cli-export';
import type { ExportProgress } from './exporter';

const UI_INTERVAL_MS = 250;
const RESULT_SHOWN_MS = 8000;

interface Shown { name: string; progress: ExportProgress; final: CliExportReport | null }

export function CliExportStatus({ editingProjectId }: { editingProjectId: RefObject<string | null> }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const take = async () => {
      const job = await api.takeCliExportJob();
      if (!job) return;
      const editing = editingProjectId.current;
      if (editing && editing !== job.opened.id) {
        await api.reportCliExport({
          requestId: job.requestId, state: 'refused', progress: 0, phase: null, outFile: null, bytes: null, reason: 'editing-other-project',
          error: 'Momotombo has another project open in the editor; go back to the project list in the app and try again.',
        });
        return;
      }
      clearTimeout(hideTimer);
      const controller = new AbortController();
      abort.current = controller;
      const name = String((job.opened.json as { name?: unknown }).name ?? '');
      setShown({ name, progress: { phase: 'preparing', frame: 0, total: 0, rate: 0, etaSeconds: 0 }, final: null });
      let lastUi = 0;
      const onProgress = (p: ExportProgress) => {
        const now = performance.now();
        if (now - lastUi < UI_INTERVAL_MS && p.phase === 'video') return;
        lastUi = now;
        setShown((s) => s && { ...s, progress: p });
      };
      let final: CliExportReport;
      try {
        final = await runCliExport(job, onProgress, controller.signal);
      } catch (e) {
        final = { requestId: job.requestId, state: 'failed', progress: 0, phase: null, outFile: null, bytes: null, reason: null, error: (e as Error).message };
      }
      abort.current = null;
      await api.reportCliExport(final).catch(() => undefined);
      setShown((s) => s && { ...s, final });
      hideTimer = setTimeout(() => setShown(null), RESULT_SHOWN_MS);
    };
    void take();
    const off = api.onCliExportRequest(() => void take());
    return () => { off(); clearTimeout(hideTimer); abort.current?.abort(); };
  }, [editingProjectId]);

  if (!shown) return null;
  const { progress, final } = shown;
  const pct = progress.total > 0 ? progress.frame / progress.total : 0;
  return (
    <div className="cli-export" role="status">
      <div className="cli-export-head">
        <Icon name="export" size={15} />
        <strong>{t("Exportación pedida por momotombo-edit")}</strong>
        <span className="muted small">{shown.name}</span>
      </div>
      {final ? (
        final.state === 'done'
          ? <span className="export-done small"><Icon name="check" size={15} />{t("Listo")}{final.bytes ? ` · ${(final.bytes / 1024 / 1024).toFixed(1)} MB` : ''}</span>
          : <span className="note is-error small"><Icon name="warning" size={14} />{final.error}</span>
      ) : (
        <>
          <div className="bar"><span style={{ width: `${pct * 100}%` }} /></div>
          <div className="cli-export-foot">
            <span className="muted small mono">
              {progress.phase === 'audio' ? t("Preparando el audio…") : progress.phase === 'finishing' ? t("Terminando el archivo…") : t("{frame}/{total} fotogramas · {rate} fps · faltan {eta}", { frame: progress.frame, total: progress.total, rate: progress.rate.toFixed(1), eta: durationText(progress.etaSeconds) })}
            </span>
            <Button size="sm" variant="secondary" onClick={() => abort.current?.abort()}>{t("Cancelar")}</Button>
          </div>
        </>
      )}
    </div>
  );
}

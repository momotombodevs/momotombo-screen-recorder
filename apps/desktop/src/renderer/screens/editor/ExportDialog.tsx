import { useEffect, useRef, useState } from 'react';
import { itemTimelineRanges, layoutSegments, type ID } from '@momotombo/project-model';
import { formatTimecode, frameDuration } from '@momotombo/timing';
import { api } from '../../api';
import type { ExportTarget } from '@momotombo/protocol';
import {
  checkExportSupport, exportBaseName, ExportMedia, outputSize, renderStill, runExport, type ExportFormat, type ExportProgress, type ExportSupport,
} from '../../export/exporter';
import { defaultExportChoices, exportOptions, writtenFormat } from '../../export/options';
import type { Player } from '../../playback/player';
import { useEditor, type EditorStore } from '../../state/editor-store';
import { Button, IconButton, Segmented, Toggle } from '../../ui/controls';
import { Icon } from '../../ui/icons';
import { durationText, t } from '../../i18n';
import { privacyConfirmed, privacySignature } from './editor-guards';
import { PROFILE } from '../../../shared/distribution';

interface Check { id: ID; label: string; frames: { label: string; src: string | null }[] }

export function ExportDialog({ store, onClose }: { store: EditorStore; player: Player; onClose: () => void }) {
  const project = useEditor(store, (s) => s.project);
  const cursors = useEditor(store, (s) => s.cursors);
  const mediaBase = useEditor(store, (s) => s.mediaBase);
  const [defaults] = useState(() => defaultExportChoices(project));
  const [variantId, setVariantId] = useState(defaults.variantId);
  const [format, setFormat] = useState<ExportFormat>(defaults.format);
  const [resolution, setResolution] = useState(defaults.resolution);
  const [fps, setFps] = useState(defaults.fps);
  const [quality, setQuality] = useState(defaults.quality);
  const [audio, setAudio] = useState(defaults.includeAudio);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const confirmed = privacyConfirmed(project, confirmedFor);
  const abort = useRef<AbortController | null>(null);
  const size = outputSize(project, { variantId, resolution });
  const busy = progress && ['preparing', 'audio', 'video', 'finishing'].includes(progress.phase);
  // Where the file goes: main's default folder (last chosen, else Movies) until the user picks a
  // place with the system save dialog. A target is used once; a new one is fetched after each export.
  const [target, setTarget] = useState<ExportTarget | null>(null);
  const [customName, setCustomName] = useState<string | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [targetRound, setTargetRound] = useState(0);
  const [support, setSupport] = useState<ExportSupport | null>(null);
  const baseName = customName ?? exportBaseName(project, variantId);
  // WebM stands in for MP4 when this computer has no H.264 encoder at all (route.ts); the target
  // then carries .webm, so the name shown is the file written.
  const written = writtenFormat({ format }, support);

  useEffect(() => {
    if (busy) return;
    let live = true;
    api.exportDefaultTarget(project.id, baseName, written)
      .then((tg) => { if (live) { setTarget(tg); setTargetError(null); } })
      .catch((e: Error) => { if (live) setTargetError(e.message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetched only when the name, format or round changes
  }, [project.id, baseName, written, targetRound]);

  // Can this device write the chosen format at all? Asked before the export, never discovered halfway.
  useEffect(() => {
    let live = true;
    setSupport(null);
    void checkExportSupport(project, { variantId, format, resolution, fps, quality, includeAudio: audio }).then((r) => { if (live) setSupport(r); });
    return () => { live = false; };
  }, [project, variantId, format, resolution, fps, quality, audio]);

  const chooseTarget = async () => {
    try {
      const tg = await api.exportChooseTarget(project.id, baseName, written);
      if (!tg) return;
      setTarget(tg);
      setTargetError(null);
      setCustomName(tg.name.replace(/\.[^.]+$/, ''));
    } catch (e) {
      setTargetError((e as Error).message);
    }
  };

  // Privacy check strip: frames around every hidden region's boundaries.
  useEffect(() => {
    let cancelled = false;
    const media = new ExportMedia(mediaBase);
    void (async () => {
      const placements = layoutSegments(project);
      const fd = frameDuration(project.sequence.fps);
      const out: Check[] = [];
      for (const [i, item] of project.privacy.entries()) {
        for (const r of itemTimelineRanges(project, item, placements)) {
          const frames = [
            { label: t("Antes"), t: Math.max(0, r.start - fd) },
            { label: t("Primer fotograma"), t: r.start },
            { label: t("Último fotograma"), t: Math.max(r.start, r.end - fd) },
            { label: t("Después"), t: r.end },
          ];
          const check: Check = { id: `${item.id}-${r.start}`, label: t("Área {n} · {from}–{to}", { n: i + 1, from: formatTimecode(r.start), to: formatTimecode(r.end) }), frames: frames.map((f) => ({ label: f.label, src: null })) };
          out.push(check);
          for (const [k, f] of frames.entries()) {
            if (cancelled) return;
            try {
              check.frames[k]!.src = await renderStill(project, cursors, mediaBase, f.t, variantId, { width: 240, height: Math.round(240 * size.height / size.width) }, media);
            } catch { /* leave empty */ }
            if (!cancelled) setChecks([...out]);
          }
        }
      }
      if (!cancelled) setChecks([...out]);
    })();
    return () => { cancelled = true; media.dispose(); };
  }, [project, cursors, mediaBase, variantId, size.width, size.height]);

  const start = async () => {
    if (!target) return;
    abort.current = new AbortController();
    const opts = exportOptions({ variantId, format, resolution, fps, quality, includeAudio: audio }, target, support);
    setProgress({ phase: 'preparing', frame: 0, total: 0, rate: 0, etaSeconds: 0 });
    try {
      await runExport(project, cursors, mediaBase, opts, setProgress, abort.current.signal);
    } catch (e) {
      setProgress({ phase: 'error', frame: 0, total: 0, rate: 0, etaSeconds: 0, message: (e as Error).message });
    } finally {
      // The token was spent; the next export gets a fresh, unused name in the same folder.
      setTarget(null);
      setTargetRound((n) => n + 1);
    }
  };
  const canStart = confirmed && !!target && support?.ok === true && target.name.toLowerCase().endsWith(`.${written}`);

  // Leaving the editor stops a running export; its partial file is deleted.
  useEffect(() => () => abort.current?.abort(), []);

  const pct = progress && progress.total > 0 ? progress.frame / progress.total : 0;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal export-modal" role="dialog" aria-label={t("Exportar")}>
        <header>
          <div><h2>{t("Exportar")}</h2><p className="muted">{t("Todos los efectos de zoom, cámara, tema y privacidad se aplican tal como en la vista previa.")}</p></div>
          <IconButton icon="close" label={t("Cerrar")} onClick={onClose} disabled={!!busy} />
        </header>
        <div className="export-grid">
          <div className="export-options">
            <label className="field-label">{t("Formato")}</label>
            <Segmented<string> value={variantId} onChange={setVariantId} options={project.variants.map((v) => ({ value: v.id, label: v.name }))} label={t("Formato")} />
            <label className="field-label">{t("Tipo de archivo")}</label>
            <Segmented<ExportFormat> value={format} onChange={setFormat} label={t("Tipo de archivo")}
              options={PROFILE.formats.map((f) => ({
                value: f,
                label: f === 'mp4' ? t("MP4 · H.264") : PROFILE.id === 'webm-vp8' ? t("WebM · VP8") : t("WebM · VP9"),
              }))} />
            <p className="note small"><Icon name="info" size={14} />{format === 'webm'
              ? PROFILE.id === 'webm-vp8'
                ? t("Experimental: VP8 + Opus sin regalías. Compatible con YouTube y los navegadores; con la misma calidad de imagen, el archivo pesa más que con VP9.")
                : t("Códecs sin regalías (VP9 + Opus). Compatibles con YouTube y los navegadores.")
              : t("La mayor compatibilidad: lo abren QuickTime, Windows y los teléfonos. H.264 y AAC se escriben con los codificadores del propio sistema operativo; estos códecs tienen patentes, consulta los detalles en Licencias.")}</p>
            <label className="field-label">{t("Resolución")}</label>
            <Segmented<'1080' | '2160'> value={resolution} onChange={setResolution} label={t("Resolución")} options={[{ value: '1080', label: t("1080p") }, { value: '2160', label: t("4K") }]} />
            <label className="field-label">{t("Fotogramas por segundo")}</label>
            <Segmented<'30' | '60'> value={String(fps) as '30' | '60'} onChange={(v) => setFps(Number(v) as 30 | 60)} label={t("Fotogramas por segundo")} options={[{ value: '30', label: t("30 fps") }, { value: '60', label: t("60 fps") }]} />
            <label className="field-label">{t("Calidad")}</label>
            <Segmented<'standard' | 'high'> value={quality} onChange={setQuality} label={t("Calidad")} options={[{ value: 'standard', label: t("Estándar") }, { value: 'high', label: t("Alta") }]} />
            <Toggle label={t("Incluir audio")} checked={audio} onChange={setAudio} />
            <p className="muted small mono">{size.width}×{size.height} · {fps} fps</p>
            {support?.ok && support.notice && (
              <p className="note is-warning export-fallback">
                <Icon name="warning" size={14} />
                <span>{support.notice} {target ? t("Archivo que se guardará: {name}", { name: target.name }) : ''}</span>
              </p>
            )}
            {support?.ok && <p className="muted small export-encoder">{t("Codificador: {encoder}", { encoder: support.encoder })}</p>}
            {support && !support.ok && (
              <div className="note is-error export-unsupported">
                <Icon name="warning" size={14} />
                <div>
                  <span>{support.message}</span>
                  {support.suggestWebm && <Button size="sm" onClick={() => setFormat('webm')} disabled={!!busy}>{t("Cambiar a WebM")}</Button>}
                </div>
              </div>
            )}
            <label className="field-label">{t("Guardar en")}</label>
            <div className="export-target">
              <Icon name="folder" size={16} />
              <div className="export-target-text" title={target ? `${target.folder}/${target.name}` : undefined}>
                <strong>{target?.name ?? '…'}</strong>
                <span className="muted small" dir="rtl"><bdi dir="ltr">{target?.folder ?? ''}</bdi></span>
              </div>
              <Button size="sm" onClick={chooseTarget} disabled={!!busy}>{t("Cambiar…")}</Button>
            </div>
            {targetError && <p className="note is-error small"><Icon name="warning" size={14} />{targetError}</p>}
          </div>
          <div className="export-side">
            {project.privacy.length > 0 ? (
              <>
                <h3><Icon name="shield" size={16} /> {t("Revisión de privacidad")}</h3>
                <p className="muted small">{t("Revisa los fotogramas límite de cada área de privacidad. \"Primer fotograma\" y \"Último fotograma\" deben verse ocultos.")}</p>
                <div className="privacy-checks">
                  {checks.map((c) => (
                    <div key={c.id} className="privacy-check">
                      <span className="small">{c.label}</span>
                      <div className="check-frames">
                        {c.frames.map((f) => (
                          <figure key={f.label} className={f.label === t("Primer fotograma") || f.label === t("Último fotograma") ? 'is-inside' : ''}>
                            {f.src ? <img src={f.src} alt={f.label} /> : <span className="thumb-wait" />}
                            <figcaption>{f.label}</figcaption>
                          </figure>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <Toggle label={t("Ya revisé las áreas de privacidad")} checked={confirmed} onChange={(v) => setConfirmedFor(v ? privacySignature(project) : null)} />
              </>
            ) : (
              <p className="note"><Icon name="shield" size={14} />{t("Este proyecto no tiene áreas de privacidad.")}</p>
            )}
            <p className="note small is-warning"><Icon name="warning" size={14} />{t("Las grabaciones originales sin editar quedan en la carpeta del proyecto y pueden contener información sensible. Comparte solo el archivo exportado.")}</p>
          </div>
        </div>
        <footer>
          {progress ? (
            <div className="export-progress">
              {progress.phase === 'done' ? (
                <div className="export-done">
                  <Icon name="check" size={18} />
                  <span title={progress.path}>{t("Listo")}{progress.bytes ? ` · ${(progress.bytes / 1024 / 1024).toFixed(1)} MB` : ''}</span>
                  {progress.path && <Button size="sm" icon="folder" onClick={() => api.showItem(progress.path!)}>{t("Mostrar en la carpeta")}</Button>}
                  {progress.fallback && <span className="export-fallback-done small">{t("Se guardó como WebM en lugar de MP4.")}</span>}
                </div>
              ) : progress.phase === 'error' ? (
                <p className="note is-error"><Icon name="warning" size={14} />{progress.message}</p>
              ) : progress.phase === 'cancelled' ? (
                <span className="muted">{t("Cancelado; se eliminó el archivo incompleto.")}</span>
              ) : (
                <>
                  {progress.fallback && <span className="note is-warning small"><Icon name="warning" size={14} />{progress.fallback}</span>}
                  <div className="bar"><span style={{ width: `${pct * 100}%` }} /></div>
                  <span className="muted small mono">
                    {progress.phase === 'audio' ? t("Preparando el audio…") : progress.phase === 'finishing' ? t("Terminando el archivo…") : t("{frame}/{total} fotogramas · {rate} fps · faltan {eta}", { frame: progress.frame, total: progress.total, rate: progress.rate.toFixed(1), eta: durationText(progress.etaSeconds) })}
                    {progress.encoder ? ` · ${progress.encoder}` : ''}
                  </span>
                </>
              )}
            </div>
          ) : <span />}
          <div className="footer-actions">
            {busy
              ? <Button variant="secondary" onClick={() => abort.current?.abort()}>{t("Cancelar")}</Button>
              : <Button variant="primary" icon="export" onClick={start} disabled={!canStart}>{t("Exportar")}</Button>}
          </div>
        </footer>
      </div>
    </div>
  );
}

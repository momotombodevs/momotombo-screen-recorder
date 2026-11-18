import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_CAMERA_MOVE, activeVariant, laneRange, layoutSegments, parseProject, removeCameraLayout, removeMagnifier, removePrivacy, removeSegment,
  removeText, removeZoom, renameProject, resolveOverlaps, sequenceDuration, setActiveVariant, splitAt, timelineToSource,
} from '@momotombo/project-model';
import type { OpenedProject } from '@momotombo/protocol';
import { formatTimecode, frameDuration, secondsToTicks } from '@momotombo/timing';
import { api } from '../../api';
import { renderStill } from '../../export/exporter';
import { Player } from '../../playback/player';
import { EditorStore, useEditor, type Tool } from '../../state/editor-store';
import { Button, EditableText, IconButton, Kbd, Segmented } from '../../ui/controls';
import { Icon } from '../../ui/icons';
import { keyLabel, RECORDING_KEYS, redoLabel } from '../../ui/keys';
import { Settings } from '../Settings';
import { shortcutsBlocked } from './editor-guards';
import { ExportDialog } from './ExportDialog';
import { Inspector } from './Inspector';
import { addMagnifierAt, addTextAt, place, placeRange } from './placement';
import { Preview } from './Preview';
import { Timeline } from './Timeline';
import { noSuggestionMessage, runZoomSuggestions } from './zoom-actions';
import { t } from '../../i18n';
import { probe } from '../../perf-probe';

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function Editor({ opened, onBack, notice: initialNotice, onNoticeShown }: {
  opened: OpenedProject; onBack: () => void;
  /** Shown once when the editor opens (for example a recording recovered after a crash). */
  notice?: string; onNoticeShown?: () => void;
}) {
  probe.count('react:Editor');
  const store = useMemo(() => new EditorStore(opened), [opened]);
  const player = useMemo(() => new Player(store), [store]);
  const project = useEditor(store, (s) => s.project);
  // Redrawn when the playhead comes to rest, not on every frame of playback (see Timecode below).
  const playhead = useEditor(store, (s) => s.settledPlayhead);
  const playing = useEditor(store, (s) => s.playing);
  const tool = useEditor(store, (s) => s.tool);
  const selection = useEditor(store, (s) => s.selection);
  const save = useEditor(store, (s) => s.save);
  const canUndo = useEditor(store, (s) => s.canUndo);
  const canRedo = useEditor(store, (s) => s.canRedo);
  const exportOpen = useEditor(store, (s) => s.exportOpen);
  const leaveBlocked = useEditor(store, (s) => s.leaveBlocked);
  const saveError = useEditor(store, (s) => s.saveError);
  const notice = useEditor(store, (s) => s.notice);
  const [help, setHelp] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef(false);
  settingsRef.current = settingsOpen;
  const duration = sequenceDuration(project);
  if (document.documentElement.dataset.smoke === '1') (window as unknown as { __momotomboEditor?: unknown }).__momotomboEditor = { store, player };

  // React's development check unmounts and mounts every effect once more with the same
  // store and player; the player is closed only if it is not mounted again right away.
  const closing = useRef<{ player: Player; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => {
    if (closing.current?.player === player) { clearTimeout(closing.current.timer); closing.current = null; }
    void (async () => {
      // Older projects may contain stacked items; repair them once (undoable).
      if (resolveOverlaps(store.project) !== store.project) {
        store.apply(resolveOverlaps);
        store.notify(t("Se corrigieron elementos superpuestos. Pulsa {key} para deshacer.", { key: keyLabel('mod+Z') }));
      }
      await store.loadCursors();
      // First open of a fresh recording: generate zoom suggestions once.
      const p = store.project;
      if (!p.zoomEngine.engineVersion && p.zooms.length === 0 && Object.keys(p.recordings).length > 0) {
        const run = await runZoomSuggestions(store);
        // Said once on the first open; a notice already on screen (e.g. a recovered recording) stays.
        if (run.reason && !store.getState().notice) store.notify(noSuggestionMessage(run.reason), 12_000);
        // The browser delivered the screen squeezed; it is shown with the display's real shape.
        if (Object.values(p.recordings).some((r) => r.sources.screen?.displayAspect) && !store.getState().notice) {
          store.notify(t("La imagen de la pantalla llegó achatada en esta grabación; se muestra con la proporción real de la pantalla. Puede tener un poco menos de detalle en una dirección."), 12_000);
        }
      }
      await saveThumbnail(store);
    })();
    return () => {
      void store.flush();
      closing.current = { player, timer: setTimeout(() => player.dispose(), 0) };
    };
  }, [store, player]);

  useEffect(() => {
    if (!initialNotice) return;
    store.notify(initialNotice, 12_000);
    onNoticeShown?.();
  }, [store]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => api.onProjectChanged(({ id, json }) => {
    if (id !== store.project.id) return;
    store.apply(() => parseProject(json));
    store.notify(t("El proyecto cambió fuera del editor. Pulsa {key} para deshacer.", { key: keyLabel('mod+Z') }));
  }), [store]);

  const leave = async () => { if (await store.requestLeave()) onBack(); };
  // Playback would overwrite the new position on its next frame.
  const seek = (t: number) => {
    if (store.getState().playing) player.pause();
    store.setPlayhead(t);
  };
  const seekRef = useRef(seek);
  seekRef.current = seek;

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (settingsRef.current) {
        if (e.key === 'Escape') setSettingsOpen(false);
        return;
      }
      const s = store.getState();
      if (shortcutsBlocked(s)) return;
      if (mod && e.key === ',') { e.preventDefault(); setSettingsOpen(true); return; }
      const fd = frameDuration(s.project.sequence.fps);
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo(); else store.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); return; }
      if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); store.setExportOpen(true); return; }
      if (mod) return;
      switch (e.key) {
        case ' ': e.preventDefault(); player.toggle(); break;
        case 'ArrowLeft': e.preventDefault(); seekRef.current(s.playhead - (e.shiftKey ? secondsToTicks(1) : fd)); break;
        case 'ArrowRight': e.preventDefault(); seekRef.current(s.playhead + (e.shiftKey ? secondsToTicks(1) : fd)); break;
        case 'Home': seekRef.current(0); break;
        case 'End': seekRef.current(sequenceDuration(s.project)); break;
        case 's': case 'S': store.apply((p) => splitAt(p, s.playhead)); break;
        case 'c': case 'C': store.setTool(s.tool === 'cut' ? 'select' : 'cut'); break;
        case 'k': case 'K': store.setTool(s.tool === 'camera' ? 'select' : 'camera'); break;
        case 'z': case 'Z': store.setTool(s.tool === 'zoom' ? 'select' : 'zoom'); break;
        case 'b': case 'B': store.setTool(s.tool === 'privacy' ? 'select' : 'privacy'); break;
        case 'm': case 'M': store.setTool(s.tool === 'magnifier' ? 'select' : 'magnifier'); break;
        case 't': case 'T': store.setTool(s.tool === 'text' ? 'select' : 'text'); break;
        case 'v': case 'V': case 'Escape': store.setTool('select'); if (e.key === 'Escape') store.select(null); break;
        case '?': setHelp((h) => !h); break;
        case 'Delete': case 'Backspace': {
          const sel = s.selection;
          if (!sel) break;
          e.preventDefault();
          if (sel.kind === 'zoom') store.apply((p) => removeZoom(p, sel.id));
          if (sel.kind === 'privacy') store.apply((p) => removePrivacy(p, sel.id));
          if (sel.kind === 'camera') store.apply((p) => removeCameraLayout(p, sel.id));
          if (sel.kind === 'magnifier') store.apply((p) => removeMagnifier(p, sel.id));
          if (sel.kind === 'text') store.apply((p) => removeText(p, sel.id));
          if (sel.kind === 'segment' && s.project.sequence.segments.length > 1) store.apply((p) => removeSegment(p, sel.id));
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, player]);

  const addPrivacyHere = () => {
    const pos = timelineToSource(project, store.getState().playhead, layoutSegments(project));
    if (!pos) return;
    place(store, 'privacy', {
      recordingId: pos.recordingId, start: pos.sourceTime, end: Math.min(pos.placement.segment.sourceEnd, pos.sourceTime + secondsToTicks(3)),
      origin: 'manual', region: { x: 0.4, y: 0.42, w: 0.2, h: 0.08 }, keyframes: [], effect: { kind: 'frosted' }, cornerRadius: 0.12, padFrames: 2,
    });
  };
  const hasCamera = Object.values(project.recordings).some((r) => r.sources.camera);

  // Camera move being edited (selected, else under the playhead) — drives the tool hint.
  const editMove = (() => {
    const sel = selection?.kind === 'camera' ? project.cameraLayouts.find((c) => c.id === selection.id) : undefined;
    if (sel) return sel;
    const pos = timelineToSource(project, playhead, layoutSegments(project));
    return pos ? project.cameraLayouts.find((c) => c.recordingId === pos.recordingId && c.start <= pos.sourceTime && pos.sourceTime < c.end) : undefined;
  })();

  // With the camera tool on, moving the playhead out of the selected move ends its editing,
  // so the next press on the preview adds a new move at the new place.
  const lastPlayhead = useRef(playhead);
  useEffect(() => {
    if (lastPlayhead.current === playhead) return;
    lastPlayhead.current = playhead;
    const s = store.getState();
    if (s.tool !== 'camera' || s.selection?.kind !== 'camera') return;
    const item = s.project.cameraLayouts.find((c) => c.id === s.selection!.id);
    const pos = timelineToSource(s.project, playhead, layoutSegments(s.project));
    if (item && !(pos && pos.recordingId === item.recordingId && pos.sourceTime >= item.start && pos.sourceTime < item.end)) store.select(null);
  }, [playhead, store]);
  /** Adds a camera move at the playhead (3 s, shortened to fit) and turns on the camera tool. */
  const addCameraHere = () => {
    const at = store.getState().playhead;
    const r = laneRange(project, 'cameraLayouts', at, at + DEFAULT_CAMERA_MOVE);
    if (!r) {
      const covering = timelineToSource(project, at, layoutSegments(project));
      const hit = covering && project.cameraLayouts.find((c) => c.recordingId === covering.recordingId && c.start <= covering.sourceTime && covering.sourceTime < c.end);
      if (hit) store.select({ kind: 'camera', id: hit.id });
      store.notify(hit ? t("Ya hay un movimiento de cámara aquí. Los elementos no se pueden superponer; seleccioné el existente.") : t("Aquí no hay espacio para un nuevo movimiento de cámara."));
      store.setTool('camera');
      return;
    }
    if (placeRange(store, 'cameraLayouts', r)) store.setTool('camera');
  };
  const addZoomHere = () => {
    const pos = timelineToSource(project, store.getState().playhead, layoutSegments(project));
    if (!pos) return;
    const d = project.style.zoomDefaults;
    place(store, 'zooms', {
      recordingId: pos.recordingId, start: pos.sourceTime, end: Math.min(pos.placement.segment.sourceEnd, pos.sourceTime + secondsToTicks(3)),
      origin: 'manual', mode: 'region', center: { x: 0.5, y: 0.5 }, scale: d.scale, enter: d.enter, exit: d.exit,
    });
  };

  const variant = activeVariant(project);
  const saveLabel = save === 'saved' ? t("Guardado") : save === 'error' ? t("No se pudo guardar") : t("Guardando…");

  return (
    <div className="editor">
      <header className="topbar drag">
        <div className="topbar-left no-drag">
          <IconButton icon="back" label={t("Volver a proyectos")} onClick={leave} />
          <EditableText value={project.name} className="project-title" onCommit={(name) => store.apply((p) => renameProject(p, name))} />
          <span className={`save-state is-${save}`}><span className="save-dot" />{saveLabel}</span>
        </div>
        <div className="topbar-center no-drag">
          <Segmented<string> label={t("Formato de video")} value={project.activeVariantId}
            options={project.variants.map((v) => ({ value: v.id, label: v.name }))}
            onChange={(id) => store.apply((p) => setActiveVariant(p, id))} />
        </div>
        <div className="topbar-right no-drag">
          <IconButton icon="undo" label={t("Deshacer ({key})", { key: keyLabel('mod+Z') })} onClick={() => store.undo()} disabled={!canUndo} />
          <IconButton icon="redo" label={t("Rehacer ({key})", { key: redoLabel() })} onClick={() => store.redo()} disabled={!canRedo} />
          <IconButton icon="info" label={t("Atajos (?)")} onClick={() => setHelp(!help)} active={help} />
          <IconButton icon="sliders" label={t("Ajustes ({key})", { key: keyLabel('mod+,') })} onClick={() => setSettingsOpen(true)} active={settingsOpen} />
          <Button variant="primary" icon="export" onClick={() => store.setExportOpen(true)} disabled={duration === 0}>{t("Exportar")}</Button>
        </div>
      </header>
      <div className="editor-main">
        <div className="stage">
          <Preview store={store} player={player} />
          <div className="stage-toolbar">
            <Segmented<Tool> size="sm" label={t("Herramienta")} value={tool} onChange={(t) => store.setTool(t)}
              options={[
                { value: 'select', label: t("Seleccionar"), icon: 'cursor' },
                { value: 'zoom', label: t("Zoom"), icon: 'zoom' },
                { value: 'magnifier', label: t("Lupa"), icon: 'magnifier' },
                { value: 'text', label: t("Texto"), icon: 'text' },
                { value: 'camera', label: t("Cámara dinámica"), icon: 'camera' },
                { value: 'privacy', label: t("Ocultar"), icon: 'privacy' },
                { value: 'cut', label: t("Cortar"), icon: 'scissors' },
              ]} />
            {tool === 'privacy' && <span className="tool-hint">{t("Dibuja en la vista previa el área que quieres ocultar, o pulsa cualquier momento en la línea de tiempo: ahí se añade un área de privacidad de 3 s.")}</span>}
            {tool === 'zoom' && <span className="tool-hint">{t("Pulsa cualquier momento en la línea de tiempo o, en la vista previa, el punto que quieres ampliar: se añade un zoom de 3 s. Arrastra para dibujar uno más largo.")}</span>}
            {tool === 'camera' && <span className="tool-hint">{!editMove
              ? t("Pulsa un momento en la línea de tiempo, o arrastra la cámara en la vista previa adonde debe ir: se añade un movimiento de cámara.")
              : !editMove.second
                ? t("Elige la posición 2: haz clic en la vista previa donde debe ir la cámara.")
                : t("Arrastra los marcos 1 y 2 para cambiar las posiciones. La línea en la línea de tiempo es el momento en que la cámara pasa a la posición 2.")}</span>}
            {tool === 'magnifier' && <span className="tool-hint">{t("Pulsa un momento en la línea de tiempo o en la vista previa: se añade un intervalo de lupa de 3 s. Arrastra para dibujar uno más largo.")}</span>}
            {tool === 'text' && <span className="tool-hint">{t("Pulsa en la vista previa donde quieres el texto, o un momento en la línea de tiempo: se añade un texto de 3 s. Arrastra el texto en la vista previa para moverlo.")}</span>}
            {tool === 'cut' && <span className="tool-hint">{t("Haz clic donde quieras cortar en la línea de tiempo · Seleccionar o Esc para terminar")}</span>}
          </div>
          {help && <ShortcutHelp onClose={() => setHelp(false)} />}
          {notice && <div className="toast" role="status"><Icon name="info" size={15} />{notice}</div>}
        </div>
        <Inspector store={store} player={player} />
      </div>
      <div className="transport">
        <div className="transport-left">
          <IconButton icon="scissors" label={tool === 'cut' ? t("Desactivar el modo de corte (C)") : t("Modo de corte: corta con el mouse (C)")} active={tool === 'cut'} onClick={() => store.setTool(tool === 'cut' ? 'select' : 'cut')} />
          <IconButton icon="zoom" label={t("Añadir zoom aquí")} onClick={addZoomHere} />
          <IconButton icon="magnifier" label={t("Añadir una lupa aquí")} onClick={() => addMagnifierAt(store, store.getState().playhead)} />
          <IconButton icon="text" label={t("Añadir texto aquí")} onClick={() => addTextAt(store, store.getState().playhead)} />
          {hasCamera && <IconButton icon="camera" label={t("Añadir cámara dinámica aquí")} onClick={addCameraHere} />}
          <IconButton icon="privacy" label={t("Añadir área de privacidad aquí")} onClick={addPrivacyHere} />
        </div>
        <div className="transport-center">
          <IconButton icon="back" label={t("Un fotograma atrás (←)")} onClick={() => seek(store.getState().playhead - frameDuration(project.sequence.fps))} />
          <button type="button" className="play-btn" onClick={() => player.toggle()} aria-label={playing ? t("Pausar") : t("Reproducir")} title={t("Reproducir / pausar (espacio)")}>
            <Icon name={playing ? 'pause' : 'play'} size={18} />
          </button>
          <IconButton icon="chevronRight" label={t("Un fotograma adelante (→)")} onClick={() => seek(store.getState().playhead + frameDuration(project.sequence.fps))} />
          <Timecode store={store} />
        </div>
        <div className="transport-right">
          <span className="muted small">{variant.width}×{variant.height} · {project.sequence.fps.num / project.sequence.fps.den} fps</span>
          <IconButton icon="zoom" label={t("Ampliar la línea de tiempo ({key} + desplazar)", { key: keyLabel('mod') })} onClick={() => store.setPxPerSecond(store.getState().pxPerSecond * 1.4)} />
        </div>
      </div>
      <Timeline store={store} player={player} />
      {exportOpen && <ExportDialog store={store} player={player} onClose={() => store.setExportOpen(false)} />}
      {leaveBlocked && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal leave-modal" role="alertdialog" aria-label={t("No se pudieron guardar los cambios")}>
            <header>
              <div>
                <h2>{t("No se pudieron guardar los cambios")}</h2>
                <p className="muted">{t("No se pudieron guardar tus últimos cambios: {error}. Si sales ahora, se perderán.", { error: saveError ?? '' })}</p>
              </div>
            </header>
            <footer>
              <span />
              <div className="footer-actions">
                <Button variant="danger" onClick={onBack}>{t("Salir sin guardar")}</Button>
                <Button variant="secondary" onClick={() => store.dismissLeave()}>{t("Seguir en el editor")}</Button>
                <Button variant="primary" onClick={leave}>{t("Reintentar")}</Button>
              </div>
            </footer>
          </div>
        </div>
      )}
      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setSettingsOpen(false); }}>
          <div className="modal settings-modal" role="dialog" aria-label={t("Ajustes")}>
            <header>
              <div><h2>{t("Ajustes")}</h2><p className="muted">{t("Idioma, permisos y métodos de grabación")}</p></div>
              <IconButton icon="close" label={t("Cerrar")} onClick={() => setSettingsOpen(false)} />
            </header>
            <Settings embedded />
          </div>
        </div>
      )}
    </div>
  );
}

/** Playhead time / total length. Follows playback on its own, so the editor around it is not redrawn each frame. */
function Timecode({ store }: { store: EditorStore }) {
  const playhead = useEditor(store, (s) => s.playhead);
  const project = useEditor(store, (s) => s.project);
  return <span className="timecode mono">{formatTimecode(playhead, project.sequence.fps)} <span className="muted">/ {formatTimecode(sequenceDuration(project))}</span></span>;
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    [t("Espacio"), t("Reproducir / pausar")], ['← →', t("Avanzar fotograma a fotograma (1 s con {key})", { key: keyLabel('shift') })], ['K', t("Cámara dinámica (mueve la cámara durante un intervalo)")], ['C', t("Modo de corte (haz clic con el mouse para cortar)")], ['S', t("Dividir en el cabezal de reproducción")],
    ['Z', t("Herramienta de zoom")], ['M', t("Herramienta de lupa")], ['T', t("Herramienta de texto")], ['B', t("Herramienta de privacidad")], [t("V / Esc"), t("Herramienta de selección")], [t("Eliminar"), t("Eliminar el elemento seleccionado")],
    [`${keyLabel('mod+Z')} / ${redoLabel()}`, t("Deshacer / rehacer")], [keyLabel('mod+E'), t("Exportar")], [t("{key} + desplazar", { key: keyLabel('mod') }), t("Escala de la línea de tiempo")],
    [[RECORDING_KEYS.stop, RECORDING_KEYS.pause, RECORDING_KEYS.mark].map(keyLabel).join(' · '), t("Al grabar: finalizar · pausar · marca")],
  ];
  return (
    <div className="popover shortcut-help" role="dialog" aria-label={t("Atajos de teclado")}>
      <header><strong>{t("Atajos de teclado")}</strong><IconButton icon="close" label={t("Cerrar")} onClick={onClose} /></header>
      <dl>{rows.map(([k, v]) => <div key={k}><dt><Kbd>{k}</Kbd></dt><dd>{v}</dd></div>)}</dl>
    </div>
  );
}

/**
 * Renders one frame at ~1 s into a small JPEG for the project list. It reads the recording
 * through its own media elements (renderStill): seeking the preview's elements would leave the
 * preview showing that frame instead of the one under the playhead.
 */
async function saveThumbnail(store: EditorStore): Promise<void> {
  const project = store.project;
  if (sequenceDuration(project) === 0) return;
  const at = Math.min(secondsToTicks(1), sequenceDuration(project) - 1);
  const { cursors, mediaBase } = store.getState();
  try {
    const jpeg = await renderStill(project, cursors, mediaBase, at, 'v_16x9', { width: 480, height: 270 });
    await api.setThumbnail(project.id, jpeg);
  } catch { /* thumbnail is optional */ }
}

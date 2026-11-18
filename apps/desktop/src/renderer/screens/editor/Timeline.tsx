import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import {
  DEFAULT_CAMERA_MOVE, cameraSplitTime, clampDrag, freeWindow, itemTimelineRanges, laneRange, layoutSegments, sequenceDuration, sourceToTimeline, splitAt,
  trimSegment, updateCameraLayout, updateMagnifier, updatePrivacy, updateText, updateZoom, type ID, type ItemBase, type TrackItem, type TrackKey,
} from '@momotombo/project-model';
import { TICKS_PER_SECOND, formatTimecode, secondsToTicks, snapToFrame, type Ticks } from '@momotombo/timing';
import type { Player } from '../../playback/player';
import { Icon, type IconName } from '../../ui/icons';
import { useEditor, type EditorStore, type SelectionKind } from '../../state/editor-store';
import { DEFAULT_PRIVACY_REGION, placeRange } from './placement';
import { placeName } from './camera-names';
import { importVideo } from './import-media';
import { activityBins, niceStep, tickLabel } from './timeline-scale';
import { t } from '../../i18n';
import { probe } from '../../perf-probe';

const LABEL_W = 140;
const DRAG_THRESHOLD = 3; // px before a press becomes a drag

type ItemKind = 'zoom' | 'privacy' | 'camera' | 'magnifier' | 'text';
/** Rows that new items are added to from the timeline. */
type DrawLane = ItemKind;
const LANE_KEY: Record<DrawLane, TrackKey> = { zoom: 'zooms', camera: 'cameraLayouts', privacy: 'privacy', magnifier: 'magnifiers', text: 'texts' };
const TRACK = LANE_KEY;
const isItemKind = (k: string): k is ItemKind => Object.hasOwn(TRACK, k);
/** Fade drawn at both ends of a magnifier range (the lens fades in and out). */
const MAGNIFIER_RAMP = secondsToTicks(0.25);

interface Drag {
  /** 'split': the line inside a camera move that sets when it heads for the 2. konum. */
  kind: ItemKind | 'segment' | 'playhead' | 'split';
  id?: ID;
  mode: 'move' | 'start' | 'end';
  x0: number;
  start0: Ticks;
  end0: Ticks;
  window: { lo: Ticks; hi: Ticks };
  active: boolean;
}

/** Assigns time-overlapping items (texts, and privacy areas in different places) to lanes. */
function lanes<T extends { start: number; end: number }>(items: T[]): number[] {
  const ends: number[] = [];
  return items.map((it) => {
    let lane = ends.findIndex((e) => e <= it.start);
    if (lane < 0) { lane = ends.length; ends.push(it.end); } else ends[lane] = it.end;
    return lane;
  });
}

/** The playhead line. Only this element is redrawn as the playhead moves. */
function PlayheadLine({ store, children }: { store: EditorStore; children: ReactNode }) {
  const playhead = useEditor(store, (s) => s.playhead);
  const pps = useEditor(store, (s) => s.pxPerSecond);
  return <div className="tl-playhead" style={{ left: LABEL_W + (playhead / TICKS_PER_SECOND) * pps }}>{children}</div>;
}

/** Playhead time in the ruler's corner. */
function RulerTime({ store }: { store: EditorStore }) {
  const playhead = useEditor(store, (s) => s.playhead);
  const fps = useEditor(store, (s) => s.project.sequence.fps);
  return <div className="tl-ruler-label">{formatTimecode(playhead, fps)}</div>;
}

export function Timeline({ store, player }: { store: EditorStore; player: Player }) {
  probe.count('react:Timeline');
  const project = useEditor(store, (s) => s.project);
  const selection = useEditor(store, (s) => s.selection);
  const pps = useEditor(store, (s) => s.pxPerSecond);
  const cursors = useEditor(store, (s) => s.cursors);
  const tool = useEditor(store, (s) => s.tool);
  const cutting = tool === 'cut';
  const [cutAt, setCutAt] = useState<Ticks | null>(null);
  const [draft, setDraft] = useState<{ lane: DrawLane; start: Ticks; end: Ticks } | null>(null);
  const [addHover, setAddHover] = useState<Ticks | null>(null);
  const [importing, setImporting] = useState(false);
  const addVideo = async () => {
    if (importing) return;
    setImporting(true);
    try {
      // Show the new clip: scroll the timeline to its end.
      if (await importVideo(store)) requestAnimationFrame(() => { const el = scrollRef.current; if (el) el.scrollLeft = el.scrollWidth; });
    } finally { setImporting(false); }
  };
  const addLane: DrawLane | null = isItemKind(tool) ? tool : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const duration = sequenceDuration(project);
  // layoutSegments reads only the segments. Keyed on them, a zoom drag or a style change keeps the
  // placements, and with them the activity strip, which is costly to rebuild on long recordings.
  const segments = project.sequence.segments;
  const placements = useMemo(() => layoutSegments(project), [segments]); // eslint-disable-line react-hooks/exhaustive-deps
  const width = Math.max(600, (duration / TICKS_PER_SECOND) * pps + 240);
  const x = (t: Ticks) => (t / TICKS_PER_SECOND) * pps;

  useEffect(() => () => cleanupRef.current?.(), []);

  // Keep the playhead in view while playing. Done from the store, not from a redraw: the
  // timeline itself is not redrawn while the playhead moves (PlayheadLine and RulerTime are).
  useEffect(() => store.subscribe(() => {
    const el = scrollRef.current;
    const s = store.getState();
    if (!el || !s.playing) return;
    const px = (s.playhead / TICKS_PER_SECOND) * s.pxPerSecond + LABEL_W;
    if (px > el.scrollLeft + el.clientWidth - 80) el.scrollLeft = px - LABEL_W - 80;
  }), [store]);

  // Fit the whole recording into view when a project opens.
  const fitted = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || fitted.current || duration <= 0) return;
    fitted.current = true;
    store.setPxPerSecond(Math.max(4, (el.clientWidth - LABEL_W - 60) / (duration / TICKS_PER_SECOND)));
  }, [duration, store]);

  const onWheel = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    const px = e.clientX - rect.left + el.scrollLeft - LABEL_W;
    const tUnder = (px / pps) * TICKS_PER_SECOND;
    store.setPxPerSecond(pps * Math.exp(-e.deltaY * 0.0025));
    requestAnimationFrame(() => { el.scrollLeft = (tUnder / TICKS_PER_SECOND) * store.getState().pxPerSecond - (e.clientX - rect.left - LABEL_W); });
  };

  const timelineAt = (clientX: number): Ticks => {
    const el = scrollRef.current!;
    const px = clientX - el.getBoundingClientRect().left + el.scrollLeft - LABEL_W;
    return (px / store.getState().pxPerSecond) * TICKS_PER_SECOND;
  };

  /** Cut position under the pointer: snapped to frames, the playhead and segment edges (6 px). */
  const cutTimeAt = (clientX: number): Ticks | null => {
    const raw = timelineAt(clientX);
    if (raw <= 0 || raw >= duration) return null;
    const snapPx = 6;
    const near = (t: Ticks) => Math.abs(x(t) - x(raw)) <= snapPx;
    if (near(store.getState().playhead)) return store.getState().playhead;
    for (const pl of placements) {
      if (near(pl.timelineStart)) return null; // already a cut here
      if (near(pl.timelineEnd)) return null;
    }
    return snapToFrame(Math.round(raw), project.sequence.fps);
  };

  const onCutMove = (e: RPointerEvent) => {
    if (!cutting) return;
    const target = e.target as HTMLElement;
    if (target.closest('.tl-ruler, .tl-row-label')) { setCutAt(null); return; }
    setCutAt(cutTimeAt(e.clientX));
  };

  /** In cut mode a click anywhere on the tracks cuts there; items are not dragged. */
  const onCutDown = (e: RPointerEvent) => {
    if (!cutting || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.tl-ruler, .tl-row-label, .tl-playhead-knob')) return;
    e.stopPropagation();
    e.preventDefault();
    const at = cutTimeAt(e.clientX);
    if (at === null) return;
    const before = store.project.sequence.segments.length;
    store.apply((p) => splitAt(p, at));
    if (store.project.sequence.segments.length === before) store.notify(t("No se puede cortar aquí (demasiado cerca del límite de una sección)."));
  };

  /** Applies the current drag. Items stay inside their free window, so nothing can overlap. */
  const applyDrag = (d: Drag, clientX: number) => {
    if (d.kind === 'playhead') {
      store.setPlayhead(timelineAt(clientX));
      return;
    }
    const dt = ((clientX - d.x0) / store.getState().pxPerSecond) * TICKS_PER_SECOND;
    const key = `${d.kind}-${d.id}`;
    if (d.kind === 'split') {
      const len = d.end0 - d.start0;
      const split = Math.min(0.9, Math.max(0.1, (d.window.lo + dt - d.start0) / len));
      store.apply((p) => updateCameraLayout(p, d.id!, { split }), { coalesce: key });
      return;
    }
    if (d.kind === 'segment') {
      const edge = d.mode === 'start' ? 'start' : 'end';
      const base = d.mode === 'start' ? d.start0 : d.end0;
      store.apply((p) => trimSegment(p, d.id!, edge, Math.round(base + dt)), { coalesce: key });
      return;
    }
    const patch = clampDrag(d.window, d.start0, d.end0, d.mode, dt);
    if (d.kind === 'zoom') store.apply((p) => updateZoom(p, d.id!, patch), { coalesce: key });
    if (d.kind === 'privacy') store.apply((p) => updatePrivacy(p, d.id!, patch), { coalesce: key });
    if (d.kind === 'camera') store.apply((p) => updateCameraLayout(p, d.id!, patch), { coalesce: key });
    if (d.kind === 'magnifier') store.apply((p) => updateMagnifier(p, d.id!, patch), { coalesce: key });
    if (d.kind === 'text') store.apply((p) => updateText(p, d.id!, patch), { coalesce: key });
  };

  /** Press on an item, an edge, or the playhead. Tracking runs on the window so it never gets stuck. */
  const press = (e: RPointerEvent, d: Omit<Drag, 'x0' | 'window' | 'active'>) => {
    if (e.button !== 0) return;
    // With a tool on, pressing an item of another kind adds the tool's item at that moment.
    const lane = toolLane();
    const itemKind = d.kind === 'split' ? 'camera' : d.kind;
    if (lane && isItemKind(itemKind) && itemKind !== lane) {
      addPress(e, lane, true);
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    cleanupRef.current?.();
    if (d.kind !== 'playhead' && d.id) store.select({ kind: (d.kind === 'split' ? 'camera' : d.kind) as SelectionKind, id: d.id });
    if (d.kind === 'playhead' && store.getState().playing) player.pause();
    let win = { lo: 0, hi: Number.MAX_SAFE_INTEGER };
    if (d.kind === 'split') {
      const item = store.project.cameraLayouts.find((i) => i.id === d.id);
      if (item) win = { lo: cameraSplitTime(item), hi: cameraSplitTime(item) }; // split time at press
    } else if (isItemKind(d.kind)) {
      const item = (store.project[TRACK[d.kind]] as TrackItem[]).find((i) => i.id === d.id);
      if (item) win = freeWindow(store.project, TRACK[d.kind], item);
    }
    const drag: Drag = { ...d, x0: e.clientX, window: win, active: d.kind === 'playhead' };
    dragRef.current = drag;
    if (drag.active) applyDrag(drag, e.clientX);
    const move = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      if (!cur.active) {
        if (Math.abs(ev.clientX - cur.x0) < DRAG_THRESHOLD) return;
        cur.active = true;
      }
      applyDrag(cur, ev.clientX);
    };
    const end = (ev?: Event) => {
      const cur = dragRef.current;
      if (cur?.active) store.endGesture();
      dragRef.current = null;
      cleanupRef.current?.();
      // With a tool on, a click (no drag) on the playhead line adds the tool's item there.
      if (cur && !cur.active && cur.kind === 'playhead' && ev instanceof PointerEvent && ev.type === 'pointerup') {
        const lane = toolLane();
        if (lane) addAt(lane, store.getState().playhead);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
    cleanupRef.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
      cleanupRef.current = null;
    };
  };

  /** Row the active tool adds to: Zoom → zoom row, Lens → magnifier row, Dynamic camera → camera row, Hide → privacy row, Text → text row. */
  const toolLane = (): DrawLane | null => {
    const tl = store.getState().tool;
    return isItemKind(tl) ? tl : null;
  };
  const rangeOn = (lane: DrawLane, from: Ticks, to: Ticks) =>
    laneRange(store.project, LANE_KEY[lane], from, to, lane === 'privacy' ? DEFAULT_PRIVACY_REGION : undefined);
  const noRoom = (lane: DrawLane) => store.notify(lane === 'camera' ? t("Aquí no hay espacio para un nuevo movimiento de cámara.")
    : lane === 'zoom' ? t("Aquí no hay espacio para un nuevo zoom.") : lane === 'magnifier' ? t("Aquí no hay espacio para un nuevo intervalo de lupa.")
      : lane === 'text' ? t("Aquí no hay espacio para un nuevo texto.") : t("Aquí no hay espacio para una nueva área de privacidad."));

  /** Adds a default-length item for `lane` starting at timeline time `from`. */
  const addAt = (lane: DrawLane, from: Ticks) => {
    if (lane === 'camera' && !hasKind('camera')) { store.notify(t("Las grabaciones de este proyecto no tienen video de cámara.")); return; }
    const r = rangeOn(lane, from, from + (lane === 'camera' ? DEFAULT_CAMERA_MOVE : secondsToTicks(3)));
    if (!r) noRoom(lane);
    else placeRange(store, LANE_KEY[lane], r);
  };

  /**
   * A press that adds to `lane`. Dragging draws the range (shown in that lane's row); a plain
   * click adds a default-length item when it came from the active tool, otherwise it only
   * clears the selection. The playhead never moves.
   */
  const addPress = (e: RPointerEvent, lane: DrawLane, viaTool: boolean) => {
    e.stopPropagation();
    e.preventDefault();
    cleanupRef.current?.();
    const x0 = e.clientX;
    const from = timelineAt(e.clientX);
    let active = false;
    const rangeTo = (clientX: number) => rangeOn(lane, from, timelineAt(clientX));
    const move = (ev: PointerEvent) => {
      if (!active && Math.abs(ev.clientX - x0) < DRAG_THRESHOLD) return;
      active = true;
      setAddHover(null);
      const r = rangeTo(ev.clientX);
      const at = r ? sourceToTimeline(store.project, r.recordingId, r.start) : null;
      setDraft(r && at !== null ? { lane, start: at, end: at + (r.end - r.start) } : null);
    };
    const end = (ev: PointerEvent) => {
      cleanupRef.current?.();
      setDraft(null);
      if (!active) {
        if (viaTool) addAt(lane, from);
        else store.select(null);
        return;
      }
      if (lane === 'camera' && !hasKind('camera')) { store.notify(t("Las grabaciones de este proyecto no tienen video de cámara.")); return; }
      const r = rangeTo(ev.clientX);
      if (!r) { noRoom(lane); return; }
      if (placeRange(store, LANE_KEY[lane], r) && lane === 'camera') store.setTool('camera');
    };
    const cancel = () => { cleanupRef.current?.(); setDraft(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    cleanupRef.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      cleanupRef.current = null;
    };
  };

  /**
   * Presses on empty row space, clips and the ruler. With Zoom, Lens, Dynamic camera or Hide on, a
   * press anywhere adds that tool's item at that moment in its own row, whichever row was hit.
   * Without a tool, dragging on the zoom, magnifier, camera or privacy row draws there; `otherwise` runs
   * for everything else (selecting a clip, clearing the selection).
   */
  const trackPress = (e: RPointerEvent, ownLane?: DrawLane, otherwise?: () => void) => {
    if (e.button !== 0) return;
    const lane = toolLane();
    if (lane) { addPress(e, lane, true); return; }
    if (ownLane) { addPress(e, ownLane, false); return; }
    otherwise?.();
  };

  /** Guide line under the pointer while a tool is on: shows where a press would add. */
  const onAddMove = (e: RPointerEvent) => {
    if (!addLane || draft || dragRef.current) { if (addHover !== null) setAddHover(null); return; }
    const target = e.target as HTMLElement;
    if (target.closest('.tl-row-label, .tl-ruler-label')) { setAddHover(null); return; }
    const at = timelineAt(e.clientX);
    setAddHover(at >= 0 && at < duration ? at : null);
  };

  type Labeled = ItemBase & { label: string; auto?: boolean; ramp?: [number, number]; parts?: { split: number; first: string; second: string | null } };
  const blockLayout = (items: Labeled[]) => {
    const flat = items
      .flatMap((it) => itemTimelineRanges(project, it, placements).map((r) => ({ it, ...r })))
      .sort((a, b) => a.start - b.start);
    const laneOf = lanes(flat);
    return { flat, laneOf, count: Math.max(1, ...laneOf.map((l) => l + 1)) };
  };

  const itemBlocks = (kind: ItemKind, layout: ReturnType<typeof blockLayout>, laneHeight: number) => layout.flat.map(({ it, start, end }, i) => {
    const selected = selection?.kind === kind && selection.id === it.id;
    const left = x(start);
    const w = Math.max(6, x(end) - left);
    const rampIn = it.ramp ? Math.min(w / 2, (it.ramp[0] / TICKS_PER_SECOND) * pps) : 0;
    const rampOut = it.ramp ? Math.min(w / 2, (it.ramp[1] / TICKS_PER_SECOND) * pps) : 0;
    return (
      <div
        key={`${it.id}-${start}`}
        className={`tl-item tl-${kind}${selected ? ' is-selected' : ''}${it.auto ? ' is-auto' : ''}`}
        style={{ left, width: w, top: 3 + layout.laneOf[i]! * laneHeight, height: laneHeight - 6, ['--ramp-in' as string]: `${rampIn}px`, ['--ramp-out' as string]: `${rampOut}px` }}
        onPointerDown={(e) => press(e, { kind, id: it.id, mode: 'move', start0: it.start, end0: it.end })}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          store.select({ kind, id: it.id });
        }}
        role="button"
        tabIndex={0}
        aria-label={it.label}
        title={it.label}
      >
        <span className="tl-grip start" onPointerDown={(e) => press(e, { kind, id: it.id, mode: 'start', start0: it.start, end0: it.end })} />
        {it.parts ? (
          // Camera move: 1. konum | 2. konum, split by the moment the camera moves.
          <>
            <span className="tl-cam-part is-first" style={{ width: `${it.parts.split * 100}%` }}><b>1</b>{it.parts.first}</span>
            <span className={`tl-cam-part is-second${it.parts.second ? '' : ' is-empty'}`} style={{ left: `${it.parts.split * 100}%`, width: `${(1 - it.parts.split) * 100}%` }}>
              <b>2</b>{it.parts.second ?? t("Elige una posición")}
            </span>
            <span className="tl-cam-divider" style={{ left: `${it.parts.split * 100}%` }} title={t("El momento en que la cámara pasa a la posición 2: arrástralo")}
              onPointerDown={(e) => press(e, { kind: 'split', id: it.id, mode: 'move', start0: it.start, end0: it.end })} />
          </>
        ) : (
          <span className="tl-label">{it.auto && <Icon name="sparkle" size={11} />}{it.label}</span>
        )}
        <span className="tl-grip end" onPointerDown={(e) => press(e, { kind, id: it.id, mode: 'end', start0: it.start, end0: it.end })} />
      </div>
    );
  });

  const zoomLayout = blockLayout(project.zooms.map((z) => ({
    ...z, label: `${z.scale.toFixed(1)}×${z.mode === 'follow' ? ` ${t("seguir")}` : ''}`, auto: z.origin === 'auto',
    ramp: [z.enter.easing.kind === 'instant' ? 0 : z.enter.duration, z.exit.easing.kind === 'instant' ? 0 : z.exit.duration] as [number, number],
  })));
  const magnifierLayout = blockLayout(project.magnifiers.map((m) => ({
    ...m, label: `${m.zoom.toFixed(1)}× · ${Math.round(m.size)} px`, ramp: [MAGNIFIER_RAMP, MAGNIFIER_RAMP] as [number, number],
  })));
  const textLayout = blockLayout(project.texts.map((it) => ({
    ...it, label: it.text.split('\n').find((l) => l.trim()) ?? t("Texto"),
    ramp: [it.enter.kind === 'none' ? 0 : it.enter.duration, it.exit.kind === 'none' ? 0 : it.exit.duration] as [number, number],
  })));
  const privacyLayout = blockLayout(project.privacy.map((p) => ({
    ...p, label: p.effect.kind === 'solid' ? t("Opaco") : p.effect.kind === 'frosted' ? t("Vidrio esmerilado") : p.effect.kind === 'blur' ? t("Desenfoque") : t("Pixelado"),
  })));
  const cameraLayout = blockLayout(project.cameraLayouts.map((c) => ({
    ...c, label: c.layout.visible ? t("Movimiento de cámara") : t("Cámara oculta"),
    ramp: [c.enter.easing.kind === 'instant' ? 0 : c.enter.duration, 0] as [number, number],
    parts: c.layout.visible ? {
      split: (cameraSplitTime(c) - c.start) / Math.max(1, c.end - c.start),
      first: placeName(c.layout.position),
      second: c.second ? placeName(c.second.position) : null,
    } : undefined,
  })));

  const hasKind = (k: 'camera' | 'mic' | 'system') => Object.values(project.recordings).some((r) => r.sources[k]);
  // Videos added from the computer carry their sound on this row too.
  const soundFrom = Object.values(project.recordings).filter((r) => r.sources.system).map((r) => r.capture.backend === 'import');
  const systemLabel = soundFrom.every(Boolean) ? t("Sonido del video") : soundFrom.some(Boolean) ? t("Audio del sistema / del video") : t("Audio del sistema");
  const segmentBlocks = (kind: 'screen' | 'camera' | 'mic' | 'system') => placements.map((pl) => {
    const rec = project.recordings[pl.segment.recordingId];
    if (!rec?.sources[kind]) return null;
    const selected = selection?.kind === 'segment' && selection.id === pl.segment.id;
    const left = x(pl.timelineStart);
    const w = Math.max(2, x(pl.timelineEnd) - left);
    const main = kind === 'screen';
    return (
      <div
        key={pl.segment.id}
        className={`tl-seg tl-seg-${kind}${selected ? ' is-selected' : ''}`}
        style={{ left, width: w }}
        onPointerDown={(e) => trackPress(e, undefined, () => { e.stopPropagation(); store.select({ kind: 'segment', id: pl.segment.id }); })}
        title={t("Sección: pantalla, cámara y audio juntos")}
      >
        {main && <span className="tl-grip start" onPointerDown={(e) => press(e, { kind: 'segment', id: pl.segment.id, mode: 'start', start0: pl.segment.sourceStart, end0: pl.segment.sourceEnd })} />}
        {main && <span className="tl-label">{formatTimecode(pl.timelineEnd - pl.timelineStart)}</span>}
        {main && <span className="tl-grip end" onPointerDown={(e) => press(e, { kind: 'segment', id: pl.segment.id, mode: 'end', start0: pl.segment.sourceStart, end0: pl.segment.sourceEnd })} />}
        {(kind === 'mic' || kind === 'system') && <span className="tl-wave" />}
      </div>
    );
  });

  // Activity strip: pointer speed + clicks per 0.5 s bin, drawn in timeline time.
  const activityStrip = useMemo(() => activityBins(placements, cursors).map((b, i) => (
    <span key={i} style={{ left: (b.t / TICKS_PER_SECOND) * pps, width: Math.max(1, pps * 0.5 - 1), height: 2 + b.v * 9, opacity: 0.25 + b.v * 0.75 }} />
  )), [placements, cursors, pps]);

  const recordings = project.recordings;
  // sourceToTimeline reads only the placements it is given.
  const markers = useMemo(() => Object.values(recordings).flatMap((r) => r.markers.map((m) => sourceToTimeline(project, r.id, m, placements)).filter((t): t is number => t !== null)), [recordings, placements]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = niceStep(pps);
  const ticks: ReactNode[] = [];
  for (let i = 0; i * step <= duration / TICKS_PER_SECOND + step; i++) {
    const s = i * step;
    ticks.push(<span key={s} className="tl-tick" style={{ left: s * pps }}>{tickLabel(s, step)}</span>);
  }

  const row = (label: string, icon: IconName, cls: string, height: number, children: ReactNode, draw?: { lane: DrawLane; hint: string | null }) => (
    <div className={`tl-row ${cls}`} style={{ height }}>
      <div className="tl-row-label"><Icon name={icon} size={14} /><span>{label}</span></div>
      {/* Empty space never moves the playhead: it clears the selection, or draws a range on drawable lanes. */}
      <div
        className={`tl-row-body${draw ? ' is-drawable' : ''}`}
        data-lane={draw?.lane}
        onPointerDown={(e) => trackPress(e, draw?.lane, () => store.select(null))}
      >
        {draw?.hint && <span className="tl-lane-hint">{draw.hint}</span>}
        {children}
        {draft && draw && draft.lane === draw.lane && (
          <div className={`tl-draft tl-draft-${draft.lane}`} style={{ left: x(draft.start), width: Math.max(4, x(draft.end) - x(draft.start)) }}>
            <span className="mono">{t("{n} s", { n: ((draft.end - draft.start) / TICKS_PER_SECOND).toFixed(1) })}</span>
          </div>
        )}
      </div>
    </div>
  );

  const ZL = 34;
  const TL = 28;
  const ML = 30;
  const CL = 30;
  const PL = 26;

  return (
    <div className={`timeline${cutting ? ' is-cutting' : ''}${addLane ? ` is-adding adding-${addLane}` : ''}`}>
      <div className="tl-scroll" ref={scrollRef} onWheel={onWheel}>
        <div
          className="tl-content"
          style={{ width: width + LABEL_W }}
          onPointerDownCapture={onCutDown}
          onPointerMove={(e) => { onCutMove(e); onAddMove(e); }}
          onPointerLeave={() => { setCutAt(null); setAddHover(null); }}
        >
          <div className="tl-ruler">
            <RulerTime store={store} />
            <div className="tl-ruler-body" onPointerDown={(e) => trackPress(e)}>
              {ticks}
              <div className="tl-activity">
                {activityStrip}
              </div>
              {markers.map((m, i) => <span key={i} className="tl-marker" style={{ left: x(m) }} title={t("Marca")}><Icon name="marker" size={11} /></span>)}
            </div>
          </div>
          {row(t("Texto"), 'text', 'tr-text', TL * textLayout.count, itemBlocks('text', textLayout, TL),
            { lane: 'text', hint: textLayout.flat.length === 0 ? t("Arrastra aquí para añadir un texto") : null })}
          {row(t("Zoom"), 'zoom', 'tr-zoom', ZL * zoomLayout.count, itemBlocks('zoom', zoomLayout, ZL),
            { lane: 'zoom', hint: zoomLayout.flat.length === 0 ? t("Arrastra aquí para añadir un zoom") : null })}
          {row(t("Lupa"), 'magnifier', 'tr-magnifier', ML * magnifierLayout.count, itemBlocks('magnifier', magnifierLayout, ML),
            { lane: 'magnifier', hint: magnifierLayout.flat.length === 0 ? t("Arrastra aquí para añadir una lupa") : null })}
          {hasKind('camera') && row(t("Cámara dinámica"), 'layout', 'tr-camlayout', CL * cameraLayout.count, itemBlocks('camera', cameraLayout, CL),
            { lane: 'camera', hint: cameraLayout.flat.length === 0 ? t("Arrastra en un espacio vacío para añadir un movimiento de cámara") : null })}
          {row(t("Privacidad"), 'privacy', 'tr-privacy', PL * privacyLayout.count + 4, itemBlocks('privacy', privacyLayout, PL), { lane: 'privacy', hint: null })}
          {row(t("Pantalla"), 'screen', 'tr-screen', 46, <>
            {segmentBlocks('screen')}
            {/* End of the timeline: add another video from the computer. */}
            <button
              type="button"
              className={`tl-add-clip${importing ? ' is-busy' : ''}`}
              style={{ left: x(duration) + 10 }}
              title={t("Añadir un video desde tu computadora")}
              aria-label={t("Añadir un video desde tu computadora")}
              disabled={importing}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void addVideo()}
            >
              <Icon name="plus" size={16} />
              <span>{importing ? t("Añadiendo…") : t("Añadir video")}</span>
            </button>
          </>)}
          {hasKind('camera') && row(t("Cámara"), 'camera', 'tr-camera', 26, segmentBlocks('camera'))}
          {hasKind('mic') && row(t("Micrófono"), 'mic', 'tr-mic', 26, segmentBlocks('mic'))}
          {hasKind('system') && row(systemLabel, 'speaker', 'tr-system', 26, segmentBlocks('system'))}
          {addLane && addHover !== null && !draft && (
            <div className={`tl-addline tl-addline-${addLane}`} style={{ left: LABEL_W + x(addHover) }}>
              <span className="tl-addline-label">
                {addLane === 'zoom' ? t("+ Zoom") : addLane === 'camera' ? t("+ Movimiento de cámara") : addLane === 'magnifier' ? t("+ Lupa") : addLane === 'text' ? t("+ Texto") : t("+ Área de privacidad")}
              </span>
            </div>
          )}
          {cutting && cutAt !== null && (
            <div className="tl-cutline" style={{ left: LABEL_W + x(cutAt) }}>
              <span className="tl-cutline-label mono">{formatTimecode(cutAt, project.sequence.fps)}</span>
            </div>
          )}
          <PlayheadLine store={store}>
            <span className="tl-playhead-hit" title={t("Arrastra el cabezal de reproducción")} onPointerDown={(e) => press(e, { kind: 'playhead', mode: 'move', start0: 0, end0: 0 })} />
            <span className="tl-playhead-knob" title={t("Arrastra el cabezal de reproducción")} onPointerDown={(e) => press(e, { kind: 'playhead', mode: 'move', start0: 0, end0: 0 })} />
          </PlayheadLine>
        </div>
      </div>
    </div>
  );
}

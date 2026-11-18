import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { Project, SegmentPlacement } from '@momotombo/project-model';
import { TICKS_PER_SECOND, secondsToTicks } from '@momotombo/timing';
import { audioSlices, columnLevel, silentRanges, waveHeight, type Peaks } from '../../audio/peaks';
import type { WaveformPeaks } from '../../audio/waveform-peaks';
import { t } from '../../i18n';

const SILENCE_LEVEL = 10 ** (-40 / 20);
const SILENCE_MIN_SECONDS = 0.6;
const PAD_Y = 6;
const CLIP_MARK = 2;

interface WaveInput {
  kind: 'mic' | 'system';
  gain: number;
  project: Project;
  placements: SegmentPlacement[];
  pxPerSecond: number;
}

type SilenceMemo = WeakMap<Peaks, { level: number; ranges: [number, number][] }>;

function silenceOf(memo: SilenceMemo, peaks: Peaks, level: number): [number, number][] {
  const hit = memo.get(peaks);
  if (hit?.level === level) return hit.ranges;
  const ranges = silentRanges(peaks, level, SILENCE_MIN_SECONDS);
  memo.set(peaks, { level, ranges });
  return ranges;
}

const hatchTiles = new Map<number, HTMLCanvasElement>();

function hatchTile(dpr: number): HTMLCanvasElement | null {
  const cached = hatchTiles.get(dpr);
  if (cached) return cached;
  const size = Math.round(6 * dpr);
  const tile = document.createElement('canvas');
  tile.width = size;
  tile.height = size;
  const pen = tile.getContext('2d');
  if (!pen) return null;
  pen.strokeStyle = 'rgba(255, 255, 255, 0.09)';
  pen.lineWidth = dpr;
  pen.beginPath();
  pen.moveTo(0, size);
  pen.lineTo(size, 0);
  pen.stroke();
  hatchTiles.set(dpr, tile);
  return tile;
}

function silenceHatch(ctx: CanvasRenderingContext2D, dpr: number, scrollLeft: number): CanvasPattern | null {
  const tile = hatchTile(dpr);
  if (!tile) return null;
  const pattern = ctx.createPattern(tile, 'repeat');
  pattern?.setTransform(new DOMMatrix().translateSelf(-((scrollLeft * dpr) % tile.width), 0));
  return pattern;
}

function draw(canvas: HTMLCanvasElement, scroller: HTMLElement, labelWidth: number, input: WaveInput, waveform: WaveformPeaks, memo: SilenceMemo): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(0, scroller.clientWidth - labelWidth);
  const cssH = canvas.parentElement?.clientHeight ?? 0;
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  const { kind, project, placements, pxPerSecond, gain } = input;
  const style = getComputedStyle(canvas);
  const audioRgb = style.getPropertyValue('--track-audio-rgb').trim() || '120, 200, 160';
  const clipColor = style.getPropertyValue('--danger').trim() || '#ff5a5f';
  const { muted } = project.audio[kind];
  const left = scroller.scrollLeft;
  const visibleFrom = secondsToTicks(left / pxPerSecond);
  const visibleTo = secondsToTicks((left + cssW) / pxPerSecond);
  const mid = h / 2;
  const half = Math.max(1, mid - PAD_Y * dpr);
  const colSeconds = 1 / (dpr * pxPerSecond);
  const toDevice = (seconds: number) => Math.round((seconds * pxPerSecond - left) * dpr);

  const hatch = kind === 'mic' ? silenceHatch(ctx, dpr, left) : null;
  ctx.globalAlpha = muted ? 0.4 : 1;
  for (const slice of audioSlices(project, placements, kind, visibleFrom, visibleTo)) {
    const startSec = slice.timelineStart / TICKS_PER_SECOND;
    const endSec = slice.timelineEnd / TICKS_PER_SECOND;
    const c0 = Math.max(0, toDevice(startSec) + 1);
    const c1 = Math.min(w, toDevice(endSec) - 1);
    if (c1 <= c0) continue;
    const state = waveform.get(slice.file);
    if (state.state === 'failed') {
      ctx.fillStyle = `rgba(${audioRgb}, 0.7)`;
      ctx.font = `${11 * dpr}px ${style.fontFamily}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(t("Forma de onda no disponible"), c0 + 8 * dpr, mid, Math.max(0, c1 - c0 - 16 * dpr));
      continue;
    }
    if (state.state !== 'ready') {
      ctx.fillStyle = `rgba(${audioRgb}, 0.3)`;
      for (let c = c0; c < c1; c += 6 * dpr) ctx.fillRect(c, Math.round(mid), Math.min(3 * dpr, c1 - c), Math.max(1, Math.round(dpr)));
      continue;
    }
    const { peaks } = state;
    const fileAt = (column: number) => slice.fileStart + (left + column / dpr) / pxPerSecond - startSec;

    if (kind === 'mic' && gain > 0) {
      const firstFile = fileAt(c0);
      const lastFile = fileAt(c1);
      for (const [a, b] of silenceOf(memo, peaks, SILENCE_LEVEL / gain)) {
        if (b <= firstFile || a >= lastFile) continue;
        const x0 = Math.max(c0, Math.round(c0 + (a - firstFile) * pxPerSecond * dpr));
        const x1 = Math.min(c1, Math.round(c0 + (b - firstFile) * pxPerSecond * dpr));
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(x0, 0, x1 - x0, h);
        if (hatch) {
          ctx.fillStyle = hatch;
          ctx.fillRect(x0, 0, x1 - x0, h);
        }
      }
    }

    for (let c = c0; c < c1; c++) {
      const from = fileAt(c);
      const lv = columnLevel(peaks, from, from + colSeconds);
      if (!lv) continue;
      const peak = lv.peak * gain;
      const clipped = peak >= 1;
      const ph = Math.max(1, waveHeight(lv.peak, gain) * half);
      const rh = waveHeight(lv.rms, gain) * half;
      ctx.fillStyle = clipped ? clipColor : `rgba(${audioRgb}, 0.45)`;
      ctx.fillRect(c, mid - ph, 1, ph * 2);
      if (!clipped) {
        ctx.fillStyle = `rgba(${audioRgb}, 0.95)`;
        ctx.fillRect(c, mid - rh, 1, rh * 2);
      } else {
        ctx.fillRect(c, 0, 1, CLIP_MARK * dpr);
        ctx.fillRect(c, h - CLIP_MARK * dpr, 1, CLIP_MARK * dpr);
      }
    }
  }
  ctx.globalAlpha = 1;
}

export function AudioWave({ waveform, scrollRef, labelWidth, ...input }: WaveInput & {
  waveform: WaveformPeaks;
  scrollRef: RefObject<HTMLDivElement | null>;
  labelWidth: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  const memo = useRef<SilenceMemo>(new WeakMap());
  const redraw = useRef(() => {});

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const scroller = scrollRef.current;
    if (!canvas || !scroller) return;
    let frame = 0;
    const now = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      draw(canvas, scroller, labelWidth, inputRef.current, waveform, memo.current);
    };
    const later = () => { if (!frame) frame = requestAnimationFrame(now); };
    redraw.current = now;
    scroller.addEventListener('scroll', later, { passive: true });
    const resize = new ResizeObserver(later);
    resize.observe(scroller);
    const unsubscribe = waveform.subscribe(later);
    let dprQuery: MediaQueryList | null = null;
    const onDprChange = () => { watchDpr(); later(); };
    const watchDpr = () => {
      dprQuery?.removeEventListener('change', onDprChange);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener('change', onDprChange);
    };
    watchDpr();
    return () => {
      cancelAnimationFrame(frame);
      dprQuery?.removeEventListener('change', onDprChange);
      scroller.removeEventListener('scroll', later);
      resize.disconnect();
      unsubscribe();
    };
  }, [waveform, scrollRef, labelWidth]);

  useLayoutEffect(() => redraw.current(), [input.project, input.placements, input.pxPerSecond, input.kind, input.gain, waveform]);

  return <canvas ref={canvasRef} className="tl-wave" aria-hidden="true" />;
}

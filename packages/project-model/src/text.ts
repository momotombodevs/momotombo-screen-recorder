import type { Ticks } from '@momotombo/timing';
import { cubicBezier } from './easing';
import { clamp01, lerp, type Vec2 } from './geometry';
import type { Hex, ID, Project, TextAlign, TextAnchor, TextAnimation, TextBackground, TextItem, TextWeight } from './types';

export interface TextLayer {
  id: ID;
  text: string;
  visibleGraphemes: number;
  position: Vec2;
  anchor: TextAnchor;
  align: TextAlign;
  fontSize: number;
  fontWeight: TextWeight;
  color: Hex;
  maxWidth: number;
  background: TextBackground | null;
  stroke: { color: Hex; width: number } | null;
  shadow: { color: Hex; opacity: number; blur: number; offsetY: number } | null;
  opacity: number;
  scale: number;
  offset: Vec2;
}

export interface TextAnimationState {
  opacity: number;
  offsetEm: Vec2;
  scale: number;
  visibleGraphemes: number;
}

const SLIDE_EM = 0.8;
const POP_FROM = 0.6;
const easeOut = (u: number) => cubicBezier(0.22, 1, 0.36, 1, u);
const popEase = (u: number) => cubicBezier(0.34, 1.56, 0.64, 1, u);

const SLIDE_DIR: Partial<Record<TextAnimation['kind'], Vec2>> = {
  'slide-up': { x: 0, y: -1 },
  'slide-down': { x: 0, y: 1 },
  'slide-left': { x: -1, y: 0 },
  'slide-right': { x: 1, y: 0 },
};

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), (g) => g.segment);

function shownAt(kind: TextAnimation['kind'], p: number, entering: boolean, chars: number): TextAnimationState {
  const settled = { opacity: 1, offsetEm: { x: 0, y: 0 }, scale: 1, visibleGraphemes: chars };
  if (kind === 'none' || p >= 1) return settled;
  if (kind === 'fade') return { ...settled, opacity: easeOut(p) };
  if (kind === 'pop') return { ...settled, opacity: easeOut(clamp01(p * 2)), scale: lerp(POP_FROM, 1, popEase(p)) };
  if (kind === 'typewriter') return { ...settled, visibleGraphemes: Math.floor(clamp01(p) * chars) };
  const dir = SLIDE_DIR[kind]!;
  const away = (1 - easeOut(p)) * SLIDE_EM * (entering ? -1 : 1);
  return { ...settled, opacity: easeOut(p), offsetEm: { x: dir.x * away, y: dir.y * away } };
}

/** The pure animation of a text item at source time `s`; null outside [start, end). */
export function textAnimationAt(item: Pick<TextItem, 'start' | 'end' | 'enter' | 'exit' | 'text'>, s: Ticks): TextAnimationState | null {
  if (s < item.start || s >= item.end) return null;
  const length = item.end - item.start;
  const enterD = item.enter.kind === 'none' ? 0 : item.enter.duration;
  const exitD = item.exit.kind === 'none' ? 0 : item.exit.duration;
  const fit = enterD + exitD > length ? length / (enterD + exitD) : 1;
  const progress = (elapsed: number, d: number) => (d * fit > 0 ? clamp01(elapsed / (d * fit)) : 1);
  const chars = graphemes(item.text).length;
  const a = shownAt(item.enter.kind, progress(s - item.start, enterD), true, chars);
  const b = shownAt(item.exit.kind, progress(item.end - s, exitD), false, chars);
  return {
    opacity: a.opacity * b.opacity,
    offsetEm: { x: a.offsetEm.x + b.offsetEm.x, y: a.offsetEm.y + b.offsetEm.y },
    scale: a.scale * b.scale,
    visibleGraphemes: Math.min(a.visibleGraphemes, b.visibleGraphemes),
  };
}

/** Text layers for source time `s` of `recordingId` on a width × height canvas, bottom first. */
export function textLayers(project: Project, recordingId: ID, s: Ticks, width: number, height: number): TextLayer[] {
  const unit = Math.min(width, height);
  const out: TextLayer[] = [];
  for (const item of project.texts) {
    if (item.recordingId !== recordingId) continue;
    const anim = textAnimationAt(item, s);
    if (!anim || anim.opacity <= 0.001 || anim.scale <= 0.001) continue;
    const em = item.fontSize * unit;
    out.push({
      id: item.id,
      text: item.text,
      visibleGraphemes: anim.visibleGraphemes,
      position: { x: item.position.x * width, y: item.position.y * height },
      anchor: item.anchor,
      align: item.align,
      fontSize: em,
      fontWeight: item.fontWeight,
      color: item.color,
      maxWidth: item.maxWidth * width,
      background: item.background ? { ...item.background, padding: item.background.padding * em, radius: item.background.radius * em } : null,
      stroke: item.stroke && item.stroke.width > 0 ? { color: item.stroke.color, width: item.stroke.width * em } : null,
      shadow: item.shadow && item.shadow.opacity > 0
        ? { ...item.shadow, blur: item.shadow.blur * em, offsetY: item.shadow.offsetY * em }
        : null,
      opacity: anim.opacity,
      scale: anim.scale,
      offset: { x: anim.offsetEm.x * em, y: anim.offsetEm.y * em },
    });
  }
  return out;
}

const STACK_STEP = 0.08;

/** Where a new text goes so it does not land exactly on another one shown at the same time: lower, a step at a time. */
export function freeTextPosition(texts: readonly TextItem[], r: { recordingId: ID; start: Ticks; end: Ticks }, at: Vec2): Vec2 {
  const taken = (y: number) => texts.some((x) => x.recordingId === r.recordingId && x.start < r.end && r.start < x.end
    && Math.abs(x.position.x - at.x) < STACK_STEP / 2 && Math.abs(x.position.y - y) < STACK_STEP / 2);
  let y = at.y;
  for (let i = 0; i < 12 && taken(y); i++) y = y + STACK_STEP > 0.95 ? 0.05 : y + STACK_STEP;
  return { x: at.x, y };
}

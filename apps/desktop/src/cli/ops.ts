import {
  BACKGROUND_PRESETS, activeVariant, addCameraMoveAt, applyZoomSuggestions, clearAutoZooms, conflictsFor, createProject,
  deepMerge, defaultPrivacyLook, defaultStyle, defaultVariants, itemTimelineRanges, laneRange, layoutSegments, moveSegment,
  newCameraMoveLayout, pictureAspect, placeItem, privacyBounds, presetTransition, removeCameraLayout, removeMagnifier, removePrivacy,
  removeSegment, removeTimelineRange, removeZoom, renameProject, resolveCamera, sequenceDuration, setActiveVariant, setAudio,
  setCameraMovePosition, setStyle, setZoomSensitivity, sourceToTimeline, splitAt, trimSegment, updateCameraLayout,
  updateMagnifier, updatePrivacy, updateText, updateVariant, updateZoom, removeText,
  TEXT_ALIGNS, TEXT_ANCHORS, TEXT_ANIMATION_KINDS, TEXT_LIMITS, TEXT_PRESETS, TEXT_PRESET_IDS, TEXT_WEIGHTS,
  type AudioMix, type Background, type CameraLayout, type CameraShape, type CursorTrack, type DeepPartial, type ItemBase, type PlaceResult,
  type Project, type Rect, type Style, type TextAnimation, type TextItem, type TrackItem, type TrackKey, type Variant, type Vec2,
} from '@momotombo/project-model';
import { secondsToTicks, ticksToSeconds, type Ticks } from '@momotombo/timing';
import { ENGINE_VERSION, suggestZooms, whyNoSuggestions } from '@momotombo/zoom-engine';
import { z } from 'zod';

const Seconds = z.number().min(0).max(86_400);
const Duration = z.number().positive().max(86_400);
const Unit = z.number().min(0).max(1);
const Id = z.string().min(1).max(200);
const Patch = z.record(z.string(), z.unknown());
const Point = z.strictObject({ x: Unit, y: Unit });
const Track = z.enum(['zooms', 'privacy', 'magnifiers', 'cameraLayouts', 'texts']);
const CAMERA_SHAPES = ['circle', 'square', 'rounded', 'rect', 'free', 'squircle'] as const satisfies readonly CameraShape[];
const CameraSpot = z.strictObject({ position: Point.optional(), size: z.number().positive().max(1).optional() });
const range = { start: Seconds, end: Seconds };

const PrivacyEffect = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('solid'), color: z.string() }),
  z.strictObject({ kind: z.literal('frosted') }),
  z.strictObject({ kind: z.literal('blur'), strength: z.number() }),
  z.strictObject({ kind: z.literal('pixelate'), block: z.number() }),
]);

const between = (r: { min: number; max: number }) => z.number().min(r.min).max(r.max);
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb color');
const TL = TEXT_LIMITS;
const TextAnim = z.strictObject({ kind: z.enum(TEXT_ANIMATION_KINDS), duration: z.number().min(0).max(ticksToSeconds(TL.animation.max)) });
const TextBackground = z.strictObject({ color: Hex, opacity: Unit, padding: between(TL.padding), radius: between(TL.radius) });
const TextStroke = z.strictObject({ color: Hex, width: between(TL.stroke) });
const TextShadow = z.strictObject({ color: Hex, opacity: Unit, blur: between(TL.blur), offsetY: between(TL.offsetY) });
const TextBody = z.string().max(TL.length).refine((s) => s.trim() !== '', 'must not be empty');
const TextWeight = z.number().refine((w) => (TEXT_WEIGHTS as readonly number[]).includes(w), `must be ${TEXT_WEIGHTS.join(' | ')}`);
const TEXT_LOOK = {
  position: Point, anchor: z.enum(TEXT_ANCHORS), align: z.enum(TEXT_ALIGNS), fontSize: between(TL.fontSize), fontWeight: TextWeight,
  color: Hex, maxWidth: between(TL.maxWidth),
};
const TextPatch = z.strictObject({
  text: TextBody.optional(),
  ...Object.fromEntries(Object.entries(TEXT_LOOK).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof TEXT_LOOK]: z.ZodOptional<(typeof TEXT_LOOK)[K]> },
  position: Point.partial().optional(),
  background: TextBackground.partial().nullable().optional(),
  stroke: TextStroke.partial().nullable().optional(),
  shadow: TextShadow.partial().nullable().optional(),
  enter: TextAnim.partial().optional(),
  exit: TextAnim.partial().optional(),
});

const CORNERS = {
  'top-left': [-1, -1], 'top-right': [1, -1], 'bottom-left': [-1, 1], 'bottom-right': [1, 1], left: [-1, 0], right: [1, 0],
} as const;
type Corner = keyof typeof CORNERS;
const CAMERA_MARGIN = 0.04;

export const Op = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('cut'), ...range }),
  z.strictObject({ op: z.literal('split'), at: Seconds }),
  z.strictObject({ op: z.literal('removeSegment'), id: Id }),
  z.strictObject({ op: z.literal('moveSegment'), id: Id, toIndex: z.number().int().min(0) }),
  z.strictObject({ op: z.literal('trimSegment'), id: Id, start: Seconds.optional(), end: Seconds.optional() }),
  z.strictObject({
    op: z.literal('addZoom'), ...range,
    scale: z.number().optional(), center: Point.optional(), mode: z.enum(['region', 'follow']).optional(),
  }),
  z.strictObject({
    op: z.literal('addPrivacy'), ...range,
    region: z.strictObject({ x: Unit, y: Unit, w: Unit, h: Unit }), effect: PrivacyEffect.optional(),
  }),
  z.strictObject({ op: z.literal('addMagnifier'), ...range, size: z.number().optional(), zoom: z.number().optional() }),
  z.strictObject({
    op: z.literal('addText'), ...range, text: TextBody, preset: z.enum(TEXT_PRESET_IDS).optional(),
    ...Object.fromEntries(Object.entries(TEXT_LOOK).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof TEXT_LOOK]: z.ZodOptional<(typeof TEXT_LOOK)[K]> },
    background: TextBackground.nullable().optional(), stroke: TextStroke.nullable().optional(), shadow: TextShadow.nullable().optional(),
    enter: TextAnim.optional(), exit: TextAnim.optional(),
  }),
  z.strictObject({ op: z.literal('addCameraLayout'), ...range, layout: Patch.optional(), enter: z.enum(['smooth', 'fast']).optional() }),
  z.strictObject({ op: z.literal('addCameraMove'), at: Seconds, duration: Duration.optional(), first: CameraSpot.optional(), second: CameraSpot.optional() }),
  z.strictObject({ op: z.literal('updateItem'), track: Track, id: Id, patch: Patch.optional(), start: Seconds.optional(), end: Seconds.optional() }),
  z.strictObject({ op: z.literal('removeItem'), track: Track, id: Id }),
  z.strictObject({ op: z.literal('setStyle'), patch: Patch }),
  z.strictObject({ op: z.literal('setAudio'), patch: Patch }),
  z.strictObject({
    op: z.literal('setCamera'), corner: z.enum(Object.keys(CORNERS) as [Corner, ...Corner[]]),
    size: z.number().positive().max(1).optional(), shape: z.enum(CAMERA_SHAPES).optional(), visible: z.boolean().optional(),
  }),
  z.strictObject({ op: z.literal('setVariant'), id: Id }),
  z.strictObject({ op: z.literal('updateVariant'), id: Id, patch: Patch }),
  z.strictObject({ op: z.literal('clearAutoZooms'), recordingId: Id.optional() }),
  z.strictObject({ op: z.literal('applyZoomSuggestions'), recordingId: Id.optional() }),
  z.strictObject({ op: z.literal('setZoomSensitivity'), sensitivity: z.enum(['low', 'medium', 'high']) }),
  z.strictObject({ op: z.literal('rename'), name: z.string().min(1).max(200) }),
]);
export type Op = z.infer<typeof Op>;
export const Ops = z.array(Op).min(1).max(500);

export class OpError extends Error {}

export function parseOps(raw: unknown): Op[] {
  const parsed = Ops.safeParse(raw);
  if (parsed.success) return parsed.data;
  const lines = parsed.error.issues.map((issue) => {
    const [index, ...field] = issue.path;
    if (typeof index !== 'number') return `ops: ${issue.message}`;
    const name = (raw as { op?: unknown }[])[index]?.op;
    const where = `op ${index}${typeof name === 'string' ? ` (${name})` : ''}`;
    return `${where}${field.length ? ` ${field.join('.')}` : ''}: ${issue.message}`;
  });
  throw new OpError(lines.join('\n'));
}

const BACKGROUND_FIELDS = {
  solid: ['color'], gradient: ['from', 'to', 'angle'], aurora: ['colors', 'seed', 'grain'], image: ['file', 'blur'],
} as const satisfies Record<Background['kind'], readonly string[]>;

const kindShapes = (fields: Record<string, readonly string[]>) =>
  Object.entries(fields).map(([kind, keys]) => ({ kind, ...Object.fromEntries(keys.map((k) => [k, null])) }));
const BACKGROUND_SHAPES = kindShapes(BACKGROUND_FIELDS);
const PRIVACY_EFFECT_SHAPES = kindShapes(Object.fromEntries(
  PrivacyEffect.options.map((o) => [o.shape.kind.value, Object.keys(o.shape).filter((k) => k !== 'kind')]),
));

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function unknownFields(patch: unknown, references: unknown[], path: string): string[] {
  if (!isObj(patch)) return [];
  const shapes = references.filter(isObj);
  if (shapes.length === 0) return [];
  const kind = Object.hasOwn(patch, 'kind') ? patch.kind : shapes[0]!.kind;
  const matching = shapes.some((s) => Object.hasOwn(s, 'kind')) ? shapes.filter((s) => s.kind === kind) : shapes;
  if (matching.length === 0) return [`${path}.kind (no kind ${JSON.stringify(kind)})`];
  return Object.entries(patch).flatMap(([key, value]) => {
    const here = path ? `${path}.${key}` : key;
    const inner = matching.filter((s) => Object.hasOwn(s, key)).map((s) => s[key]);
    return inner.length === 0 ? [here] : unknownFields(value, inner, here);
  });
}

function strictPatch<T>(patch: Obj, references: unknown[], path: string, locked: readonly string[] = []): DeepPartial<T> {
  const fixed = Object.keys(patch).filter((k) => locked.includes(k));
  if (fixed.length) throw new OpError(`${fixed.map((k) => `${path}.${k}`).join(', ')} cannot be changed with a patch`);
  const unknown = unknownFields(patch, references, path);
  if (unknown.length) throw new OpError(`unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}`);
  return patch as DeepPartial<T>;
}

const ITEM_LOCKED = ['id', 'type', 'recordingId', 'origin', 'start', 'end'] as const;
const REMOVE_ITEM = { zooms: removeZoom, privacy: removePrivacy, magnifiers: removeMagnifier, cameraLayouts: removeCameraLayout, texts: removeText };

function itemReferences(item: TrackItem): unknown[] {
  if (item.type === 'privacy') return [item, ...PRIVACY_EFFECT_SHAPES.map((effect) => ({ effect }))];
  if (item.type !== 'camera') return [item];
  return [item, { second: { position: item.layout.position, size: item.layout.size }, split: 0.5 }];
}

const findItem = (p: Project, track: TrackKey, id: string) => (p[track] as TrackItem[]).find((i) => i.id === id);

const toTicks = (a: { kind?: TextAnimation['kind']; duration?: number } | undefined) =>
  a && { ...a, ...(a.duration !== undefined ? { duration: secondsToTicks(a.duration) } : {}) };

const OPTIONAL_LOOK = { background: TextBackground, stroke: TextStroke, shadow: TextShadow } as const;

function patchText(p: Project, item: TextItem, raw: Obj): Project {
  const locked = ITEM_LOCKED.filter((k) => Object.hasOwn(raw, k));
  if (locked.length) throw new OpError(`${locked.map((k) => `texts.${k}`).join(', ')} cannot be changed with a patch`);
  const parsed = TextPatch.safeParse(raw);
  if (!parsed.success) throw new OpError(parsed.error.issues.map((i) => `texts.${i.path.join('.')}: ${i.message}`).join('; '));
  const { enter, exit, background, stroke, shadow, ...rest } = parsed.data;
  let next = updateText(p, item.id, { ...rest, enter: toTicks(enter), exit: toTicks(exit) } as DeepPartial<TextItem>);
  const optional = { background, stroke, shadow };
  for (const key of Object.keys(OPTIONAL_LOOK) as (keyof typeof OPTIONAL_LOOK)[]) {
    const value = optional[key];
    if (value === undefined) continue;
    next = { ...next, texts: next.texts.map((x) => {
      if (x.id !== item.id) return x;
      if (value === null) { const { [key]: _gone, ...kept } = x; return kept as TextItem; }
      const merged = { ...x[key], ...value };
      const full = OPTIONAL_LOOK[key].safeParse(merged);
      if (!full.success) throw new OpError(`texts.${key} is not set on this text yet; give all of ${Object.keys(OPTIONAL_LOOK[key].shape).join(', ')}`);
      return { ...x, [key]: full.data };
    }) };
  }
  return next;
}

function patchItem(p: Project, track: TrackKey, item: TrackItem, patch: Obj): Project {
  const timed = ['start', 'end'].filter((k) => Object.hasOwn(patch, k));
  if (timed.length) throw new OpError(`${timed.map((k) => `${track}.${k}`).join(', ')} cannot be changed with a patch; retime it with the op's start and end (timeline seconds)`);
  if (item.type === 'text') return patchText(p, item, patch);
  const clean = strictPatch<TrackItem>(patch, itemReferences(item), track, ITEM_LOCKED);
  const next = track === 'zooms' ? updateZoom(p, item.id, clean as never)
    : track === 'privacy' ? updatePrivacy(p, item.id, clean as never)
      : track === 'magnifiers' ? updateMagnifier(p, item.id, clean as never)
        : updateCameraLayout(p, item.id, clean as never);
  const before = new Set(conflictsFor(p, track, item).map((c) => c.id));
  const overlap = conflictsFor(next, track, findItem(next, track, item.id)!).find((c) => !before.has(c.id));
  if (overlap) throw new OpError(`would overlap item ${overlap.id}`);
  return next;
}

function updateItem(p: Project, op: Extract<Op, { op: 'updateItem' }>): Step {
  if (!op.patch && op.start === undefined && op.end === undefined) throw new OpError('give a patch, a new start or end, or both');
  const item = findItem(p, op.track, op.id);
  if (!item) return { project: p };
  const next = op.patch ? patchItem(p, op.track, item, op.patch) : p;
  if (op.start === undefined && op.end === undefined) return { project: next };
  const current = findItem(next, op.track, op.id)!;
  if (current.type === 'privacy' && current.keyframes.length > 0)
    throw new OpError('a privacy area with keyframes cannot be retimed (its keyframes are tied to recording time); remove it and add it again');
  const shown = shownRanges(next, current);
  if ((op.start === undefined || op.end === undefined) && shown.length === 0)
    throw new OpError('the item is not on the timeline; give both start and end');
  const asked = { start: op.start ?? shown[0]!.start, end: op.end ?? shown[shown.length - 1]!.end };
  const without = REMOVE_ITEM[op.track](next, op.id);
  const { type: _type, ...rest } = current;
  const range = freeRange(without, op.track, asked, current.type === 'privacy' ? privacyBounds(current) : undefined);
  return placed(placeItem(without, op.track, { ...rest, ...range } as never), op.track, asked);
}

function freeRange(p: Project, track: TrackKey, op: { start: number; end: number }, region?: Rect): Pick<ItemBase, 'recordingId' | 'start' | 'end' | 'origin'> {
  if (op.end <= op.start) throw new OpError('end must be after start');
  const free = laneRange(p, track, secondsToTicks(op.start), secondsToTicks(op.end), region);
  if (!free) throw new OpError('no free space on this track at that time');
  return { ...free, origin: 'manual' };
}

interface Step {
  project: Project;
  added?: { track: TrackKey; id: string; asked: { start: number; end: number } };
  note?: Obj;
  warning?: string;
}

function placed(result: PlaceResult, track: TrackKey, asked: { start: number; end: number }): Step {
  if (!result.ok) throw new OpError(`overlaps item ${result.conflict.id}`);
  return { project: result.project, added: { track, id: result.id, asked } };
}

function cameraAspectOf(p: Project): number {
  for (const rec of Object.values(p.recordings)) {
    const aspect = pictureAspect(rec.sources.camera);
    if (aspect) return aspect;
  }
  return 16 / 9;
}

const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

function cornerPosition(corner: Corner, layout: CameraLayout, canvas: { width: number; height: number }, cameraAspect: number): Vec2 {
  const { width, height } = canvas;
  const halfW = (layout.size * height * resolveCamera(layout, cameraAspect).aspect) / 2 / width;
  const halfH = layout.size / 2;
  const margin = CAMERA_MARGIN * Math.min(width, height);
  const [dx, dy] = CORNERS[corner];
  const along = (dir: number, half: number, m: number) => (dir < 0 ? m + half : dir > 0 ? 1 - m - half : 0.5);
  return { x: round4(along(dx, halfW, margin / width)), y: round4(along(dy, halfH, margin / height)) };
}

function setCamera(p: Project, op: Extract<Op, { op: 'setCamera' }>): Project {
  const look: Partial<CameraLayout> = {
    ...(op.size !== undefined ? { size: op.size } : {}),
    ...(op.shape !== undefined ? { shape: op.shape } : {}),
    ...(op.visible !== undefined ? { visible: op.visible } : {}),
  };
  const aspect = cameraAspectOf(p);
  const camera = { ...p.style.camera, ...look };
  const base = p.variants.find((v) => !v.cameraOverride) ?? activeVariant(p);
  let next = setStyle(p, { camera: { ...look, position: cornerPosition(op.corner, camera, base, aspect) } });
  for (const v of p.variants) {
    const override = v.cameraOverride;
    if (!override && v.width * base.height === v.height * base.width) continue;
    const kept = Object.fromEntries(Object.entries(look).filter(([k]) => override && Object.hasOwn(override, k)));
    const resolved = { ...camera, ...override, ...kept };
    next = updateVariant(next, v.id, { cameraOverride: { ...kept, position: cornerPosition(op.corner, resolved, v, aspect) } });
  }
  return next;
}

function variantReferences(p: Project, v: Variant): unknown[] {
  return [v, ...defaultVariants(), { frameOverride: p.style.frame, cameraOverride: p.style.camera }];
}

const recordingsFor = (p: Project, recordingId?: string) => {
  if (recordingId && !p.recordings[recordingId]) throw new OpError(`no recording with id ${recordingId}`);
  return recordingId ? [p.recordings[recordingId]!] : Object.values(p.recordings);
};

export interface OpContext {
  cursorTracks?: Record<string, CursorTrack | null>;
}

function suggest(p: Project, recordingId: string | undefined, ctx: OpContext): Step {
  let next = p;
  let added = 0;
  let replaced = 0;
  const reasons: string[] = [];
  for (const rec of recordingsFor(p, recordingId)) {
    const track = ctx.cursorTracks?.[rec.id] ?? null;
    if (!track) { reasons.push(`${rec.id}: no cursor log`); continue; }
    const items = suggestZooms({
      recordingId: rec.id, duration: rec.duration, track, hasClicks: rec.capture.hasClicks, markers: rec.markers,
      sensitivity: p.zoomEngine.sensitivity, defaults: p.style.zoomDefaults,
    });
    if (items.length === 0) { reasons.push(`${rec.id}: ${whyNoSuggestions(track, rec.capture.hasClicks)}`); continue; }
    const known = new Set(next.zooms.map((z) => z.id));
    const after = applyZoomSuggestions(next, rec.id, items);
    const fresh = after.zooms.filter((z) => !known.has(z.id)).length;
    if (fresh === 0) { reasons.push(`${rec.id}: ${items.length} suggestions overlap manual zooms`); continue; }
    replaced += next.zooms.filter((z) => z.recordingId === rec.id && z.origin === 'auto').length;
    added += fresh;
    next = after;
  }
  if (added === 0) throw new OpError(`no zoom suggestions added (${reasons.join('; ')})`);
  return {
    project: { ...next, zoomEngine: { ...next.zoomEngine, engineVersion: ENGINE_VERSION } },
    note: { added, replaced },
    ...(reasons.length ? { warning: `some recordings got no suggestions (${reasons.join('; ')})` } : {}),
  };
}

function trim(p: Project, op: Extract<Op, { op: 'trimSegment' }>): Step {
  if (op.start === undefined && op.end === undefined) throw new OpError('give start, end or both (source seconds)');
  if (!p.sequence.segments.some((s) => s.id === op.id)) throw new OpError(`no segment with id ${op.id}`);
  let next = p;
  if (op.start !== undefined) next = trimSegment(next, op.id, 'start', secondsToTicks(op.start));
  if (op.end !== undefined) next = trimSegment(next, op.id, 'end', secondsToTicks(op.end));
  const before = p.sequence.segments.find((s) => s.id === op.id)!;
  const after = next.sequence.segments.find((s) => s.id === op.id)!;
  if (after.sourceStart === before.sourceStart && after.sourceEnd === before.sourceEnd) return { project: p };
  const got = { sourceStart: seconds(after.sourceStart), sourceEnd: seconds(after.sourceEnd) };
  const off = (asked: number | undefined, real: number) => asked !== undefined && Math.abs(asked - real) > 0.002;
  const clamped = off(op.start, got.sourceStart) || off(op.end, got.sourceEnd);
  return {
    project: next, note: got,
    ...(clamped ? { warning: `trimmed to ${got.sourceStart}–${got.sourceEnd} s of the recording (kept inside the recording and at least one frame long)` } : {}),
  };
}

function applyOp(p: Project, op: Op, ctx: OpContext): Step {
  switch (op.op) {
    case 'cut': {
      if (op.end <= op.start) throw new OpError('end must be after start');
      const next = removeTimelineRange(p, secondsToTicks(op.start), secondsToTicks(op.end));
      const left = sequenceDuration(next);
      if (left === sequenceDuration(p)) return { project: p };
      if (left === 0) throw new OpError('would remove the whole timeline');
      return { project: next };
    }
    case 'split': return { project: splitAt(p, secondsToTicks(op.at)) };
    case 'removeSegment': {
      if (p.sequence.segments.length === 1 && p.sequence.segments[0]!.id === op.id) throw new OpError('would remove the whole timeline');
      return { project: removeSegment(p, op.id) };
    }
    case 'moveSegment': {
      const from = p.sequence.segments.findIndex((s) => s.id === op.id);
      return { project: from < 0 || from === Math.min(op.toIndex, p.sequence.segments.length - 1) ? p : moveSegment(p, op.id, op.toIndex) };
    }
    case 'trimSegment': return trim(p, op);
    case 'addZoom': {
      const d = p.style.zoomDefaults;
      return placed(placeItem(p, 'zooms', {
        ...freeRange(p, 'zooms', op), mode: op.mode ?? 'region', center: op.center ?? { x: 0.5, y: 0.5 }, scale: op.scale ?? d.scale, enter: d.enter, exit: d.exit,
      }), 'zooms', op);
    }
    case 'addPrivacy':
      return placed(placeItem(p, 'privacy', {
        ...freeRange(p, 'privacy', op, op.region), ...defaultPrivacyLook(), region: op.region, ...(op.effect ? { effect: op.effect } : {}),
      }), 'privacy', op);
    case 'addMagnifier': {
      const m = p.style.magnifier;
      return placed(placeItem(p, 'magnifiers', { ...freeRange(p, 'magnifiers', op), size: op.size ?? m.size, zoom: op.zoom ?? m.zoom }), 'magnifiers', op);
    }
    case 'addText': {
      const { op: _op, start, end, preset, text, background, stroke, shadow, enter, exit, ...look } = op;
      const base = TEXT_PRESETS[preset ?? 'title'];
      const item = {
        ...freeRange(p, 'texts', op), ...base, ...look, text, fontWeight: (look.fontWeight ?? base.fontWeight) as TextItem['fontWeight'],
        ...(enter ? { enter: toTicks(enter) as TextAnimation } : {}), ...(exit ? { exit: toTicks(exit) as TextAnimation } : {}),
      };
      const optional = { background, stroke, shadow };
      for (const key of Object.keys(OPTIONAL_LOOK) as (keyof typeof OPTIONAL_LOOK)[]) {
        if (optional[key] === null) delete item[key];
        else if (optional[key]) Object.assign(item, { [key]: optional[key] });
      }
      return placed(placeItem(p, 'texts', item), 'texts', { start, end });
    }
    case 'addCameraLayout': {
      const base = newCameraMoveLayout(p);
      const look = op.layout ? strictPatch<CameraLayout>(op.layout, [base, p.style.camera], 'layout') : {};
      return placed(placeItem(p, 'cameraLayouts', {
        ...freeRange(p, 'cameraLayouts', op), layout: deepMerge<CameraLayout>(base, look as DeepPartial<CameraLayout>), enter: presetTransition(op.enter ?? 'smooth'),
      }), 'cameraLayouts', op);
    }
    case 'addCameraMove': {
      const duration = op.duration ?? 3;
      const added = addCameraMoveAt(p, secondsToTicks(op.at), undefined, secondsToTicks(duration));
      if (!added) throw new OpError('no free space on the camera track at that time');
      let next = added.project;
      if (op.first) next = setCameraMovePosition(next, added.id, 1, op.first);
      if (op.second) next = setCameraMovePosition(next, added.id, 2, op.second);
      return { project: next, added: { track: 'cameraLayouts', id: added.id, asked: { start: op.at, end: op.at + duration } } };
    }
    case 'updateItem': return updateItem(p, op);
    case 'removeItem': return { project: REMOVE_ITEM[op.track](p, op.id) };
    case 'setStyle': {
      const references = [
        p.style, defaultStyle(), ...BACKGROUND_PRESETS.map((b) => ({ background: b.background })), ...BACKGROUND_SHAPES.map((background) => ({ background })),
      ];
      return { project: setStyle(p, strictPatch<Style>(op.patch, references, 'style')) };
    }
    case 'setAudio':
      return { project: setAudio(p, strictPatch<AudioMix>(op.patch, [p.audio, createProject('').audio], 'audio')) };
    case 'setCamera': return { project: setCamera(p, op) };
    case 'setVariant': {
      if (!p.variants.some((v) => v.id === op.id)) throw new OpError(`no variant with id ${op.id}; ids: ${p.variants.map((v) => v.id).join(', ')}`);
      return { project: setActiveVariant(p, op.id) };
    }
    case 'updateVariant': {
      const v = p.variants.find((x) => x.id === op.id);
      if (!v) throw new OpError(`no variant with id ${op.id}; ids: ${p.variants.map((x) => x.id).join(', ')}`);
      return { project: updateVariant(p, op.id, strictPatch<Variant>(op.patch, variantReferences(p, v), 'variant', ['id'])) };
    }
    case 'clearAutoZooms': {
      const next = recordingsFor(p, op.recordingId).reduce((q, rec) => clearAutoZooms(q, rec.id), p);
      return { project: next.zooms.length === p.zooms.length ? p : next, note: { removed: p.zooms.length - next.zooms.length } };
    }
    case 'applyZoomSuggestions': return suggest(p, op.recordingId, ctx);
    case 'setZoomSensitivity':
      return { project: op.sensitivity === p.zoomEngine.sensitivity ? p : setZoomSensitivity(p, op.sensitivity) };
    case 'rename': return { project: op.name === p.name ? p : renameProject(p, op.name) };
  }
}

const seconds = (t: Ticks) => Math.round(ticksToSeconds(t) * 1000) / 1000;

function shownRanges(project: Project, item: ItemBase, placements = layoutSegments(project)) {
  return itemTimelineRanges(project, item, placements).map((r) => ({ start: seconds(r.start), end: seconds(r.end) }));
}

export interface OpResult {
  index: number;
  op: Op['op'];
  id?: string;
  placed?: { start: number; end: number };
  [extra: string]: unknown;
}

export interface Applied {
  project: Project;
  results: OpResult[];
  warnings: string[];
}

export function applyOps(project: Project, ops: readonly Op[], ctx: OpContext = {}): Applied {
  const results: OpResult[] = [];
  const warnings: string[] = [];
  const final = ops.reduce((p, op, index) => {
    const where = `op ${index} (${op.op})`;
    let step: Step;
    try {
      step = applyOp(p, op, ctx);
    } catch (e) {
      throw new OpError(`${where}: ${(e as Error).message}`);
    }
    if (step.project === p) throw new OpError(`${where}: changed nothing (time outside the timeline, unknown id, or already applied)`);
    const result: OpResult = { index, op: op.op, ...step.note };
    if (step.added) {
      const { track, id, asked } = step.added;
      const item = (step.project[track] as TrackItem[]).find((i) => i.id === id)!;
      const shown = shownRanges(step.project, item);
      const got = { start: shown[0]?.start ?? 0, end: shown[shown.length - 1]?.end ?? 0 };
      result.id = id;
      result.placed = got;
      if (Math.abs(got.start - asked.start) > 0.002 || Math.abs(got.end - asked.end) > 0.002)
        warnings.push(`${where}: placed ${got.start}–${got.end} s instead of ${asked.start}–${asked.end} s (shortened to stay inside one clip section and clear of neighbouring items)`);
    }
    if (step.warning) warnings.push(`${where}: ${step.warning}`);
    results.push(result);
    return step.project;
  }, project);
  return { project: final, results, warnings };
}

function sourceInfo(project: Project) {
  return Object.values(project.recordings).map((r) => ({
    id: r.id,
    durationSeconds: seconds(r.duration),
    files: Object.fromEntries(Object.entries(r.sources).map(([kind, source]) => [kind, source.file])),
    sources: Object.fromEntries(Object.entries(r.sources).map(([kind, s]) => [kind, {
      file: s.file, mime: s.mime,
      ...(s.width !== undefined ? { width: s.width } : {}), ...(s.height !== undefined ? { height: s.height } : {}),
      ...(s.fps !== undefined ? { fps: s.fps } : {}), ...(s.sampleRate !== undefined ? { sampleRate: s.sampleRate } : {}),
      ...(s.channels !== undefined ? { channels: s.channels } : {}),
    }])),
    capture: r.capture,
    ...(r.cursorFile ? { cursorFile: r.cursorFile } : {}),
    markers: r.markers.map((m) => sourceToTimeline(project, r.id, m, layoutSegments(project))).filter((t) => t !== null).map(seconds),
  }));
}

export function describeProject(project: Project) {
  const placements = layoutSegments(project);
  const shown = (item: ItemBase) => shownRanges(project, item, placements);
  const canvas = activeVariant(project);
  return {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    durationSeconds: seconds(sequenceDuration(project)),
    canvas: { name: canvas.name, width: canvas.width, height: canvas.height },
    activeVariantId: project.activeVariantId,
    variants: project.variants,
    segments: placements.map((pl) => ({
      id: pl.segment.id, recordingId: pl.segment.recordingId, start: seconds(pl.timelineStart), end: seconds(pl.timelineEnd),
      sourceStart: seconds(pl.segment.sourceStart), sourceEnd: seconds(pl.segment.sourceEnd),
    })),
    zooms: project.zooms.map((z) => ({ id: z.id, shown: shown(z), origin: z.origin, mode: z.mode, scale: z.scale, center: z.center })),
    privacy: project.privacy.map((a) => ({ id: a.id, shown: shown(a), region: a.region, effect: a.effect })),
    magnifiers: project.magnifiers.map((m) => ({ id: m.id, shown: shown(m), size: m.size, zoom: m.zoom })),
    texts: project.texts.map((item) => {
      const { id, type: _type, recordingId: _rec, start: _start, end: _end, enter, exit, ...look } = item;
      return { id, shown: shown(item), ...look, enter: { ...enter, duration: seconds(enter.duration) }, exit: { ...exit, duration: seconds(exit.duration) } };
    }),
    cameraLayouts: project.cameraLayouts.map((c) => ({
      id: c.id, shown: shown(c), origin: c.origin, layout: c.layout,
      enterSeconds: seconds(c.enter.duration), ...(c.second ? { second: c.second } : {}), ...(c.split !== undefined ? { split: c.split } : {}),
    })),
    recordings: sourceInfo(project),
    style: project.style,
    audio: project.audio,
    zoomEngine: project.zoomEngine,
  };
}

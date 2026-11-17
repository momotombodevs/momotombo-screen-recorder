import {
  activeVariant, defaultPrivacyLook, itemTimelineRanges, laneRange, layoutSegments, moveSegment, placeItem,
  removeCameraLayout, removeMagnifier, removePrivacy, removeSegment, removeTimelineRange, removeZoom, renameProject,
  sequenceDuration, setAudio, setStyle, sourceToTimeline, splitAt,
  type AudioMix, type DeepPartial, type ItemBase, type PlaceResult, type Project, type Rect, type Style, type TrackKey,
} from '@momotombo/project-model';
import { secondsToTicks, ticksToSeconds, type Ticks } from '@momotombo/timing';
import { z } from 'zod';

const Seconds = z.number().min(0).max(86_400);
const Unit = z.number().min(0).max(1);
const Id = z.string().min(1).max(200);
const Patch = z.record(z.string(), z.unknown());
const range = { start: Seconds, end: Seconds };

const PrivacyEffect = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('solid'), color: z.string() }),
  z.strictObject({ kind: z.literal('frosted') }),
  z.strictObject({ kind: z.literal('blur'), strength: z.number() }),
  z.strictObject({ kind: z.literal('pixelate'), block: z.number() }),
]);

export const Op = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('cut'), ...range }),
  z.strictObject({ op: z.literal('split'), at: Seconds }),
  z.strictObject({ op: z.literal('removeSegment'), id: Id }),
  z.strictObject({ op: z.literal('moveSegment'), id: Id, toIndex: z.number().int().min(0) }),
  z.strictObject({
    op: z.literal('addZoom'), ...range,
    scale: z.number().optional(), center: z.strictObject({ x: Unit, y: Unit }).optional(), mode: z.enum(['region', 'follow']).optional(),
  }),
  z.strictObject({
    op: z.literal('addPrivacy'), ...range,
    region: z.strictObject({ x: Unit, y: Unit, w: Unit, h: Unit }), effect: PrivacyEffect.optional(),
  }),
  z.strictObject({ op: z.literal('addMagnifier'), ...range, size: z.number().optional(), zoom: z.number().optional() }),
  z.strictObject({ op: z.literal('removeItem'), track: z.enum(['zooms', 'privacy', 'magnifiers', 'cameraLayouts']), id: Id }),
  z.strictObject({ op: z.literal('setStyle'), patch: Patch }),
  z.strictObject({ op: z.literal('setAudio'), patch: Patch }),
  z.strictObject({ op: z.literal('rename'), name: z.string().min(1).max(200) }),
]);
export type Op = z.infer<typeof Op>;
export const Ops = z.array(Op).min(1).max(500);

export class OpError extends Error {}

const REMOVE_ITEM = { zooms: removeZoom, privacy: removePrivacy, magnifiers: removeMagnifier, cameraLayouts: removeCameraLayout };

function freeRange(p: Project, track: TrackKey, op: { start: number; end: number }, region?: Rect): Pick<ItemBase, 'recordingId' | 'start' | 'end' | 'origin'> {
  if (op.end <= op.start) throw new OpError('end must be after start');
  const free = laneRange(p, track, secondsToTicks(op.start), secondsToTicks(op.end), region);
  if (!free) throw new OpError('no free space on this track at that time');
  return { ...free, origin: 'manual' };
}

function placed(result: PlaceResult): Project {
  if (!result.ok) throw new OpError(`overlaps item ${result.conflict.id}`);
  return result.project;
}

function applyOp(p: Project, op: Op): Project {
  switch (op.op) {
    case 'cut': {
      if (op.end <= op.start) throw new OpError('end must be after start');
      const next = removeTimelineRange(p, secondsToTicks(op.start), secondsToTicks(op.end));
      const left = sequenceDuration(next);
      if (left === sequenceDuration(p)) return p;
      if (left === 0) throw new OpError('would remove the whole timeline');
      return next;
    }
    case 'split': return splitAt(p, secondsToTicks(op.at));
    case 'removeSegment': {
      if (p.sequence.segments.length === 1 && p.sequence.segments[0]!.id === op.id) throw new OpError('would remove the whole timeline');
      return removeSegment(p, op.id);
    }
    case 'moveSegment': {
      const from = p.sequence.segments.findIndex((s) => s.id === op.id);
      return from < 0 || from === Math.min(op.toIndex, p.sequence.segments.length - 1) ? p : moveSegment(p, op.id, op.toIndex);
    }
    case 'addZoom': {
      const d = p.style.zoomDefaults;
      return placed(placeItem(p, 'zooms', {
        ...freeRange(p, 'zooms', op), mode: op.mode ?? 'region', center: op.center ?? { x: 0.5, y: 0.5 }, scale: op.scale ?? d.scale, enter: d.enter, exit: d.exit,
      }));
    }
    case 'addPrivacy':
      return placed(placeItem(p, 'privacy', {
        ...freeRange(p, 'privacy', op, op.region), ...defaultPrivacyLook(), region: op.region, ...(op.effect ? { effect: op.effect } : {}),
      }));
    case 'addMagnifier': {
      const m = p.style.magnifier;
      return placed(placeItem(p, 'magnifiers', { ...freeRange(p, 'magnifiers', op), size: op.size ?? m.size, zoom: op.zoom ?? m.zoom }));
    }
    case 'removeItem': return REMOVE_ITEM[op.track](p, op.id);
    case 'setStyle': return setStyle(p, op.patch as DeepPartial<Style>);
    case 'setAudio': return setAudio(p, op.patch as DeepPartial<AudioMix>);
    case 'rename': return op.name === p.name ? p : renameProject(p, op.name);
  }
}

export function applyOps(project: Project, ops: readonly Op[]): Project {
  return ops.reduce((p, op, i) => {
    const where = `op ${i} (${op.op})`;
    let next: Project;
    try {
      next = applyOp(p, op);
    } catch (e) {
      throw new OpError(`${where}: ${(e as Error).message}`);
    }
    if (next === p) throw new OpError(`${where}: changed nothing (time outside the timeline, unknown id, or already applied)`);
    return next;
  }, project);
}

const seconds = (t: Ticks) => Math.round(ticksToSeconds(t) * 1000) / 1000;

export function describeProject(project: Project) {
  const placements = layoutSegments(project);
  const shown = (item: ItemBase) => itemTimelineRanges(project, item, placements).map((r) => ({ start: seconds(r.start), end: seconds(r.end) }));
  const canvas = activeVariant(project);
  return {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    durationSeconds: seconds(sequenceDuration(project)),
    canvas: { name: canvas.name, width: canvas.width, height: canvas.height },
    segments: placements.map((pl) => ({
      id: pl.segment.id, recordingId: pl.segment.recordingId, start: seconds(pl.timelineStart), end: seconds(pl.timelineEnd),
      sourceStart: seconds(pl.segment.sourceStart), sourceEnd: seconds(pl.segment.sourceEnd),
    })),
    zooms: project.zooms.map((z) => ({ id: z.id, shown: shown(z), origin: z.origin, mode: z.mode, scale: z.scale, center: z.center })),
    privacy: project.privacy.map((a) => ({ id: a.id, shown: shown(a), region: a.region, effect: a.effect })),
    magnifiers: project.magnifiers.map((m) => ({ id: m.id, shown: shown(m), size: m.size, zoom: m.zoom })),
    cameraLayouts: project.cameraLayouts.map((c) => ({ id: c.id, shown: shown(c) })),
    recordings: Object.values(project.recordings).map((r) => ({
      id: r.id,
      durationSeconds: seconds(r.duration),
      files: Object.fromEntries(Object.entries(r.sources).map(([kind, source]) => [kind, source.file])),
      ...(r.cursorFile ? { cursorFile: r.cursorFile } : {}),
      markers: r.markers.map((m) => sourceToTimeline(project, r.id, m, placements)).filter((t) => t !== null).map(seconds),
    })),
    style: project.style,
    audio: project.audio,
  };
}

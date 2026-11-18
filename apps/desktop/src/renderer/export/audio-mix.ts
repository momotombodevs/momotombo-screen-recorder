import {
  layoutSegments,
  sequenceDuration,
  type Project,
  type SegmentPlacement,
  type SourceKind,
} from "@momotombo/project-model";
import { TICKS_PER_SECOND } from "@momotombo/timing";
import { LoudnessMeter } from "../audio/loudness";
import { VoiceChain, channelGain, softLimit } from "../audio/voice-chain";
import { t } from "../i18n";

export const SAMPLE_RATE = 48_000;
const FADE_SECONDS = 0.008;

export const AUDIO_KINDS = ["mic", "system"] as const satisfies readonly SourceKind[];
export type AudioKind = (typeof AUDIO_KINDS)[number];

export interface DecodedAudio {
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export type DecodedSources = Map<string, DecodedAudio>;
export const sourceKey = (recordingId: string, kind: AudioKind) => `${recordingId}/${kind}`;

/** An audio source the export needs could not be read; the export stops instead of leaving it out. */
export class AudioReadError extends Error {
  override name = "AudioReadError";
}

async function decodeSource(
  file: string,
  url: string,
  ctx: BaseAudioContext,
): Promise<AudioBuffer> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await ctx.decodeAudioData(await res.arrayBuffer());
  } catch {
    const name = file.split("/").pop() ?? file;
    throw new AudioReadError(
      t(
        "No se pudo leer el audio de origen: {file}. Puede que el archivo esté dañado o falte. Puedes desactivar el audio e intentarlo de nuevo.",
        { file: name },
      ),
    );
  }
}

const audible = (project: Project, k: AudioKind) =>
  !project.audio[k].muted && project.audio[k].gain > 0;

export async function decodeTimelineAudio(
  project: Project,
  mediaBase: string,
  kinds: readonly AudioKind[],
  signal?: AbortSignal,
  cache?: Map<string, Promise<DecodedAudio>>,
): Promise<DecodedSources | null> {
  const ctx = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  const decode = (file: string): Promise<DecodedAudio> => {
    const u = url(file);
    const hit = cache?.get(u);
    if (hit) return hit;
    const p = decodeSource(file, u, ctx);
    cache?.set(u, p);
    p.catch(() => cache?.delete(u));
    return p;
  };
  const decoded: DecodedSources = new Map();
  const url = (file: string) =>
    mediaBase + file.split("/").map(encodeURIComponent).join("/");
  const used = new Set(project.sequence.segments.map((s) => s.recordingId));
  for (const rec of Object.values(project.recordings)) {
    if (!used.has(rec.id)) continue;
    for (const k of kinds) {
      const src = rec.sources[k];
      if (src)
        decoded.set(sourceKey(rec.id, k), await decode(src.file));
      if (signal?.aborted) return null;
    }
  }
  return decoded;
}

const timelineLength = (project: Project) =>
  Math.ceil((sequenceDuration(project) / TICKS_PER_SECOND) * SAMPLE_RATE);

const continues = (a: SegmentPlacement | undefined, b: SegmentPlacement | undefined) =>
  !!a && !!b && a.segment.recordingId === b.segment.recordingId && a.segment.sourceEnd === b.segment.sourceStart;

interface Piece {
  outStart: number;
  count: number;
  inStart: number;
  ratio: number;
  c0: Float32Array;
  c1: Float32Array;
  fade: number;
  fadeIn: boolean;
  fadeOut: boolean;
}

interface TrackPlan {
  pieces: Piece[];
  stereo: boolean;
}

function planTrack(project: Project, kind: AudioKind, decoded: DecodedSources): TrackPlan | null {
  const placements = layoutSegments(project);
  const pieces: Piece[] = [];
  let stereo = false;
  placements.forEach((pl, n) => {
    const rec = project.recordings[pl.segment.recordingId];
    const buf = decoded.get(sourceKey(pl.segment.recordingId, kind));
    const src = rec?.sources[kind];
    if (!rec || !buf || !src) return;
    const offset = src.startOffset + (rec.syncOffsets[kind] ?? 0);
    const count = Math.round(((pl.timelineEnd - pl.timelineStart) / TICKS_PER_SECOND) * SAMPLE_RATE);
    const fade = Math.min(Math.round(FADE_SECONDS * SAMPLE_RATE), Math.floor(count / 2));
    const c0 = buf.getChannelData(0);
    stereo ||= buf.numberOfChannels > 1;
    pieces.push({
      outStart: Math.round((pl.timelineStart / TICKS_PER_SECOND) * SAMPLE_RATE),
      count,
      inStart: Math.round(((pl.segment.sourceStart - offset) / TICKS_PER_SECOND) * buf.sampleRate),
      ratio: buf.sampleRate / SAMPLE_RATE,
      c0,
      c1: buf.numberOfChannels > 1 ? buf.getChannelData(1) : c0,
      fade,
      fadeIn: fade > 0 && !continues(placements[n - 1], pl),
      fadeOut: fade > 0 && !continues(pl, placements[n + 1]),
    });
  });
  return pieces.length > 0 ? { pieces, stereo } : null;
}

function renderBlock(plan: TrackPlan, from: number, L: Float32Array, R: Float32Array): void {
  L.fill(0);
  if (R !== L) R.fill(0);
  const to = from + L.length;
  for (const p of plan.pieces) {
    const start = Math.max(from, p.outStart);
    const end = Math.min(to, p.outStart + p.count);
    const last = p.c0.length - 1;
    for (let o = start; o < end; o++) {
      const i = o - p.outStart;
      const pos = p.inStart + i * p.ratio;
      const j = Math.floor(pos);
      if (j < 0 || j > last) continue;
      const f = pos - j;
      const k = Math.min(j + 1, last);
      let w = 1;
      if (p.fadeIn && i < p.fade) w = (i + 1) / (p.fade + 1);
      if (p.fadeOut && i >= p.count - p.fade) w = Math.min(w, (p.count - i) / (p.fade + 1));
      L[o - from]! += (p.c0[j]! + (p.c0[k]! - p.c0[j]!) * f) * w;
      if (R !== L) R[o - from]! += (p.c1[j]! + (p.c1[k]! - p.c1[j]!) * f) * w;
    }
  }
}

const BLOCK = SAMPLE_RATE;

/** The kind's track after its voice chain, one block at a time; a mono track has R === L. */
function* processedBlocks(project: Project, kind: AudioKind, plan: TrackPlan, length: number) {
  const chain = new VoiceChain(project.audio[kind], SAMPLE_RATE);
  const L = new Float32Array(BLOCK);
  const R = plan.stereo ? new Float32Array(BLOCK) : L;
  for (let from = 0; from < length; from += BLOCK) {
    const n = Math.min(BLOCK, length - from);
    const l = n === BLOCK ? L : L.subarray(0, n);
    const r = R === L ? l : n === BLOCK ? R : R.subarray(0, n);
    renderBlock(plan, from, l, r);
    chain.process([l, r]);
    yield { from, L: l, R: r };
  }
}

/** Loudness of the processed track, yielding after every block so a caller can give the thread back. */
export function* measureSteps(project: Project, kind: AudioKind, decoded: DecodedSources): Generator<void, number | null> {
  const plan = planTrack(project, kind, decoded);
  if (!plan) return null;
  const meter = new LoudnessMeter(SAMPLE_RATE);
  for (const b of processedBlocks(project, kind, plan, timelineLength(project))) {
    meter.push([b.L, b.R]);
    yield;
  }
  return meter.result();
}

function runToEnd<T>(steps: Generator<void, T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

export function mixDecoded(
  project: Project,
  decoded: DecodedSources,
): [Float32Array, Float32Array] | null {
  const length = timelineLength(project);
  if (length === 0) return null;
  const L = new Float32Array(length);
  const R = new Float32Array(length);
  let any = false;
  for (const k of AUDIO_KINDS) {
    if (!audible(project, k)) continue;
    const plan = planTrack(project, k, decoded);
    if (!plan) continue;
    any = true;
    const ch = project.audio[k];
    const gain = channelGain(ch, ch.normalize.enabled ? runToEnd(measureSteps(project, k, decoded)) : null);
    for (const b of processedBlocks(project, k, plan, length)) {
      for (let i = 0; i < b.L.length; i++) {
        L[b.from + i]! += b.L[i]! * gain;
        R[b.from + i]! += b.R[i]! * gain;
      }
    }
  }
  if (!any) return null;
  for (const ch of [L, R]) for (let i = 0; i < length; i++) ch[i] = softLimit(ch[i]!);
  return [L, R];
}

/**
 * Mixes mic + system audio along the edited timeline into stereo 48 kHz PCM. Null when nothing on
 * the timeline has audible sound. A source that would be heard but cannot be decoded throws
 * AudioReadError: an export with audio never silently drops a track.
 */
export async function mixTimelineAudio(
  project: Project,
  mediaBase: string,
  signal?: AbortSignal,
): Promise<[Float32Array, Float32Array] | null> {
  if (timelineLength(project) === 0) return null;
  const kinds = AUDIO_KINDS.filter((k) => audible(project, k));
  const decoded = await decodeTimelineAudio(project, mediaBase, kinds, signal);
  if (!decoded || decoded.size === 0) return null;
  return mixDecoded(project, decoded);
}

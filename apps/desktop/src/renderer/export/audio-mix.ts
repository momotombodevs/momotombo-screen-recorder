import {
  layoutSegments,
  sequenceDuration,
  type Project,
  type SegmentPlacement,
  type SourceKind,
} from "@momotombo/project-model";
import { TICKS_PER_SECOND } from "@momotombo/timing";
import { integratedLoudness } from "../audio/loudness";
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
): Promise<DecodedSources | null> {
  const ctx = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  const decoded: DecodedSources = new Map();
  const url = (file: string) =>
    mediaBase + file.split("/").map(encodeURIComponent).join("/");
  const used = new Set(project.sequence.segments.map((s) => s.recordingId));
  for (const rec of Object.values(project.recordings)) {
    if (!used.has(rec.id)) continue;
    for (const k of kinds) {
      const src = rec.sources[k];
      if (src)
        decoded.set(sourceKey(rec.id, k), await decodeSource(src.file, url(src.file), ctx));
      if (signal?.aborted) return null;
    }
  }
  return decoded;
}

const timelineLength = (project: Project) =>
  Math.ceil((sequenceDuration(project) / TICKS_PER_SECOND) * SAMPLE_RATE);

const continues = (a: SegmentPlacement | undefined, b: SegmentPlacement | undefined) =>
  !!a && !!b && a.segment.recordingId === b.segment.recordingId && a.segment.sourceEnd === b.segment.sourceStart;

export function renderTrack(
  project: Project,
  kind: AudioKind,
  decoded: DecodedSources,
  length = timelineLength(project),
): [Float32Array, Float32Array] | null {
  const L = new Float32Array(length);
  const R = new Float32Array(length);
  const placements = layoutSegments(project);
  let any = false;
  placements.forEach((pl, n) => {
    const rec = project.recordings[pl.segment.recordingId];
    const buf = decoded.get(sourceKey(pl.segment.recordingId, kind));
    const src = rec?.sources[kind];
    if (!rec || !buf || !src) return;
    any = true;
    const offset = src.startOffset + (rec.syncOffsets[kind] ?? 0);
    const outStart = Math.round((pl.timelineStart / TICKS_PER_SECOND) * SAMPLE_RATE);
    const count = Math.round(((pl.timelineEnd - pl.timelineStart) / TICKS_PER_SECOND) * SAMPLE_RATE);
    const inStart = ((pl.segment.sourceStart - offset) / TICKS_PER_SECOND) * buf.sampleRate;
    const c0 = buf.getChannelData(0);
    const c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : c0;
    const ratio = buf.sampleRate / SAMPLE_RATE;
    const fade = Math.min(Math.round(FADE_SECONDS * SAMPLE_RATE), Math.floor(count / 2));
    const fadeIn = fade > 0 && !continues(placements[n - 1], pl);
    const fadeOut = fade > 0 && !continues(pl, placements[n + 1]);
    const last = c0.length - 1;
    for (let i = 0; i < count; i++) {
      const o = outStart + i;
      if (o >= length) break;
      const pos = Math.round(inStart) + i * ratio;
      const j = Math.floor(pos);
      if (j < 0 || j > last) continue;
      const f = pos - j;
      const k = Math.min(j + 1, last);
      let w = 1;
      if (fadeIn && i < fade) w = (i + 1) / (fade + 1);
      if (fadeOut && i >= count - fade) w = Math.min(w, (count - i) / (fade + 1));
      L[o]! += (c0[j]! + (c0[k]! - c0[j]!) * f) * w;
      R[o]! += (c1[j]! + (c1[k]! - c1[j]!) * f) * w;
    }
  });
  return any ? [L, R] : null;
}

export function processedTrack(
  project: Project,
  kind: AudioKind,
  decoded: DecodedSources,
  length = timelineLength(project),
): [Float32Array, Float32Array] | null {
  const track = renderTrack(project, kind, decoded, length);
  if (track) new VoiceChain(project.audio[kind], SAMPLE_RATE).process(track);
  return track;
}

export function trackLoudness(track: [Float32Array, Float32Array] | null): number | null {
  return track ? integratedLoudness(track, SAMPLE_RATE) : null;
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
    const ch = project.audio[k];
    const track = processedTrack(project, k, decoded, length);
    if (!track) continue;
    any = true;
    const gain = channelGain(ch, ch.normalize.enabled ? trackLoudness(track) : null);
    const [tl, tr] = track;
    for (let i = 0; i < length; i++) {
      L[i]! += tl[i]! * gain;
      R[i]! += tr[i]! * gain;
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

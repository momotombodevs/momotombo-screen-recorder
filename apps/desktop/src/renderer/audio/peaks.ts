import type { Project, SegmentPlacement } from '@momotombo/project-model';
import { TICKS_PER_SECOND, type Ticks } from '@momotombo/timing';

export const BUCKETS_PER_SECOND = 100;
export const FULL_SCALE = 65_535;
const FULL_RATE = 48_000;
const MIN_DECODE_RATE = 8_000;
const WAVE_RANGE_DB = 60;
export interface Peaks {
  bucketsPerSecond: number;
  peak: Uint16Array;
  rms: Uint16Array;
}

const quantize = (v: number) => Math.round(Math.min(1, v) * FULL_SCALE);
export function fillPeaks(channels: readonly Float32Array[], rate: number, out: Peaks, from: number, to: number): void {
  const length = channels[0]?.length ?? 0;
  const per = rate / out.bucketsPerSecond;
  for (let b = from; b < to; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(length, Math.floor((b + 1) * per));
    let peak = 0;
    let sum = 0;
    for (const c of channels) {
      for (let i = start; i < end; i++) {
        const v = c[i]!;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sum += v * v;
      }
    }
    const n = (end - start) * channels.length;
    out.peak[b] = quantize(peak);
    out.rms[b] = n > 0 ? quantize(Math.sqrt(sum / n)) : 0;
  }
}

export function emptyPeaks(length: number, rate: number, bucketsPerSecond = BUCKETS_PER_SECOND): Peaks {
  const count = Math.ceil((length * bucketsPerSecond) / rate);
  return { bucketsPerSecond, peak: new Uint16Array(count), rms: new Uint16Array(count) };
}

export function computePeaks(channels: readonly Float32Array[], rate: number, bucketsPerSecond = BUCKETS_PER_SECOND): Peaks {
  const out = emptyPeaks(channels[0]?.length ?? 0, rate, bucketsPerSecond);
  fillPeaks(channels, rate, out, 0, out.peak.length);
  return out;
}

const HEADER = 8;

export function encodePeaks(p: Peaks): Uint8Array {
  const n = p.peak.length;
  const bytes = new Uint8Array(HEADER + n * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, p.bucketsPerSecond, true);
  view.setUint32(4, n, true);
  for (let i = 0; i < n; i++) {
    view.setUint16(HEADER + i * 2, p.peak[i]!, true);
    view.setUint16(HEADER + n * 2 + i * 2, p.rms[i]!, true);
  }
  return bytes;
}

export function decodePeaks(bytes: Uint8Array): Peaks | null {
  if (bytes.length < HEADER) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bucketsPerSecond = view.getUint32(0, true);
  const n = view.getUint32(4, true);
  if (bucketsPerSecond === 0 || bytes.length !== HEADER + n * 4) return null;
  const peak = new Uint16Array(n);
  const rms = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    peak[i] = view.getUint16(HEADER + i * 2, true);
    rms[i] = view.getUint16(HEADER + n * 2 + i * 2, true);
  }
  return { bucketsPerSecond, peak, rms };
}
export function columnLevel(p: Peaks, from: number, to: number): { peak: number; rms: number } | null {
  const first = Math.max(0, Math.floor(from * p.bucketsPerSecond));
  const last = Math.min(p.peak.length, Math.max(Math.floor(from * p.bucketsPerSecond) + 1, Math.ceil(to * p.bucketsPerSecond)));
  if (first >= last) return null;
  let peak = 0;
  let rms = 0;
  for (let b = first; b < last; b++) {
    if (p.peak[b]! > peak) peak = p.peak[b]!;
    if (p.rms[b]! > rms) rms = p.rms[b]!;
  }
  return { peak: peak / FULL_SCALE, rms: rms / FULL_SCALE };
}
export function silentRanges(p: Peaks, level: number, minSeconds: number): [number, number][] {
  const limit = level * FULL_SCALE;
  const minBuckets = Math.ceil(minSeconds * p.bucketsPerSecond - 1e-9);
  const out: [number, number][] = [];
  let start = -1;
  for (let b = 0; b <= p.peak.length; b++) {
    const quiet = b < p.peak.length && p.peak[b]! < limit;
    if (quiet && start < 0) start = b;
    if (!quiet && start >= 0) {
      if (b - start >= minBuckets) out.push([start / p.bucketsPerSecond, b / p.bucketsPerSecond]);
      start = -1;
    }
  }
  return out;
}
export function peakDecodeRate(seconds: number, channels: number, budgetBytes: number): number {
  const fits = Math.floor(budgetBytes / (Math.max(1, seconds) * Math.max(1, channels) * 4));
  return Math.max(MIN_DECODE_RATE, Math.min(FULL_RATE, fits));
}

export interface AudioSlice {
  file: string;
  timelineStart: Ticks;
  timelineEnd: Ticks;
  fileStart: number;
}
export function audioSlices(project: Project, placements: readonly SegmentPlacement[], kind: 'mic' | 'system', from: Ticks, to: Ticks): AudioSlice[] {
  const out: AudioSlice[] = [];
  for (const pl of placements) {
    if (pl.timelineEnd <= from || pl.timelineStart >= to) continue;
    const rec = project.recordings[pl.segment.recordingId];
    const src = rec?.sources[kind];
    if (!rec || !src) continue;
    const offset = src.startOffset + (rec.syncOffsets[kind] ?? 0);
    out.push({ file: src.file, timelineStart: pl.timelineStart, timelineEnd: pl.timelineEnd, fileStart: (pl.segment.sourceStart - offset) / TICKS_PER_SECOND });
  }
  return out;
}

export function waveHeight(level: number, gain: number): number {
  const v = level * gain;
  if (v <= 0) return 0;
  return Math.max(0, Math.min(1, 1 + (20 * Math.log10(v)) / WAVE_RANGE_DB));
}

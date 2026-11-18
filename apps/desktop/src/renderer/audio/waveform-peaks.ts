import type { Project } from '@momotombo/project-model';
import { TICKS_PER_SECOND } from '@momotombo/timing';
import { api, type PeaksStamp } from '../api';
import { AUDIO_KINDS, SAMPLE_RATE, type AudioKind, type DecodedAudio } from '../export/audio-mix';
import { decodePeaks, emptyPeaks, encodePeaks, fillPeaks, peakDecodeRate, type Peaks } from './peaks';

export type PeaksState = { state: 'loading' } | { state: 'ready'; peaks: Peaks } | { state: 'failed' };

export interface PeaksIo {
  read(file: string): Promise<{ stamp: PeaksStamp; data: Uint8Array | null }>;
  write(file: string, stamp: PeaksStamp, data: Uint8Array): Promise<boolean>;
  decode(file: string, rate: number): Promise<DecodedAudio>;
  release(file: string, kind: AudioKind): void;
}

interface Job { file: string; kind: AudioKind; seconds: number; channels: number }

export const PEAK_DECODE_BUDGET = 512 * 1024 * 1024;
const SLICE_MS = 8;
const BUCKETS_PER_STEP = 200;
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));
const LOADING: PeaksState = { state: 'loading' };

export class WaveformPeaks {
  private states = new Map<string, PeaksState>();
  private queue: Job[] = [];
  private running = false;
  private disposed = false;
  private listeners = new Set<() => void>();

  constructor(private readonly io: PeaksIo, private readonly budgetBytes = PEAK_DECODE_BUDGET) {}

  get(file: string): PeaksState {
    return this.states.get(file) ?? LOADING;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  update(project: Project): void {
    for (const rec of Object.values(project.recordings)) {
      for (const kind of AUDIO_KINDS) {
        const src = rec.sources[kind];
        if (!src || this.states.has(src.file)) continue;
        this.states.set(src.file, LOADING);
        this.queue.push({ file: src.file, kind, seconds: src.duration / TICKS_PER_SECOND, channels: src.channels ?? 2 });
      }
    }
    void this.run();
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.listeners.clear();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job && !this.disposed; job = this.queue.shift()) {
        const state = await this.load(job);
        if (this.disposed) return;
        this.states.set(job.file, state);
        for (const fn of this.listeners) fn();
      }
    } finally {
      this.running = false;
    }
  }

  private async load(job: Job): Promise<PeaksState> {
    try {
      const cached = await this.io.read(job.file);
      const fromDisk = cached.data && decodePeaks(cached.data);
      if (fromDisk) return { state: 'ready', peaks: fromDisk };
      const decoded = await this.io.decode(job.file, peakDecodeRate(job.seconds, job.channels, this.budgetBytes));
      const peaks = await this.compute(decoded);
      this.io.release(job.file, job.kind);
      if (!peaks) return LOADING;
      await this.io.write(job.file, cached.stamp, encodePeaks(peaks)).catch((err: unknown) => console.warn('Could not store waveform peaks', err));
      return { state: 'ready', peaks };
    } catch (err) {
      console.warn('Waveform peaks failed', job.file, err);
      return { state: 'failed' };
    }
  }

  private async compute(audio: DecodedAudio): Promise<Peaks | null> {
    const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
    const out = emptyPeaks(channels[0]?.length ?? 0, audio.sampleRate);
    let sliceStart = performance.now();
    for (let b = 0; b < out.peak.length; b += BUCKETS_PER_STEP) {
      fillPeaks(channels, audio.sampleRate, out, b, Math.min(out.peak.length, b + BUCKETS_PER_STEP));
      if (performance.now() - sliceStart > SLICE_MS) {
        await yieldToUi();
        if (this.disposed) return null;
        sliceStart = performance.now();
      }
    }
    return out;
  }
}

export function projectPeaksIo(
  projectId: string,
  mediaBase: string,
  decodeCache: Map<string, Promise<DecodedAudio>>,
  keepDecoded: (kind: AudioKind) => boolean,
): PeaksIo {
  const url = (file: string) => mediaBase + file.split('/').map(encodeURIComponent).join('/');
  const decodeAt = async (u: string, rate: number): Promise<DecodedAudio> => {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new OfflineAudioContext(1, 1, rate).decodeAudioData(await res.arrayBuffer());
  };
  return {
    read: (file) => api.readPeaks(projectId, file),
    write: (file, stamp, data) => api.writePeaks(projectId, file, stamp, data),
    decode: (file, rate) => {
      const u = url(file);
      if (rate !== SAMPLE_RATE) return decodeAt(u, rate);
      const hit = decodeCache.get(u);
      if (hit) return hit;
      const p = decodeAt(u, rate);
      decodeCache.set(u, p);
      p.catch(() => decodeCache.delete(u));
      return p;
    },
    release: (file, kind) => {
      if (!keepDecoded(kind)) decodeCache.delete(url(file));
    },
  };
}

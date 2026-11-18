import { describe, expect, it, vi } from 'vitest';
import { addRecording, createProject, type Project, type Recording } from '@momotombo/project-model';
import { secondsToTicks as sec } from '@momotombo/timing';
import { computePeaks, encodePeaks } from './peaks';
import { WaveformPeaks, type PeaksIo } from './waveform-peaks';

function recording(seconds: number): Recording {
  return {
    id: 'r1', createdAt: '2026-10-16T00:00:00Z', duration: sec(seconds),
    sources: {
      screen: { kind: 'screen', file: 'media/r1/screen.mp4', mime: 'video/mp4', width: 1920, height: 1080, fps: 30, startOffset: 0, duration: sec(seconds) },
      mic: { kind: 'mic', file: 'media/r1/mic.m4a', mime: 'audio/mp4', channels: 1, startOffset: 0, duration: sec(seconds) },
      system: { kind: 'system', file: 'media/r1/system.m4a', mime: 'audio/mp4', channels: 2, startOffset: 0, duration: sec(seconds) },
    },
    capture: { backend: 'web', platform: 'test', target: { kind: 'display', label: 'P', bounds: { x: 0, y: 0, w: 10, h: 10 }, scaleFactor: 1 }, cursorInFrames: false, hasClicks: false },
    syncOffsets: {}, markers: [],
  };
}

const tone = (rate: number, seconds: number) => Float32Array.from({ length: rate * seconds }, (_, i) => 0.5 * Math.sin(i / 7));
const stamp = { size: 10, mtimeMs: 1 };

function fakeIo(cached: Record<string, Uint8Array> = {}): PeaksIo & { written: Map<string, Uint8Array> } {
  const written = new Map<string, Uint8Array>();
  return {
    written,
    read: vi.fn(async (file: string) => ({ stamp, data: cached[file] ?? null })),
    write: vi.fn(async (file: string, _s, data: Uint8Array) => { written.set(file, data); return true; }),
    decode: vi.fn(async (_file: string, rate: number) => {
      const c = tone(rate, 2);
      return { sampleRate: rate, numberOfChannels: 1, getChannelData: () => c };
    }),
    release: vi.fn(),
  };
}

async function loaded(w: WaveformPeaks, p: Project, file: string) {
  w.update(p.recordings);
  await vi.waitFor(() => expect(w.get(file).state).not.toBe('loading'));
  return w.get(file);
}

describe('WaveformPeaks', () => {
  it('uses peaks from the project cache without decoding', async () => {
    const cachedPeaks = computePeaks([tone(48_000, 1)], 48_000);
    const io = fakeIo({ 'media/r1/mic.m4a': encodePeaks(cachedPeaks), 'media/r1/system.m4a': encodePeaks(cachedPeaks) });
    const w = new WaveformPeaks(io);
    const state = await loaded(w, addRecording(createProject('W'), recording(1)), 'media/r1/mic.m4a');
    expect(state.state === 'ready' && [...state.peaks.peak]).toEqual([...cachedPeaks.peak]);
    expect(io.decode).not.toHaveBeenCalled();
  });

  it('decodes a source missing from the cache once, stores its peaks, releases the decoded audio and tells listeners', async () => {
    const io = fakeIo();
    const w = new WaveformPeaks(io);
    const heard = vi.fn();
    w.subscribe(heard);
    const p = addRecording(createProject('W'), recording(2));
    await loaded(w, p, 'media/r1/mic.m4a');
    await vi.waitFor(() => expect(w.get('media/r1/system.m4a').state).toBe('ready'));
    w.update(p.recordings);
    expect(io.decode).toHaveBeenCalledTimes(2);
    expect(io.decode).toHaveBeenCalledWith('media/r1/mic.m4a', 48_000);
    expect(io.write).toHaveBeenCalledWith('media/r1/mic.m4a', stamp, expect.any(Uint8Array));
    expect(io.written.get('media/r1/mic.m4a')!.length).toBe(8 + 200 * 4);
    expect(io.release).toHaveBeenCalledWith('media/r1/mic.m4a', 'mic');
    expect(heard).toHaveBeenCalled();
  });

  it('decodes a long source at a lower rate so the decoded audio stays within the budget', async () => {
    const io = fakeIo();
    const w = new WaveformPeaks(io, 512 * 1024 * 1024);
    await loaded(w, addRecording(createProject('W'), recording(2 * 3600)), 'media/r1/mic.m4a');
    expect(io.decode).toHaveBeenCalledWith('media/r1/mic.m4a', 18_641);
  });

  it('marks a source whose audio decodes to nothing as unavailable instead of loading', async () => {
    const io = fakeIo();
    vi.mocked(io.decode).mockResolvedValueOnce({ sampleRate: 48_000, numberOfChannels: 1, getChannelData: () => new Float32Array(0) });
    const w = new WaveformPeaks(io);
    expect((await loaded(w, addRecording(createProject('W'), recording(1)), 'media/r1/mic.m4a')).state).toBe('failed');
    expect(io.write).not.toHaveBeenCalledWith('media/r1/mic.m4a', expect.anything(), expect.anything());
  });

  it('marks a source it cannot read as failed and moves on to the next', async () => {
    const io = fakeIo();
    vi.mocked(io.decode).mockRejectedValueOnce(new Error('corrupt'));
    const w = new WaveformPeaks(io);
    const p = addRecording(createProject('W'), recording(1));
    expect((await loaded(w, p, 'media/r1/mic.m4a')).state).toBe('failed');
    await vi.waitFor(() => expect(w.get('media/r1/system.m4a').state).toBe('ready'));
  });
});

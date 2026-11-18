import { afterEach, describe, expect, it, vi } from 'vitest';
import { addRecording, createProject, parseProject, removeTimelineRange, serializeProject, setAudio, splitAt, type Project, type Recording } from '@momotombo/project-model';
import { secondsToTicks as sec } from '@momotombo/timing';
import { integratedLoudness } from '../audio/loudness';
import { AudioReadError, mixTimelineAudio } from './audio-mix';

const RATE = 48_000;

function audioRecording(id: string, files: { mic?: string; system?: string }, seconds = 2): Recording {
  const audio = (kind: 'mic' | 'system', file: string) => ({ kind, file, mime: 'audio/webm', startOffset: 0, duration: sec(seconds) });
  return {
    id, createdAt: '2026-10-16T00:00:00Z', duration: sec(seconds),
    sources: {
      screen: { kind: 'screen', file: `${id}/screen.webm`, mime: 'video/webm', width: 1920, height: 1080, fps: 30, startOffset: 0, duration: sec(seconds) },
      ...(files.mic ? { mic: audio('mic', files.mic) } : {}),
      ...(files.system ? { system: audio('system', files.system) } : {}),
    },
    capture: { backend: 'web', platform: 'test', target: { kind: 'display', label: 'Pantalla', bounds: { x: 0, y: 0, w: 1440, h: 900 }, scaleFactor: 2 }, cursorInFrames: false, hasClicks: false },
    syncOffsets: {}, markers: [],
  };
}

const BASE = 'app-media://p/';

type Source = 'missing' | 'corrupt' | { rate?: number; seconds?: number; sample: (i: number, rate: number) => number };
const level = (v: number): Source => ({ sample: () => v });

function fakeAudio(files: Record<string, Source>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const name = decodeURIComponent(url.slice(BASE.length));
    const state = files[name];
    if (!state || state === 'missing') return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(state === 'corrupt' ? 'corrupt' : name).buffer };
  }));
  vi.stubGlobal('OfflineAudioContext', class {
    async decodeAudioData(data: ArrayBuffer) {
      const src = files[new TextDecoder().decode(data)];
      if (!src || typeof src === 'string') throw new DOMException('Unable to decode audio data', 'EncodingError');
      const rate = src.rate ?? RATE;
      const samples = Float32Array.from({ length: Math.round(rate * (src.seconds ?? 2)) }, (_, i) => src.sample(i, rate));
      return { sampleRate: rate, numberOfChannels: 1, length: samples.length, getChannelData: () => samples };
    }
  });
}

function projectWith(...recs: Recording[]): Project {
  return recs.reduce((p, r) => addRecording(p, r), createProject('Audio'));
}

describe('mixTimelineAudio', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('mixes every source that decodes', async () => {
    fakeAudio({ 'r1/mic.webm': level(0.25), 'r1/sys.webm': level(0.25) });
    const pcm = await mixTimelineAudio(projectWith(audioRecording('r1', { mic: 'r1/mic.webm', system: 'r1/sys.webm' })), BASE);
    expect(pcm?.[0][1000]).toBeCloseTo(0.25 * 1 + 0.25 * 0.8);
  });

  it('fails the export when one audio source cannot be decoded', async () => {
    fakeAudio({ 'r1/mic.webm': level(0.25), 'r1/sys.webm': 'corrupt' });
    const p = projectWith(audioRecording('r1', { mic: 'r1/mic.webm', system: 'r1/sys.webm' }));
    await expect(mixTimelineAudio(p, BASE)).rejects.toBeInstanceOf(AudioReadError);
    await expect(mixTimelineAudio(p, BASE)).rejects.toThrow('sys.webm');
  });

  it('fails the export when no audio source can be read', async () => {
    fakeAudio({});
    await expect(mixTimelineAudio(projectWith(audioRecording('r1', { mic: 'r1/mic.webm' })), BASE)).rejects.toThrow('mic.webm');
  });

  it('returns no audio for a project without audio sources', async () => {
    fakeAudio({});
    await expect(mixTimelineAudio(projectWith(audioRecording('r1', {})), BASE)).resolves.toBeNull();
  });

  it('does not need a muted source', async () => {
    fakeAudio({ 'r1/mic.webm': level(0.25), 'r1/sys.webm': 'corrupt' });
    const p = setAudio(projectWith(audioRecording('r1', { mic: 'r1/mic.webm', system: 'r1/sys.webm' })), { system: { muted: true } });
    expect((await mixTimelineAudio(p, BASE))?.[0][1000]).toBeCloseTo(0.25);
  });

  it('does not need the sound of a recording that was cut out of the timeline', async () => {
    fakeAudio({ 'r1/mic.webm': level(0.25), 'r2/mic.webm': 'missing' });
    const both = projectWith(audioRecording('r1', { mic: 'r1/mic.webm' }), audioRecording('r2', { mic: 'r2/mic.webm' }));
    expect((await mixTimelineAudio(removeTimelineRange(both, sec(2), sec(4)), BASE))?.[0][1000]).toBeCloseTo(0.25);
  });

  it('fades both sides of a cut instead of jumping (no click)', async () => {
    fakeAudio({ 'r1/mic.webm': { seconds: 6, sample: (i) => (i < RATE * 2 ? 0.5 : -0.5) } });
    const p = removeTimelineRange(projectWith(audioRecording('r1', { mic: 'r1/mic.webm' }, 6)), sec(1.5), sec(2.5));
    const [L] = (await mixTimelineAudio(p, BASE))!;
    const cut = RATE * 1.5;
    expect(Math.abs(L[cut - 1]!)).toBeLessThan(0.05);
    expect(Math.abs(L[cut]!)).toBeLessThan(0.05);
    for (let i = cut - 2000; i < cut + 2000; i++) expect(Math.abs(L[i + 1]! - L[i]!)).toBeLessThan(0.2);
    expect(L[cut - RATE * 0.02]).toBeCloseTo(0.5);
    expect(L[cut + RATE * 0.02]).toBeCloseTo(-0.5);
  });

  it('does not fade a split that keeps the sound continuous', async () => {
    fakeAudio({ 'r1/mic.webm': level(0.25) });
    const p = splitAt(projectWith(audioRecording('r1', { mic: 'r1/mic.webm' })), sec(1));
    const [L] = (await mixTimelineAudio(p, BASE))!;
    for (let i = RATE - 500; i < RATE + 500; i++) expect(L[i]).toBeCloseTo(0.25);
  });

  it('limits a sum just over full scale smoothly instead of dropping it', async () => {
    fakeAudio({ 'r1/mic.webm': level(0.6), 'r1/sys.webm': level(0.6) });
    const [L] = (await mixTimelineAudio(projectWith(audioRecording('r1', { mic: 'r1/mic.webm', system: 'r1/sys.webm' })), BASE))!;
    expect(L[1000]).toBeGreaterThan(0.95);
    expect(L[1000]).toBeLessThanOrEqual(1);
  });

  it('interpolates a source at another sample rate instead of repeating samples', async () => {
    fakeAudio({ 'r1/mic.webm': { rate: 24_000, sample: (i) => i * 1e-5 } });
    const [L] = (await mixTimelineAudio(projectWith(audioRecording('r1', { mic: 'r1/mic.webm' })), BASE))!;
    expect(L[1001]).toBeCloseTo(500.5e-5, 7);
    expect(L[1002]! - L[1001]!).toBeCloseTo(L[1001]! - L[1000]!, 7);
  });

  it('applies a gain above 100%', async () => {
    fakeAudio({ 'r1/mic.webm': level(0.25) });
    const p = setAudio(projectWith(audioRecording('r1', { mic: 'r1/mic.webm' })), { mic: { gain: 2.5 } });
    expect((await mixTimelineAudio(p, BASE))?.[0][1000]).toBeCloseTo(0.625);
  });

  it('normalizes the voice to the target loudness', async () => {
    const voice = { seconds: 6, sample: (i: number, rate: number) => 0.03 * Math.sin((2 * Math.PI * 220 * i) / rate) * (Math.floor(i / (rate / 2)) % 3 === 2 ? 0.2 : 1) };
    fakeAudio({ 'r1/mic.webm': voice });
    const p = setAudio(projectWith(audioRecording('r1', { mic: 'r1/mic.webm' }, 6)), { mic: { highpassHz: 80, compressor: { enabled: true }, normalize: { enabled: true, targetLufs: -16 } } });
    const pcm = (await mixTimelineAudio(p, BASE))!;
    expect(integratedLoudness(pcm, RATE)).toBeCloseTo(-16, 0);
    expect(pcm[0].reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toBeLessThanOrEqual(1);
  });

  it('exports a project saved before enhancement existed exactly as before, apart from the edge fades', async () => {
    fakeAudio({ 'r1/mic.webm': { sample: (i) => 0.3 * Math.sin(i / 7) }, 'r1/sys.webm': { sample: (i) => 0.2 * Math.cos(i / 5) } });
    const json = JSON.parse(serializeProject(projectWith(audioRecording('r1', { mic: 'r1/mic.webm', system: 'r1/sys.webm' }))));
    json.audio = { mic: { gain: 0.9, muted: false }, system: { gain: 0.7, muted: false } };
    const [L, R] = (await mixTimelineAudio(parseProject(json), BASE))!;
    const fade = RATE * 0.008;
    for (let i = fade; i < L.length - fade; i += 97) {
      const want = Math.fround(0.3 * Math.sin(i / 7)) * 0.9 + Math.fround(0.2 * Math.cos(i / 5)) * 0.7;
      expect(L[i]).toBeCloseTo(want, 6);
      expect(R[i]).toBe(L[i]);
    }
  });
});

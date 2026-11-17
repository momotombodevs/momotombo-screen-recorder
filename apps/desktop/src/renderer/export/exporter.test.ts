import { afterEach, describe, expect, it, vi } from 'vitest';
import { addRecording, createProject, removeTimelineRange, setAudio, type Project, type Recording } from '@momotombo/project-model';
import { secondsToTicks as sec } from '@momotombo/timing';
import { AudioReadError, CompositorHolder, Failure, mixTimelineAudio, retryOnce, waitForEncodeQueue } from './exporter';

class FakeEncoder {
  encodeQueueSize = 10;
  state = 'configured';
  private l = new Set<() => void>();
  addEventListener(_: 'dequeue', fn: () => void) { this.l.add(fn); }
  removeEventListener(_: 'dequeue', fn: () => void) { this.l.delete(fn); }
  dequeue(n: number) { this.encodeQueueSize = n; for (const f of [...this.l]) { this.l.delete(f); f(); } }
  get listeners() { return this.l.size; }
}

describe('waitForEncodeQueue', () => {
  it('returns once the queue drains', async () => {
    const enc = new FakeEncoder();
    const p = waitForEncodeQueue(enc, 6, new Failure(), new AbortController().signal);
    enc.dequeue(8);
    enc.dequeue(5);
    await expect(p).resolves.toBeUndefined();
    expect(enc.listeners).toBe(0);
  });

  it('rejects with the encoder error instead of waiting forever for a dequeue', async () => {
    const enc = new FakeEncoder();
    const failure = new Failure();
    const p = waitForEncodeQueue(enc, 6, failure, new AbortController().signal, 60_000);
    failure.set(new Error('encoder exploded'));
    await expect(p).rejects.toThrow('encoder exploded');
  });

  it('notices a closed encoder even with no error callback', async () => {
    const enc = new FakeEncoder();
    const p = waitForEncodeQueue(enc, 6, new Failure(), new AbortController().signal, 5);
    enc.state = 'closed';
    await expect(p).rejects.toThrow();
  });

  it('stops on abort', async () => {
    const enc = new FakeEncoder();
    const ac = new AbortController();
    const p = waitForEncodeQueue(enc, 6, new Failure(), ac.signal, 60_000);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('Failure', () => {
  it('keeps the first error and races pending work', async () => {
    const f = new Failure();
    const never = new Promise<void>(() => undefined);
    const raced = f.race(never);
    f.set(new Error('first'));
    f.set(new Error('second'));
    await expect(raced).rejects.toThrow('first');
    expect(() => f.throwIfSet()).toThrow('first');
    await expect(f.race(Promise.resolve(1))).rejects.toThrow('first');
  });

  it('passes results through while nothing failed', async () => {
    await expect(new Failure().race(Promise.resolve(7))).resolves.toBe(7);
  });
});

describe('retryOnce', () => {
  it('retries once after a reset, then wraps the error', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('timeout'));
    const reset = vi.fn();
    await expect(retryOnce(attempt, reset, () => new Error('No se pudo leer el video de origen: screen.webm'))).rejects.toThrow('screen.webm');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('succeeds on the second try', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue('frame');
    await expect(retryOnce(attempt, () => undefined, (e) => e)).resolves.toBe('frame');
  });

  it('never retries an abort', async () => {
    const abort = Object.assign(new Error('x'), { name: 'AbortError' });
    const attempt = vi.fn().mockRejectedValue(abort);
    await expect(retryOnce(attempt, () => undefined, () => new Error('wrapped'))).rejects.toBe(abort);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('CompositorHolder', () => {
  class FakeComp { lost = false; disposed = false; dispose() { this.disposed = true; } }

  it('keeps one compositor while its context lives', () => {
    const make = vi.fn(() => new FakeComp());
    const h = new CompositorHolder(make);
    h.draw(() => 1);
    h.draw(() => 2);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('draws again on a new compositor when the context is lost during drawing', () => {
    const made: FakeComp[] = [];
    const h = new CompositorHolder(() => { const c = new FakeComp(); made.push(c); return c; });
    const discarded: string[] = [];
    let calls = 0;
    const out = h.draw((c) => {
      calls++;
      if (calls === 1) c.lost = true; // context taken away while this frame was drawn
      return `frame${calls}`;
    }, (r) => discarded.push(r));
    expect(out).toBe('frame2');
    expect(discarded).toEqual(['frame1']);
    expect(made).toHaveLength(2);
    expect(made[0]!.disposed).toBe(true);
  });

  it('gives up with an error instead of producing blank frames forever', () => {
    const h = new CompositorHolder(() => new FakeComp(), 2);
    expect(() => h.draw((c) => { c.lost = true; return 0; })).toThrow();
  });
});

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

function fakeAudio(files: Record<string, 'ok' | 'missing' | 'corrupt'>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const state = files[decodeURIComponent(url.slice(BASE.length))];
    if (!state || state === 'missing') return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(state).buffer };
  }));
  vi.stubGlobal('OfflineAudioContext', class {
    async decodeAudioData(data: ArrayBuffer) {
      if (new TextDecoder().decode(data) !== 'ok') throw new DOMException('Unable to decode audio data', 'EncodingError');
      const samples = new Float32Array(48_000 * 2).fill(0.25);
      return { sampleRate: 48_000, numberOfChannels: 1, length: samples.length, getChannelData: () => samples };
    }
  });
}

function projectWith(...recs: Recording[]): Project {
  return recs.reduce((p, r) => addRecording(p, r), createProject('Audio'));
}

describe('mixTimelineAudio', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('mixes every source that decodes', async () => {
    fakeAudio({ 'r1/mic.webm': 'ok', 'r1/sys.webm': 'ok' });
    const pcm = await mixTimelineAudio(projectWith(audioRecording('r1', { mic: 'r1/mic.webm', system: 'r1/sys.webm' })), BASE);
    expect(pcm?.[0][100]).toBeCloseTo(0.25 * 1 + 0.25 * 0.8);
  });

  it('fails the export when one audio source cannot be decoded', async () => {
    fakeAudio({ 'r1/mic.webm': 'ok', 'r1/sys.webm': 'corrupt' });
    const p = projectWith(audioRecording('r1', { mic: 'r1/mic.webm', system: 'r1/sys.webm' }));
    await expect(mixTimelineAudio(p, BASE)).rejects.toBeInstanceOf(AudioReadError);
    await expect(mixTimelineAudio(p, BASE)).rejects.toThrow('sys.webm');
  });

  it('fails the export when no audio source can be read', async () => {
    fakeAudio({});
    const p = projectWith(audioRecording('r1', { mic: 'r1/mic.webm' }));
    await expect(mixTimelineAudio(p, BASE)).rejects.toThrow('mic.webm');
  });

  it('returns no audio for a project without audio sources', async () => {
    fakeAudio({});
    await expect(mixTimelineAudio(projectWith(audioRecording('r1', {})), BASE)).resolves.toBeNull();
  });

  it('does not need a muted source', async () => {
    fakeAudio({ 'r1/mic.webm': 'ok', 'r1/sys.webm': 'corrupt' });
    const p = setAudio(projectWith(audioRecording('r1', { mic: 'r1/mic.webm', system: 'r1/sys.webm' })), { system: { muted: true } });
    const pcm = await mixTimelineAudio(p, BASE);
    expect(pcm?.[0][100]).toBeCloseTo(0.25);
  });

  it('does not need the sound of a recording that was cut out of the timeline', async () => {
    fakeAudio({ 'r1/mic.webm': 'ok', 'r2/mic.webm': 'missing' });
    const both = projectWith(audioRecording('r1', { mic: 'r1/mic.webm' }), audioRecording('r2', { mic: 'r2/mic.webm' }));
    const pcm = await mixTimelineAudio(removeTimelineRange(both, sec(2), sec(4)), BASE);
    expect(pcm?.[0][100]).toBeCloseTo(0.25);
  });
});

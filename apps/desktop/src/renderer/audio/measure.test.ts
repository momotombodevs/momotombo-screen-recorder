import { afterEach, describe, expect, it, vi } from 'vitest';
import { addRecording, createProject, setAudio, type Project, type Recording } from '@momotombo/project-model';
import { secondsToTicks as sec } from '@momotombo/timing';
import { LoudnessTracker } from './measure';

const BASE = 'app-media://p/';
const RATE = 48_000;

function recording(): Recording {
  return {
    id: 'r1', createdAt: '2026-10-16T00:00:00Z', duration: sec(4),
    sources: {
      screen: { kind: 'screen', file: 'r1/screen.webm', mime: 'video/webm', width: 1920, height: 1080, fps: 30, startOffset: 0, duration: sec(4) },
      mic: { kind: 'mic', file: 'r1/mic.webm', mime: 'audio/webm', startOffset: 0, duration: sec(4) },
    },
    capture: { backend: 'web', platform: 'test', target: { kind: 'display', label: 'Pantalla', bounds: { x: 0, y: 0, w: 1440, h: 900 }, scaleFactor: 2 }, cursorInFrames: false, hasClicks: false },
    syncOffsets: {}, markers: [],
  };
}

function fakeMic(state: 'ok' | 'corrupt' = 'ok') {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(state).buffer }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('OfflineAudioContext', class {
    async decodeAudioData(data: ArrayBuffer) {
      if (new TextDecoder().decode(data) !== 'ok') throw new DOMException('bad', 'EncodingError');
      const samples = Float32Array.from({ length: RATE * 4 }, (_, i) => 0.1 * Math.sin((2 * Math.PI * 1000 * i) / RATE));
      return { sampleRate: RATE, numberOfChannels: 1, length: samples.length, getChannelData: () => samples };
    }
  });
  return fetchMock;
}

const normalized = (): Project => setAudio(addRecording(createProject('L'), recording()), { mic: { normalize: { enabled: true } } });

async function settled(t: LoudnessTracker, p: Project) {
  t.update(p);
  await vi.waitFor(() => expect(t.get(p, 'mic').state).not.toBe('measuring'));
  return t.get(p, 'mic');
}

describe('LoudnessTracker', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('measures the mic once normalisation is on and tells its listeners', async () => {
    fakeMic();
    const t = new LoudnessTracker(BASE, 0);
    const heard = vi.fn();
    t.subscribe(heard);
    const p = normalized();
    t.update(p);
    expect(t.get(p, 'mic').state).toBe('measuring');
    const got = await settled(t, p);
    expect(got.state).toBe('measured');
    expect(got.state === 'measured' && got.lufs).toBeCloseTo(-23.01 + 3.01, 0);
    expect(heard).toHaveBeenCalled();
  });

  it('does nothing while normalisation is off', async () => {
    const fetchMock = fakeMic();
    const t = new LoudnessTracker(BASE, 0);
    const p = addRecording(createProject('L'), recording());
    t.update(p);
    await new Promise((r) => setTimeout(r, 10));
    expect(t.get(p, 'mic').state).toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-measures when the chain changes and answers at once after undo, decoding the file only once', async () => {
    const fetchMock = fakeMic();
    const t = new LoudnessTracker(BASE, 0);
    const before = normalized();
    const first = await settled(t, before);
    const changed = setAudio(before, { mic: { compressor: { enabled: true, thresholdDb: -40, ratio: 10 } } });
    const second = await settled(t, changed);
    expect(second.state === 'measured' && first.state === 'measured' && second.lufs! < first.lufs!).toBe(true);
    t.update(before);
    expect(t.get(before, 'mic')).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a source it cannot read', async () => {
    fakeMic('corrupt');
    const t = new LoudnessTracker(BASE, 0);
    expect((await settled(t, normalized())).state).toBe('failed');
  });
});

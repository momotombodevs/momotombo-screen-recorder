import { afterEach, describe, expect, it, vi } from 'vitest';
import { deepMerge, defaultAudio, type AudioMix, type DeepPartial } from '@momotombo/project-model';
import { PreviewAudio } from './preview-audio';
import { softLimit } from './voice-chain';

class FakeNode {
  out = new Set<FakeNode>();
  connect(n: FakeNode) { this.out.add(n); return n; }
  disconnect() { this.out.clear(); }
}
class FakeGain extends FakeNode { gain = { value: 1 }; }
class FakeShaper extends FakeNode { curve: Float32Array | null = null; }
class FakeWorklet extends FakeNode {
  posted: unknown[] = [];
  port = { postMessage: (m: unknown) => this.posted.push(m) };
}
const worklets: FakeWorklet[] = [];
class FakeContext {
  state = 'suspended';
  destination = new FakeNode();
  createGain() { return new FakeGain(); }
  createWaveShaper() { return new FakeShaper(); }
  createMediaElementSource() { return new FakeNode(); }
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => undefined);
}

const el = () => ({ volume: 1, muted: false }) as unknown as HTMLMediaElement;
const mix = (patch: DeepPartial<AudioMix> = {}) => deepMerge<AudioMix>(defaultAudio(), patch);

function setup() {
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', class extends FakeWorklet { constructor() { super(); worklets.push(this); } });
  let ready!: () => void;
  const audio = new PreviewAudio(() => new Promise<void>((r) => { ready = r; }));
  const mic = el();
  audio.attach(mic, 'mic');
  const route = (audio as unknown as { routes: Map<HTMLMediaElement, { source: FakeNode; chain: FakeWorklet | null; gain: FakeGain }> }).routes.get(mic)!;
  return { audio, mic, route, ready: async () => { ready(); await Promise.resolve(); await Promise.resolve(); } };
}

describe('PreviewAudio', () => {
  afterEach(() => { vi.unstubAllGlobals(); worklets.length = 0; });

  it('plays a gain above 100% through a gain node, with the element at full volume', () => {
    const { audio, mic, route } = setup();
    audio.update(mix({ mic: { gain: 2.5 } }), [[mic, 'mic']]);
    expect(route.gain.gain.value).toBe(2.5);
    expect(mic.volume).toBe(1);
    expect([...route.source.out]).toEqual([route.gain]);
  });

  it('adds the normalisation gain from the stored loudness', () => {
    const { audio, mic, route } = setup();
    audio.update(mix({ mic: { normalize: { enabled: true, targetLufs: -16, measuredLufs: -26 } } }), [[mic, 'mic']]);
    expect(route.gain.gain.value).toBeCloseTo(10 ** 0.5);
  });

  it('keeps mute on the element', () => {
    const { audio, mic } = setup();
    audio.update(mix({ mic: { muted: true } }), [[mic, 'mic']]);
    expect(mic.muted).toBe(true);
  });

  it('routes through the voice chain once its worklet is loaded, and out again when turned off', async () => {
    const { audio, mic, route, ready } = setup();
    audio.update(mix({ mic: { highpassHz: 80 } }), [[mic, 'mic']]);
    expect(route.chain).toBeNull();
    await ready();
    expect(route.chain).toBe(worklets[0]);
    expect([...route.source.out]).toEqual([worklets[0]]);
    expect([...worklets[0]!.out]).toEqual([route.gain]);
    expect(worklets[0]!.posted.at(-1)).toMatchObject({ highpassHz: 80 });
    audio.update(mix(), [[mic, 'mic']]);
    expect(route.chain).toBeNull();
    expect([...route.source.out]).toEqual([route.gain]);
  });

  it('limits the summed preview with the same curve as the export', () => {
    const { audio } = setup();
    const ctx = (audio as unknown as { ctx: FakeContext }).ctx;
    const input = (audio as unknown as { input: FakeGain }).input;
    const shaper = [...input.out][0] as FakeShaper;
    expect([...shaper.out]).toEqual([ctx.destination]);
    const curve = shaper.curve!;
    const at = (x: number) => curve[Math.round(((x * input.gain.value + 1) / 2) * (curve.length - 1))]!;
    for (const x of [0.5, 0.95, 1.2, 2]) expect(at(x)).toBeCloseTo(softLimit(x), 3);
  });

  it('resumes a suspended context when playback starts', () => {
    const { audio } = setup();
    audio.resume();
    expect((audio as unknown as { ctx: FakeContext }).ctx.resume).toHaveBeenCalled();
  });

  it('falls back to the element volume, capped at 1, without Web Audio', () => {
    const audio = new PreviewAudio();
    const mic = el();
    audio.attach(mic, 'mic');
    audio.update(mix({ mic: { gain: 2 } }), [[mic, 'mic']]);
    expect(mic.volume).toBe(1);
    audio.update(mix({ mic: { gain: 0.4 } }), [[mic, 'mic']]);
    expect(mic.volume).toBe(0.4);
  });
});

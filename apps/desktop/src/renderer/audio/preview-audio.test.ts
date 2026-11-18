import { afterEach, describe, expect, it, vi } from 'vitest';
import { deepMerge, defaultAudio, type AudioMix, type DeepPartial } from '@momotombo/project-model';
import { PreviewAudio } from './preview-audio';
import { softLimit } from './voice-chain';

class FakeNode {
  out = new Set<FakeNode>();
  connect(n: FakeNode) { this.out.add(n); return n; }
  disconnect() { this.out.clear(); }
}
class FakeGain extends FakeNode { gain = { value: 1, setTargetAtTime(v: number) { this.value = v; } }; }
class FakeShaper extends FakeNode { curve: Float32Array | null = null; }
class FakeWorklet extends FakeNode {
  posted: unknown[] = [];
  port = { postMessage: (m: unknown) => this.posted.push(m) };
}
const worklets: FakeWorklet[] = [];
class FakeContext {
  state = 'suspended';
  currentTime = 0;
  baseLatency = 0.01;
  outputLatency = 0.03;
  destination = new FakeNode();
  createGain() { return new FakeGain(); }
  createWaveShaper() { return new FakeShaper(); }
  createMediaElementSource() { return new FakeNode(); }
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => undefined);
}

const el = () => ({ volume: 1, muted: false }) as unknown as HTMLMediaElement;
const mix = (patch: DeepPartial<AudioMix> = {}) => deepMerge<AudioMix>(defaultAudio(), patch);

const silent = () => null;

function setup(onStatus = () => undefined) {
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', class extends FakeWorklet { constructor() { super(); worklets.push(this); } });
  let ready!: () => void;
  let fail!: (e: Error) => void;
  const audio = new PreviewAudio(onStatus, () => new Promise<void>((r, j) => { ready = r; fail = j; }));
  const mic = el();
  audio.attach(mic, 'mic');
  const route = (audio as unknown as { routes: Map<HTMLMediaElement, { source: FakeNode; chain: FakeWorklet | null; gain: FakeGain }> }).routes.get(mic)!;
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  return { audio, mic, route, ready: async () => { ready(); await flush(); }, fail: async () => { fail(new Error('blocked')); await flush(); } };
}

describe('PreviewAudio', () => {
  afterEach(() => { vi.unstubAllGlobals(); worklets.length = 0; });

  it('plays a gain above 100% through a gain node, with the element at full volume', () => {
    const { audio, mic, route } = setup();
    audio.update(mix({ mic: { gain: 2.5 } }), [[mic, 'mic']], silent);
    expect(route.gain.gain.value).toBe(2.5);
    expect(mic.volume).toBe(1);
    expect([...route.source.out]).toEqual([route.gain]);
  });

  it('adds the normalisation gain from the stored loudness', () => {
    const { audio, mic, route } = setup();
    audio.update(mix({ mic: { normalize: { enabled: true, targetLufs: -16 } } }), [[mic, 'mic']], (k) => (k === 'mic' ? -26 : null));
    expect(route.gain.gain.value).toBeCloseTo(10 ** 0.5);
  });

  it('keeps mute on the element', () => {
    const { audio, mic } = setup();
    audio.update(mix({ mic: { muted: true } }), [[mic, 'mic']], silent);
    expect(mic.muted).toBe(true);
  });

  it('routes through the voice chain once its worklet is loaded, and out again when turned off', async () => {
    const { audio, mic, route, ready } = setup();
    audio.update(mix({ mic: { highpassHz: 80 } }), [[mic, 'mic']], silent);
    expect(route.chain).toBeNull();
    await ready();
    expect(route.chain).toBe(worklets[0]);
    expect([...route.source.out]).toEqual([worklets[0]]);
    expect([...worklets[0]!.out]).toEqual([route.gain]);
    expect(worklets[0]!.posted.at(-1)).toMatchObject({ highpassHz: 80 });
    audio.update(mix(), [[mic, 'mic']], silent);
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

  it('lets playback wait until a suspended context runs, and not when it already runs', async () => {
    const { audio } = setup();
    const started = audio.resume();
    expect(started).toBeInstanceOf(Promise);
    await started;
    expect(audio.resume()).toBeNull();
  });

  it('reports the output latency of routed elements only', () => {
    const { audio, mic } = setup();
    expect(audio.latency(mic)).toBeCloseTo(0.04);
    expect(audio.latency(el())).toBe(0);
  });

  it('says so when the voice chain cannot run in the preview', async () => {
    const onStatus = vi.fn();
    const { audio, mic, route, fail } = setup(onStatus);
    audio.update(mix({ mic: { highpassHz: 80 } }), [[mic, 'mic']], silent);
    await fail();
    expect(audio.enhancementUnavailable).toBe(true);
    expect(onStatus).toHaveBeenCalled();
    expect([...route.source.out]).toEqual([route.gain]);
  });

  it('falls back to the element volume, capped at 1, without Web Audio', () => {
    const audio = new PreviewAudio();
    const mic = el();
    audio.attach(mic, 'mic');
    audio.update(mix({ mic: { gain: 2 } }), [[mic, 'mic']], silent);
    expect(mic.volume).toBe(1);
    audio.update(mix({ mic: { gain: 0.4 } }), [[mic, 'mic']], silent);
    expect(mic.volume).toBe(0.4);
  });
});

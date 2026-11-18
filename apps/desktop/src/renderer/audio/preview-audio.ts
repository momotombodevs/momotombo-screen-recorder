import type { AudioMix } from '@momotombo/project-model';
import { VOICE_PROCESSOR, channelGain, isPlain, softLimit, type ChainSettings } from './voice-chain';

type Kind = keyof AudioMix;

interface Route {
  kind: Kind;
  source: MediaElementAudioSourceNode;
  chain: AudioWorkletNode | null;
  gain: GainNode;
}

const LIMIT_RANGE = 4;
const CURVE_POINTS = 8193;
const RATE = 48_000;

function limiterCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i++) curve[i] = softLimit(((i / (CURVE_POINTS - 1)) * 2 - 1) * LIMIT_RANGE);
  return curve;
}

const settingsOf = (c: AudioMix[Kind]): ChainSettings => ({ highpassHz: c.highpassHz, compressor: c.compressor, gate: c.gate });

/**
 * Preview sound through Web Audio, so a gain above 100% (HTMLMediaElement.volume stops at 1) and
 * the voice chain are heard as the export will write them: element → voice chain worklet → gain →
 * the export's soft limiter → speakers. Without Web Audio the element volume is used, capped at 1.
 */
export class PreviewAudio {
  private ctx: AudioContext | null = null;
  private input: GainNode | null = null;
  private routes = new Map<HTMLMediaElement, Route>();
  private worklet: 'loading' | 'ready' | 'failed' | null = null;
  private mix: AudioMix | null = null;

  constructor(private readonly loadWorklet: (ctx: AudioContext) => Promise<void> = defaultWorklet) {}

  private context(): AudioContext | null {
    if (this.ctx || typeof AudioContext === 'undefined') return this.ctx;
    const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
    const input = ctx.createGain();
    input.gain.value = 1 / LIMIT_RANGE;
    const shaper = ctx.createWaveShaper();
    shaper.curve = limiterCurve();
    input.connect(shaper).connect(ctx.destination);
    this.ctx = ctx;
    this.input = input;
    return ctx;
  }

  attach(el: HTMLMediaElement, kind: Kind): void {
    const ctx = this.context();
    if (!ctx || !this.input || this.routes.has(el)) return;
    const gain = ctx.createGain();
    gain.connect(this.input);
    const route: Route = { kind, source: ctx.createMediaElementSource(el), chain: null, gain };
    route.source.connect(gain);
    this.routes.set(el, route);
    if (this.mix) this.apply(el, route, this.mix);
  }

  release(el: HTMLMediaElement): void {
    const r = this.routes.get(el);
    if (!r) return;
    r.source.disconnect();
    r.chain?.disconnect();
    r.gain.disconnect();
    this.routes.delete(el);
  }

  update(mix: AudioMix, elements: Iterable<[HTMLMediaElement, Kind]>): void {
    this.mix = mix;
    for (const [el, kind] of elements) {
      const r = this.routes.get(el);
      if (r) this.apply(el, r, mix);
      else el.volume = Math.min(1, mix[kind].gain);
      el.muted = mix[kind].muted;
    }
  }

  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  dispose(): void {
    for (const el of [...this.routes.keys()]) this.release(el);
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.input = null;
  }

  private apply(el: HTMLMediaElement, r: Route, mix: AudioMix): void {
    const ch = mix[r.kind];
    el.volume = 1;
    r.gain.gain.value = channelGain(ch, ch.normalize.measuredLufs);
    const settings = settingsOf(ch);
    if (isPlain(settings)) {
      if (r.chain) this.rewire(r, null);
      return;
    }
    if (this.worklet !== 'ready') {
      this.ensureWorklet();
      return;
    }
    if (!r.chain) this.rewire(r, new AudioWorkletNode(this.ctx!, VOICE_PROCESSOR));
    r.chain!.port.postMessage(settings);
  }

  private rewire(r: Route, chain: AudioWorkletNode | null): void {
    r.source.disconnect();
    r.chain?.disconnect();
    r.chain = chain;
    if (chain) r.source.connect(chain).connect(r.gain);
    else r.source.connect(r.gain);
  }

  private ensureWorklet(): void {
    if (this.worklet || !this.ctx) return;
    this.worklet = 'loading';
    this.loadWorklet(this.ctx).then(
      () => {
        this.worklet = 'ready';
        if (this.mix) for (const [el, r] of this.routes) this.apply(el, r, this.mix);
      },
      (err: unknown) => {
        this.worklet = 'failed';
        console.warn('Voice enhancement preview unavailable', err);
      },
    );
  }
}

async function defaultWorklet(ctx: AudioContext): Promise<void> {
  const { default: url } = await import('./voice-worklet.ts?worker&url');
  await ctx.audioWorklet.addModule(url);
}

import { AUDIO_LIMITS, type AudioChannel, type DeepPartial } from '@momotombo/project-model';

export const VOICE_PRESET = {
  highpassHz: 80,
  compressor: { enabled: true, thresholdDb: -24, ratio: 3 },
  normalize: { enabled: true, targetLufs: -16 },
} satisfies DeepPartial<AudioChannel>;

export const VOICE_PROCESSOR = 'voice-chain';

export type ChainSettings = Pick<AudioChannel, 'highpassHz' | 'compressor' | 'gate'>;

export const isPlain = (s: ChainSettings) => s.highpassHz <= 0 && !s.compressor.enabled && !s.gate.enabled;

const LIMIT_KNEE = 0.9;

export function softLimit(v: number): number {
  const a = Math.abs(v);
  if (a <= LIMIT_KNEE) return v;
  const out = LIMIT_KNEE + (1 - LIMIT_KNEE) * Math.tanh((a - LIMIT_KNEE) / (1 - LIMIT_KNEE));
  return v < 0 ? -out : out;
}


export function normalizeGainDb(n: AudioChannel['normalize'], measuredLufs: number | null): number {
  if (!n.enabled || measuredLufs === null) return 0;
  return Math.min(AUDIO_LIMITS.normalize.maxBoostDb, n.targetLufs - measuredLufs);
}

export function channelGain(ch: AudioChannel, measuredLufs: number | null): number {
  return ch.gain * 10 ** (normalizeGainDb(ch.normalize, measuredLufs) / 20);
}

const toDb = (v: number) => 20 * Math.log10(Math.max(v, 1e-12));
const coef = (ms: number, rate: number) => Math.exp(-1 / ((ms / 1000) * rate));

const GATE_ATTACK_MS = 1;
const GATE_RELEASE_MS = 60;
const GATE_HOLD_MS = 80;
const COMP_ATTACK_MS = 5;
const COMP_RELEASE_MS = 120;
const COMP_KNEE_DB = 6;

/**
 * High-pass (12 dB/octave Butterworth), noise gate and compressor, with state carried across
 * calls so the preview worklet (128-sample blocks) and the export (whole track) produce the same
 * samples. Channels share one detector, so stereo keeps its image.
 */
export class VoiceChain {
  private s!: ChainSettings;
  private hp: [number, number, number, number, number] = [1, 0, 0, 0, 0];
  private hpState: Float64Array[] = [];
  private gateEnv = 0;
  private gateGain = 1;
  private gateHold = 0;
  private compEnv = 0;
  private readonly gateAttack: number;
  private readonly gateRelease: number;
  private readonly compAttack: number;
  private readonly compRelease: number;
  private readonly holdSamples: number;

  constructor(settings: ChainSettings, private readonly rate: number) {
    this.gateAttack = coef(GATE_ATTACK_MS, rate);
    this.gateRelease = coef(GATE_RELEASE_MS, rate);
    this.compAttack = coef(COMP_ATTACK_MS, rate);
    this.compRelease = coef(COMP_RELEASE_MS, rate);
    this.holdSamples = Math.round((GATE_HOLD_MS / 1000) * rate);
    this.configure(settings);
  }

  configure(settings: ChainSettings): void {
    if (!(this.s?.highpassHz > 0)) this.hpState = [];
    this.s = settings;
    if (settings.highpassHz <= 0) return;
    const w0 = (2 * Math.PI * Math.min(settings.highpassHz, this.rate * 0.45)) / this.rate;
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha;
    this.hp = [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
  }

  process(sides: Float32Array[]): void {
    const { highpassHz, gate, compressor } = this.s;
    const channels = [...new Set(sides)];
    if (isPlain(this.s) || channels.length === 0) return;
    if (highpassHz > 0) channels.forEach((c, i) => this.highpass(c, i));
    if (!gate.enabled && !compressor.enabled) return;
    const n = channels[0]!.length;
    const t = compressor.thresholdDb;
    const slope = 1 / compressor.ratio - 1;
    for (let i = 0; i < n; i++) {
      let level = 0;
      for (const c of channels) level = Math.max(level, Math.abs(c[i]!));
      let g = 1;
      if (gate.enabled) {
        const a = level > this.gateEnv ? this.gateAttack : this.gateRelease;
        this.gateEnv = a * this.gateEnv + (1 - a) * level;
        if (toDb(this.gateEnv) > gate.thresholdDb) this.gateHold = this.holdSamples;
        else if (this.gateHold > 0) this.gateHold--;
        const open = this.gateHold > 0 ? 1 : 0;
        const k = open > this.gateGain ? this.gateAttack : this.gateRelease;
        this.gateGain = k * this.gateGain + (1 - k) * open;
        g *= this.gateGain;
      }
      if (compressor.enabled) {
        const a = level > this.compEnv ? this.compAttack : this.compRelease;
        this.compEnv = a * this.compEnv + (1 - a) * level;
        const over = toDb(this.compEnv) - t;
        let reductionDb = 0;
        if (2 * over > COMP_KNEE_DB) reductionDb = slope * over;
        else if (2 * over > -COMP_KNEE_DB) reductionDb = (slope * (over + COMP_KNEE_DB / 2) ** 2) / (2 * COMP_KNEE_DB);
        g *= 10 ** (reductionDb / 20);
      }
      for (const c of channels) c[i] = c[i]! * g;
    }
  }

  private highpass(c: Float32Array, ch: number): void {
    const [b0, b1, b2, a1, a2] = this.hp;
    const st = (this.hpState[ch] ??= new Float64Array(4));
    let x1 = st[0]!, x2 = st[1]!, y1 = st[2]!, y2 = st[3]!;
    for (let i = 0; i < c.length; i++) {
      const x = c[i]!;
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      c[i] = y;
    }
    st[0] = x1; st[1] = x2; st[2] = y1; st[3] = y2;
  }
}

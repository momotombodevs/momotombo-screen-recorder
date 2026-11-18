import { describe, expect, it } from 'vitest';
import { deepMerge, defaultAudio, type AudioChannel, type DeepPartial } from '@momotombo/project-model';
import { VoiceChain, isPlain, normalizeGainDb, softLimit, VOICE_PRESET } from './voice-chain';

const RATE = 48_000;
const sine = (hz: number, seconds: number, amp = 1) =>
  Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / RATE));
const peak = (x: Float32Array, from = 0) => x.subarray(from).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const channel = (patch: DeepPartial<AudioChannel>): AudioChannel => deepMerge<AudioChannel>(defaultAudio().mic, patch);
const run = (ch: AudioChannel, ...signals: Float32Array[]) => {
  const out = signals.map((s) => s.slice());
  new VoiceChain(ch, RATE).process(out);
  return out;
};

describe('softLimit', () => {
  it('leaves levels up to the 0.9 knee untouched', () => {
    for (const v of [0, 0.1, -0.5, 0.85, -0.9]) expect(softLimit(v)).toBe(v);
  });

  it('bends levels between the knee and full scale slightly (a change from the old pass-through)', () => {
    expect(softLimit(0.95)).toBeGreaterThan(0.945);
    expect(softLimit(0.95)).toBeLessThan(0.95);
    expect(softLimit(1)).toBeCloseTo(0.976, 3);
  });

  it('is continuous and monotonic across the knee and never reaches past full scale', () => {
    let prev = 0;
    for (let v = 0; v <= 4; v += 0.0005) {
      const y = softLimit(v);
      expect(y).toBeGreaterThanOrEqual(prev);
      expect(y - prev).toBeLessThan(0.001);
      expect(y).toBeLessThanOrEqual(1);
      expect(softLimit(-v)).toBe(-y);
      prev = y;
    }
  });

  it('does not drop a sample just over full scale (the old tanh jump)', () => {
    expect(softLimit(1.0001)).toBeGreaterThan(0.95);
  });
});

describe('VoiceChain', () => {
  it('passes the signal through bit for bit with the defaults', () => {
    const s = sine(440, 0.2, 0.3);
    expect(isPlain(defaultAudio().mic)).toBe(true);
    expect(run(defaultAudio().mic, s)[0]).toEqual(s);
  });

  it('high-pass removes rumble and keeps the voice', () => {
    const ch = channel({ highpassHz: 80 });
    expect(peak(run(ch, sine(20, 1))[0]!, RATE / 2)).toBeLessThan(0.08);
    expect(peak(run(ch, sine(1000, 1))[0]!, RATE / 2)).toBeGreaterThan(0.98);
  });

  it('compressor turns loud parts down by the ratio above the threshold', () => {
    const ch = channel({ compressor: { enabled: true, thresholdDb: -20, ratio: 4 } });
    const loud = peak(run(ch, sine(1000, 1, 1))[0]!, RATE / 2);
    expect(Math.abs(20 * Math.log10(loud) - (-20 + 20 / 4))).toBeLessThan(1);
    const quiet = peak(run(ch, sine(1000, 1, 0.01))[0]!, RATE / 2);
    expect(quiet).toBeCloseTo(0.01, 3);
  });

  it('gate silences sound below its threshold and keeps sound above', () => {
    const ch = channel({ gate: { enabled: true, thresholdDb: -40 } });
    expect(peak(run(ch, sine(1000, 1, 0.001))[0]!, RATE / 2)).toBeLessThan(1e-5);
    expect(peak(run(ch, sine(1000, 1, 0.5))[0]!, RATE / 2)).toBeCloseTo(0.5, 2);
  });

  it('processes a mono source shared by both sides once', () => {
    const ch = channel(VOICE_PRESET);
    const shared = sine(300, 0.5, 0.8);
    new VoiceChain(ch, RATE).process([shared, shared]);
    expect(shared).toEqual(run(ch, sine(300, 0.5, 0.8))[0]);
  });

  it('starts the high-pass fresh when it is turned back on', () => {
    const chain = new VoiceChain(channel({ highpassHz: 100 }), RATE);
    chain.process([sine(50, 0.2, 1)]);
    chain.configure(channel({}));
    chain.process([sine(50, 0.2, 1)]);
    chain.configure(channel({ highpassHz: 100 }));
    const silence = new Float32Array(256);
    chain.process([silence]);
    expect(peak(silence)).toBe(0);
  });

  it('processes stereo with one linked gain', () => {
    const ch = channel({ compressor: { enabled: true, thresholdDb: -20, ratio: 4 } });
    const [l, r] = run(ch, sine(1000, 1, 1), sine(1000, 1, 0.1));
    expect(peak(l!, RATE / 2) / peak(r!, RATE / 2)).toBeCloseTo(10, 1);
  });

  it('gives the same output in one block or in 128-sample blocks (preview worklet)', () => {
    const ch = channel(VOICE_PRESET);
    const s = sine(300, 0.5, 0.8);
    const whole = run(ch, s)[0]!;
    const blocks = s.slice();
    const chain = new VoiceChain(ch, RATE);
    for (let i = 0; i < blocks.length; i += 128) chain.process([blocks.subarray(i, i + 128)]);
    expect(blocks).toEqual(whole);
  });
});

describe('normalizeGainDb', () => {
  it('reaches the target from the measured loudness', () => {
    expect(normalizeGainDb({ enabled: true, targetLufs: -16 }, -26)).toBeCloseTo(10);
  });

  it('is 0 dB when off or not measured', () => {
    expect(normalizeGainDb({ enabled: false, targetLufs: -16 }, -26)).toBe(0);
    expect(normalizeGainDb({ enabled: true, targetLufs: -16 }, null)).toBe(0);
  });

  it('never boosts by more than 20 dB, so a near-silent track does not turn into hiss', () => {
    expect(normalizeGainDb({ enabled: true, targetLufs: -16 }, -90)).toBe(20);
  });

  it('turns a loud track down without limit', () => {
    expect(normalizeGainDb({ enabled: true, targetLufs: -16 }, 0)).toBe(-16);
  });
});

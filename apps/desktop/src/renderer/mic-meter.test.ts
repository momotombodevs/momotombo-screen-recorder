import { describe, expect, it } from 'vitest';
import { measure, meterFraction, MicMeter, toDbfs } from './mic-meter';

const tone = (amplitude: number, n = 1024) => Float32Array.from({ length: n }, (_, i) => amplitude * Math.sin((i / n) * Math.PI * 16));

describe('measure', () => {
  it('returns linear RMS and the absolute peak', () => {
    const r = measure(Float32Array.from([0.5, -0.5, 0.5, -1]));
    expect(r.peak).toBe(1);
    expect(r.rms).toBeCloseTo(Math.sqrt((0.25 * 3 + 1) / 4));
  });
});

describe('dB scale', () => {
  it('maps full scale to 0 dBFS and silence to the floor', () => {
    expect(toDbfs(1)).toBe(0);
    expect(toDbfs(0.5)).toBeCloseTo(-6.02, 1);
    expect(toDbfs(0)).toBe(-90);
  });

  it('does not saturate a level at -12 dBFS', () => {
    const at12 = meterFraction(toDbfs(10 ** (-12 / 20)));
    expect(at12).toBeGreaterThan(0.5);
    expect(at12).toBeLessThan(0.9);
    expect(meterFraction(0)).toBe(1);
    expect(meterFraction(-60)).toBe(0);
    expect(meterFraction(-90)).toBe(0);
  });
});

describe('MicMeter', () => {
  it('holds the peak, then lets it fall', () => {
    const m = new MicMeter();
    const loud = measure(tone(0.5));
    const quiet = measure(tone(0.01));
    const first = m.push(loud, 0);
    expect(m.push(quiet, 500).hold).toBe(first.hold);
    expect(m.push(quiet, 1000).level).toBeLessThan(first.hold);
    expect(m.push(quiet, 4000).hold).toBeLessThan(first.hold);
  });

  it('flags clipping when samples reach full scale, and clears it after a while', () => {
    const m = new MicMeter();
    expect(m.push(measure(tone(0.5)), 0).clipping).toBe(false);
    expect(m.push(measure(tone(1)), 100).clipping).toBe(true);
    expect(m.push(measure(tone(0.5)), 1000).clipping).toBe(true);
    expect(m.push(measure(tone(0.5)), 4000).clipping).toBe(false);
  });

  it('warns about a silent microphone only after 5 s under -60 dBFS', () => {
    const m = new MicMeter();
    const silence = { rms: 0.0005, peak: 0.001 };
    expect(m.push(silence, 0).silent).toBe(false);
    expect(m.push(silence, 4900).silent).toBe(false);
    expect(m.push(silence, 5000).silent).toBe(true);
    expect(m.push(measure(tone(0.1)), 5100).silent).toBe(false);
    expect(m.push(silence, 6000).silent).toBe(false);
  });
});

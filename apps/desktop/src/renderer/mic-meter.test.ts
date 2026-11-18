import { describe, expect, it } from 'vitest';
import { measure, meterFraction, meterSink, MicMeter, toDbfs, windowCovering } from './mic-meter';

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

  it('keeps the warning through brief noise and clears it once sound is back for a moment', () => {
    const m = new MicMeter();
    const silence = { rms: 0.0005, peak: 0.001 };
    const murmur = { rms: 10 ** (-58 / 20), peak: 0.01 };
    const speech = measure(tone(0.1));
    let t = 0;
    for (; t <= 5000; t += 250) m.push(silence, t);
    expect(m.push(silence, t).silent).toBe(true);
    expect(m.push(murmur, (t += 250)).silent).toBe(true);
    expect(m.push(speech, (t += 250)).silent).toBe(true);
    expect(m.push(silence, (t += 250)).silent).toBe(true);
    expect(m.push(speech, (t += 250)).silent).toBe(true);
    expect(m.push(speech, (t += 250)).silent).toBe(true);
    expect(m.push(speech, (t += 250)).silent).toBe(false);
  });

  it('does not warn during natural pauses in speech', () => {
    const m = new MicMeter();
    const silence = { rms: 0.0005, peak: 0.001 };
    const speech = measure(tone(0.1));
    let t = 0;
    for (let cycle = 0; cycle < 6; cycle++) {
      for (let i = 0; i < 16; i++) expect(m.push(silence, (t += 250)).silent).toBe(false);
      expect(m.push(speech, (t += 250)).silent).toBe(false);
    }
  });

  it('warns about a silent microphone only after 5 s under -60 dBFS', () => {
    const m = new MicMeter();
    const silence = { rms: 0.0005, peak: 0.001 };
    expect(m.push(silence, 0).silent).toBe(false);
    expect(m.push(silence, 4900).silent).toBe(false);
    expect(m.push(silence, 5000).silent).toBe(true);
    expect(m.push(silence, 6000).silent).toBe(true);
  });
});

describe('windowCovering', () => {
  it('reads at least every sample between two reads', () => {
    for (const rate of [44_100, 48_000, 96_000]) {
      for (const interval of [50, 120]) {
        const size = windowCovering(rate, interval);
        expect(size).toBeGreaterThanOrEqual((rate * interval) / 1000);
        expect(Math.log2(size) % 1).toBe(0);
        expect(size).toBeLessThanOrEqual(32768);
      }
    }
  });
});

describe('meterSink', () => {
  const target = () => {
    const attrs: Record<string, string> = {};
    return {
      fill: { style: { clipPath: '' } },
      hold: { style: { left: '' } },
      bar: { setAttribute: (k: string, v: string) => { attrs[k] = v; } },
      attrs,
    };
  };

  it('moves the meter on every reading but asks for a re-render only when a flag changes', () => {
    const el = target();
    const fills = new Set<string>();
    let renders = 0;
    const push = meterSink(new MicMeter(), () => el, () => { renders++; });
    for (let i = 0; i < 600; i++) {
      push(measure(tone(0.05 + 0.4 * Math.abs(Math.sin(i / 7)))), i * 16);
      fills.add(el.fill.style.clipPath);
    }
    expect(fills.size).toBeGreaterThan(50);
    expect(renders).toBe(0);
    expect(Number(el.attrs['aria-valuenow'])).toBeLessThan(0);
  });

  it('asks for one re-render when clipping starts and one when it ends', () => {
    const el = target();
    const flags: { clipping: boolean; silent: boolean }[] = [];
    const push = meterSink(new MicMeter(), () => el, (f) => flags.push(f));
    for (let t = 0; t < 1000; t += 16) push(measure(tone(0.3)), t);
    push(measure(tone(1)), 1000);
    for (let t = 1016; t < 5000; t += 16) push(measure(tone(0.3)), t);
    expect(flags).toEqual([{ clipping: true, silent: false }, { clipping: false, silent: false }]);
  });
});

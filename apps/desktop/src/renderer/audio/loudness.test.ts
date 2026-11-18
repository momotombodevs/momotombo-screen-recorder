import { describe, expect, it } from 'vitest';
import { integratedLoudness } from './loudness';

const sine = (hz: number, seconds: number, amp = 1, rate = 48_000) =>
  Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

describe('integratedLoudness (ITU-R BS.1770)', () => {
  it('measures a full-scale 1 kHz sine at -3.01 LUFS in mono', () => {
    expect(integratedLoudness([sine(1000, 5)], 48_000)).toBeCloseTo(-3.01, 1);
  });

  it('adds 3 LU for the same sine on both stereo channels', () => {
    const s = sine(1000, 5);
    expect(integratedLoudness([s, s], 48_000)).toBeCloseTo(0, 1);
  });

  it('follows the level: -20 dB is 20 LU quieter', () => {
    expect(integratedLoudness([sine(1000, 5, 0.1)], 48_000)).toBeCloseTo(-23.01, 1);
  });

  it('gives the same answer at 44.1 kHz', () => {
    expect(integratedLoudness([sine(1000, 5, 1, 44_100)], 44_100)).toBeCloseTo(-3.01, 1);
  });

  it('weights low frequencies down (K-weighting)', () => {
    expect(integratedLoudness([sine(40, 5)], 48_000)!).toBeLessThan(-3.5);
  });

  it('ignores silence through the gates', () => {
    const s = new Float32Array(48_000 * 10);
    s.set(sine(1000, 5, 0.1), 0);
    const measured = integratedLoudness([s], 48_000)!;
    expect(measured).toBeGreaterThan(-23.2);
    expect(measured).toBeLessThan(-22.9);
  });

  it('is null when nothing passes the absolute gate', () => {
    expect(integratedLoudness([new Float32Array(48_000 * 2)], 48_000)).toBeNull();
    expect(integratedLoudness([new Float32Array(100)], 48_000)).toBeNull();
  });
});

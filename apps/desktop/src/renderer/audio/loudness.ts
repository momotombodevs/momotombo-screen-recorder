type Coefs = [b0: number, b1: number, b2: number, a1: number, a2: number];

function kWeightingShelfThenHighpass(rate: number): [Coefs, Coefs] {
  const shelfF = 1681.974450955533;
  const shelfG = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  let k = Math.tan((Math.PI * shelfF) / rate);
  const vh = 10 ** (shelfG / 20);
  const vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / shelfQ + k * k;
  const shelf: Coefs = [
    (vh + (vb * k) / shelfQ + k * k) / a0,
    (2 * (k * k - vh)) / a0,
    (vh - (vb * k) / shelfQ + k * k) / a0,
    (2 * (k * k - 1)) / a0,
    (1 - k / shelfQ + k * k) / a0,
  ];
  const hpF = 38.13547087602444;
  const hpQ = 0.5003270373238773;
  k = Math.tan((Math.PI * hpF) / rate);
  a0 = 1 + k / hpQ + k * k;
  const highpass: Coefs = [1, -2, 1, (2 * (k * k - 1)) / a0, (1 - k / hpQ + k * k) / a0];
  return [shelf, highpass];
}

const ABSOLUTE_GATE = -70;
const RELATIVE_GATE = -10;
const lufs = (power: number) => -0.691 + 10 * Math.log10(power);

class Biquad {
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(private readonly c: Coefs) {}
  step(x: number): number {
    const [b0, b1, b2, a1, a2] = this.c;
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/**
 * Integrated loudness (ITU-R BS.1770-4) fed block by block, so a long track never needs to be
 * held or copied. Every channel carries weight 1 (mono, or left and right); the same array passed
 * twice (a mono source on both sides) is filtered once and counted twice. K-weighting, 400 ms
 * blocks every 100 ms, absolute gate at -70 LUFS, relative gate 10 LU below. result() is null
 * when no block passes the gates (silence, or shorter than one block).
 */
export class LoudnessMeter {
  private readonly step: number;
  private readonly filters: [Biquad, Biquad][] = [];
  private readonly stepPower: number[] = [];
  private pos = 0;

  constructor(private readonly rate: number) {
    this.step = Math.round(rate * 0.1);
  }

  push(channels: readonly Float32Array[]): void {
    const weights = new Map<Float32Array, number>();
    for (const c of channels) weights.set(c, (weights.get(c) ?? 0) + 1);
    let k = 0;
    let n = 0;
    for (const [c, w] of weights) {
      const [shelf, highpass] = (this.filters[k++] ??= kWeightingShelfThenHighpass(this.rate).map((c) => new Biquad(c)) as [Biquad, Biquad]);
      n = c.length;
      for (let i = 0; i < n; i++) {
        const y = highpass.step(shelf.step(c[i]!));
        const s = Math.floor((this.pos + i) / this.step);
        this.stepPower[s] = (this.stepPower[s] ?? 0) + w * y * y;
      }
    }
    this.pos += n;
  }

  result(): number | null {
    const steps = Math.floor(this.pos / this.step);
    const blocks: number[] = [];
    for (let b = 0; b + 4 <= steps; b++) {
      let sum = 0;
      for (let j = b; j < b + 4; j++) sum += this.stepPower[j] ?? 0;
      blocks.push(sum / (this.step * 4));
    }
    const mean = (xs: number[]) => xs.reduce((a, v) => a + v, 0) / xs.length;
    const loud = blocks.filter((p) => p > 0 && lufs(p) > ABSOLUTE_GATE);
    if (loud.length === 0) return null;
    const relative = lufs(mean(loud)) + RELATIVE_GATE;
    return lufs(mean(loud.filter((p) => lufs(p) > relative)));
  }
}

export function integratedLoudness(channels: readonly Float32Array[], rate: number): number | null {
  const meter = new LoudnessMeter(rate);
  meter.push(channels);
  return meter.result();
}

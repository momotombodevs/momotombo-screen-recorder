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

function filtered(x: Float32Array, stages: Coefs[]): Float64Array {
  const y = Float64Array.from(x);
  for (const [b0, b1, b2, a1, a2] of stages) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = y[i]!;
      const out = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = out;
      y[i] = out;
    }
  }
  return y;
}

const ABSOLUTE_GATE = -70;
const RELATIVE_GATE = -10;
const lufs = (power: number) => -0.691 + 10 * Math.log10(power);

/**
 * Integrated loudness (ITU-R BS.1770-4) of channels that each carry weight 1 (mono, or left and
 * right): K-weighting, 400 ms blocks every 100 ms, absolute gate at -70 LUFS, relative gate 10 LU
 * below. Null when no block passes the gates (silence, or shorter than one block).
 */
export function integratedLoudness(channels: readonly Float32Array[], rate: number): number | null {
  const stages = kWeightingShelfThenHighpass(rate);
  const weighted = channels.map((c) => filtered(c, stages));
  const step = Math.round(rate * 0.1);
  const size = step * 4;
  const length = weighted[0]?.length ?? 0;
  const stepPower: number[] = [];
  for (let s = 0; s + step <= length; s += step) {
    let sum = 0;
    for (const c of weighted) for (let i = s; i < s + step; i++) sum += c[i]! * c[i]!;
    stepPower.push(sum);
  }
  const blocks: number[] = [];
  for (let b = 0; b + 4 <= stepPower.length; b++) {
    blocks.push((stepPower[b]! + stepPower[b + 1]! + stepPower[b + 2]! + stepPower[b + 3]!) / size);
  }
  const mean = (xs: number[]) => xs.reduce((a, v) => a + v, 0) / xs.length;
  const loud = blocks.filter((p) => p > 0 && lufs(p) > ABSOLUTE_GATE);
  if (loud.length === 0) return null;
  const relative = lufs(mean(loud)) + RELATIVE_GATE;
  const gated = loud.filter((p) => lufs(p) > relative);
  return lufs(mean(gated));
}

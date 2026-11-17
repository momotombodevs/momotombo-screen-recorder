import { secondsToTicks, type Ticks } from '@momotombo/timing';

export type Easing =
  | { kind: 'preset'; name: 'smooth' | 'fast' }
  | { kind: 'bezier'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'spring'; zeta: number; omega: number }
  | { kind: 'linear' }
  | { kind: 'instant' };

export interface Transition {
  duration: Ticks;
  easing: Easing;
}

/** Our own preset curves (values chosen for this product, tuned by testing). */
export const PRESET_CURVES = {
  smooth: { x1: 0.4, y1: 0, x2: 0.2, y2: 1 },
  fast: { x1: 0.25, y1: 0, x2: 0.1, y2: 1 },
} as const;

export const PRESET_DURATIONS: Record<'smooth' | 'fast', Ticks> = {
  smooth: secondsToTicks(0.9),
  fast: secondsToTicks(0.35),
};

export function presetTransition(name: 'smooth' | 'fast'): Transition {
  return { duration: PRESET_DURATIONS[name], easing: { kind: 'preset', name } };
}

/**
 * Cubic Bézier with endpoints (0,0) and (1,1). Solves x(s) = u with Newton's method,
 * falling back to bisection, then returns y(s).
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;

  let s = u;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(s) - u;
    if (Math.abs(err) < 1e-7) return sampleY(s);
    const d = slopeX(s);
    if (Math.abs(d) < 1e-6) break;
    s -= err / d;
  }
  let lo = 0;
  let hi = 1;
  s = u;
  for (let i = 0; i < 40; i++) {
    const x = sampleX(s);
    if (Math.abs(x - u) < 1e-7) break;
    if (x < u) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return sampleY(s);
}

/** Below this the oscillation would not settle inside the transition. */
const MIN_ZETA = 0.05;
const CRITICAL_TOLERANCE = 1e-6;

const validSpring = (zeta: number, omega: number) => Number.isFinite(zeta) && Number.isFinite(omega) && omega > 0;

/** Overdamped poles: the slow one first, computed without cancellation. */
function overdampedPoles(zeta: number, omega: number): [number, number] {
  const s = Math.sqrt(zeta * zeta - 1);
  return [-omega / (zeta + s), -omega * (zeta + s)];
}

/**
 * Damped harmonic oscillator step response, x(0) = 0 → 1, time-normalized so that
 * u = 1 corresponds to the moment the response settles within 0.1 %. Parameters that
 * describe no spring (omega ≤ 0, non-finite) fall back to linear.
 */
export function springResponse(zeta: number, omega: number, u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (!validSpring(zeta, omega)) return u;
  const z = Math.max(MIN_ZETA, zeta);
  const t = u * springSettleTime(z, omega);
  if (Math.abs(z - 1) < CRITICAL_TOLERANCE) {
    return 1 - Math.exp(-omega * t) * (1 + omega * t);
  }
  if (z > 1) {
    const [r1, r2] = overdampedPoles(z, omega);
    return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
  }
  const wd = omega * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * omega * t) * (Math.cos(wd * t) + ((z * omega) / wd) * Math.sin(wd * t));
}

/** Seconds until the envelope stays within 0.1 % of the target; 0 for parameters that describe no spring. */
export function springSettleTime(zeta: number, omega: number): number {
  if (!validSpring(zeta, omega)) return 0;
  const z = Math.max(MIN_ZETA, zeta);
  if (Math.abs(z - 1) < CRITICAL_TOLERANCE) return Math.log(1000) / omega + 2 / omega;
  if (z > 1) {
    const [r1, r2] = overdampedPoles(z, omega);
    return (Math.log(1000) + Math.log(r2 / (r2 - r1))) / -r1;
  }
  return Math.log(1000) / (z * omega);
}

export function applyEasing(e: Easing, u: number): number {
  const v = u <= 0 ? 0 : u >= 1 ? 1 : u;
  switch (e.kind) {
    case 'linear':
      return v;
    case 'instant':
      return v > 0 ? 1 : 0;
    case 'preset': {
      const c = PRESET_CURVES[e.name];
      return cubicBezier(c.x1, c.y1, c.x2, c.y2, v);
    }
    case 'bezier':
      return cubicBezier(e.x1, e.y1, e.x2, e.y2, v);
    case 'spring':
      return springResponse(e.zeta, e.omega, v);
  }
}

/** Normalized progress through a transition that starts at `start`. */
export function transitionProgress(t: Ticks, start: Ticks, tr: Transition): number {
  if (tr.easing.kind === 'instant' || tr.duration <= 0) return t >= start ? 1 : 0;
  return applyEasing(tr.easing, (t - start) / tr.duration);
}

export function effectiveDuration(tr: Transition): Ticks {
  return tr.easing.kind === 'instant' ? 0 : tr.duration;
}

export interface MeterReading {
  /** Linear RMS, 0..1. */
  rms: number;
  /** Largest absolute sample, 0..1 (full scale is 1). */
  peak: number;
}

export interface MeterView {
  /** Meter positions, 0..1 on the dB scale. */
  level: number;
  hold: number;
  db: number;
  clipping: boolean;
  silent: boolean;
}

const FLOOR_DB = -90;
const RANGE_DB = 60;
const CLIP_LINEAR = 0.999;
const HOLD_MS = 1500;
const HOLD_FALL_DB_PER_S = 20;
const CLIP_SHOW_MS = 2000;
const SILENT_DB = -60;
const SILENT_AFTER_MS = 5000;

export function measure(samples: Float32Array): MeterReading {
  let sum = 0;
  let peak = 0;
  for (const v of samples) {
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return { rms: samples.length ? Math.sqrt(sum / samples.length) : 0, peak: Math.min(1, peak) };
}

export function toDbfs(linear: number): number {
  return linear > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(linear)) : FLOOR_DB;
}

export function meterFraction(db: number): number {
  return Math.min(1, Math.max(0, (db + RANGE_DB) / RANGE_DB));
}

/** Peak hold, clip and silence detection over a stream of readings. */
export class MicMeter {
  private holdDb = FLOOR_DB;
  private holdAt = 0;
  private clipAt = -Infinity;
  private quietSince: number | null = null;

  push(r: MeterReading, now: number): MeterView {
    const db = toDbfs(r.rms);
    const peakDb = toDbfs(r.peak);
    const fallen = this.holdDb - Math.max(0, now - this.holdAt - HOLD_MS) / 1000 * HOLD_FALL_DB_PER_S;
    if (peakDb >= fallen) {
      this.holdDb = peakDb;
      this.holdAt = now;
    }
    const holdDb = Math.max(peakDb, fallen);
    if (r.peak >= CLIP_LINEAR) this.clipAt = now;
    if (db >= SILENT_DB) this.quietSince = null;
    else this.quietSince ??= now;
    return {
      level: meterFraction(db),
      hold: meterFraction(holdDb),
      db,
      clipping: now - this.clipAt < CLIP_SHOW_MS,
      silent: this.quietSince !== null && now - this.quietSince >= SILENT_AFTER_MS,
    };
  }
}

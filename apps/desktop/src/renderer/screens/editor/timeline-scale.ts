import type { ID, PreparedCursor, SegmentPlacement } from '@momotombo/project-model';
import { formatTimecode, secondsToTicks } from '@momotombo/timing';

export const MIN_PX_PER_SECOND = 4;
export const MAX_PX_PER_SECOND = 600;

const MIN_TICK_PX = 72;
export const RULER_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export function niceStep(pxPerSecond: number): number {
  return RULER_STEPS.find((s) => s * pxPerSecond >= MIN_TICK_PX) ?? 600;
}

export function tickLabel(s: number, step: number): string {
  if (step >= 1) return formatTimecode(secondsToTicks(s));
  const decimals = step % 0.5 === 0 ? 1 : 2;
  return `${formatTimecode(secondsToTicks(Math.floor(s)))}.${(s % 1).toFixed(decimals).slice(2)}`;
}

export interface ActivityBin { t: number; v: number }

export function activityBins(placements: readonly SegmentPlacement[], cursors: Record<ID, PreparedCursor | undefined>): ActivityBin[] {
  const bins: ActivityBin[] = [];
  for (const pl of placements) {
    const c = cursors[pl.segment.recordingId];
    if (!c?.hasSamples) continue;
    const step = secondsToTicks(0.5);
    let k = 0;
    for (let s = pl.segment.sourceStart; s < pl.segment.sourceEnd; s += step) {
      const a = c.rawAt(s);
      const b = c.rawAt(s + step);
      let v = a && b ? Math.min(1, Math.hypot(b.x - a.x, b.y - a.y) * 4) : 0;
      while (k < c.clicks.length && (c.clicks[k]?.t ?? Infinity) < s) k++;
      if ((c.clicks[k]?.t ?? Infinity) < s + step) v = 1;
      bins.push({ t: pl.timelineStart + (s - pl.segment.sourceStart), v });
    }
  }
  return bins;
}

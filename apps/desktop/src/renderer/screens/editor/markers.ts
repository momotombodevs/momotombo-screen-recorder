import type { Project, SegmentPlacement } from '@momotombo/project-model';
import type { Ticks } from '@momotombo/timing';

export function markerTimes(recordings: Project['recordings'], placements: readonly SegmentPlacement[]): Ticks[] {
  const times = new Set<Ticks>();
  for (const r of Object.values(recordings)) {
    for (const m of r.markers) {
      const pl = placements.find((p) => p.segment.recordingId === r.id && m >= p.segment.sourceStart && m < p.segment.sourceEnd);
      if (pl) times.add(pl.timelineStart + (m - pl.segment.sourceStart));
    }
  }
  return [...times].sort((a, b) => a - b);
}

export function adjacentMarker(times: readonly Ticks[], playhead: Ticks, direction: 1 | -1, tolerance: Ticks): Ticks | null {
  if (direction > 0) return times.find((t) => t > playhead + tolerance) ?? null;
  return times.findLast((t) => t < playhead - tolerance) ?? null;
}

export interface KeyPress { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }
export interface KeyTarget { tagName: string; isContentEditable: boolean }

export const isTypingTarget = (t: KeyTarget | null) =>
  !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

const BRACKETS: Record<string, 1 | -1> = { '[': -1, ']': 1 };
const PLAIN: Record<string, 1 | -1> = { ',': -1, '.': 1 };

export function markerShortcut(e: KeyPress, target: KeyTarget | null): 1 | -1 | null {
  if (isTypingTarget(target) || e.metaKey) return null;
  const altGraph = e.ctrlKey && e.altKey;
  if (e.ctrlKey && !altGraph) return null;
  if (e.key in BRACKETS) return BRACKETS[e.key]!;
  if (e.key in PLAIN && !e.altKey && !e.ctrlKey) return PLAIN[e.key]!;
  return null;
}

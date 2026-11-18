import { sourceToTimeline, type Project, type SegmentPlacement } from '@momotombo/project-model';
import type { Ticks } from '@momotombo/timing';

export function markerTimes(project: Project, placements: SegmentPlacement[]): Ticks[] {
  const times = Object.values(project.recordings).flatMap((r) =>
    r.markers.map((m) => sourceToTimeline(project, r.id, m, placements)).filter((t): t is Ticks => t !== null));
  return [...new Set(times)].sort((a, b) => a - b);
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

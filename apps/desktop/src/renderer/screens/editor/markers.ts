import { sourceToTimeline, type Project, type SegmentPlacement } from '@momotombo/project-model';
import type { Ticks } from '@momotombo/timing';

export function markerTimes(project: Project, placements: SegmentPlacement[]): Ticks[] {
  const times = Object.values(project.recordings).flatMap((r) =>
    r.markers.map((m) => sourceToTimeline(project, r.id, m, placements)).filter((t): t is Ticks => t !== null));
  return times.sort((a, b) => a - b);
}

export function adjacentMarker(times: readonly Ticks[], playhead: Ticks, direction: 1 | -1, tolerance: Ticks): Ticks | null {
  if (direction > 0) return times.find((t) => t > playhead + tolerance) ?? null;
  return times.findLast((t) => t < playhead - tolerance) ?? null;
}

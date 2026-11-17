import { describe, expect, it } from 'vitest';
import { TICKS_PER_SECOND, secondsToTicks as sec } from '@momotombo/timing';
import {
  addRecording, createProject, layoutSegments, prepareCursor, removeTimelineRange, type CursorTrack, type PreparedCursor, type Recording, type SegmentPlacement,
} from '@momotombo/project-model';
import { MAX_PX_PER_SECOND, MIN_PX_PER_SECOND, RULER_STEPS, activityBins, niceStep, tickLabel } from './timeline-scale';

describe('ruler labels', () => {
  it('shows quarter seconds as they are', () => {
    expect([0, 0.25, 0.5, 0.75, 1.25].map((s) => tickLabel(s, 0.25))).toEqual(['00:00.00', '00:00.25', '00:00.50', '00:00.75', '00:01.25']);
  });

  it('shows half seconds with one decimal', () => {
    expect([0, 0.5, 1, 61.5].map((s) => tickLabel(s, 0.5))).toEqual(['00:00.0', '00:00.5', '00:01.0', '01:01.5']);
  });

  it('shows whole seconds as a timecode', () => {
    expect(tickLabel(90, 30)).toBe('01:30');
  });
});

describe('ruler step', () => {
  it('reaches its finest step within the timeline zoom range', () => {
    expect(niceStep(MAX_PX_PER_SECOND)).toBe(RULER_STEPS[0]);
    expect(niceStep(MAX_PX_PER_SECOND)).toBe(0.25);
  });

  it('chooses coarser steps as the timeline zooms out', () => {
    expect(niceStep(MIN_PX_PER_SECOND)).toBe(30);
    expect(niceStep(48)).toBe(2);
  });
});

function hourOfCursor(): CursorTrack {
  const samples: CursorTrack['samples'] = [];
  const clicks: CursorTrack['clicks'] = [];
  for (let i = 0; i < 3600 * 60; i++) {
    const t = Math.round((i / 60) * TICKS_PER_SECOND);
    samples.push({ t, x: (Math.sin(i / 300) + 1) / 2, y: (Math.cos(i / 500) + 1) / 2 });
  }
  for (let i = 0; i < 3600 * 2; i++) clicks.push({ t: sec(i / 2 + 0.1), x: 0.5, y: 0.5, kind: i % 2 ? 'up' : 'down', button: 'left' });
  return { samples, clicks, scrolls: [] };
}

function hourRecording(): Recording {
  return {
    id: 'r1', createdAt: '2026-10-16T00:00:00Z', duration: sec(3600),
    sources: { screen: { kind: 'screen', file: 'media/s.mp4', mime: 'video/mp4', width: 1920, height: 1080, fps: 60, startOffset: 0, duration: sec(3600) } },
    capture: { backend: 'web', platform: 'test', target: { kind: 'display', label: 'Pantalla', bounds: { x: 0, y: 0, w: 1440, h: 900 }, scaleFactor: 2 }, cursorInFrames: false, hasClicks: true },
    syncOffsets: {}, markers: [],
  };
}

function slowActivityBins(placements: readonly SegmentPlacement[], cursor: PreparedCursor) {
  const bins: { t: number; v: number }[] = [];
  for (const pl of placements) {
    const step = sec(0.5);
    for (let s = pl.segment.sourceStart; s < pl.segment.sourceEnd; s += step) {
      const a = cursor.rawAt(s);
      const b = cursor.rawAt(s + step);
      let v = a && b ? Math.min(1, Math.hypot(b.x - a.x, b.y - a.y) * 4) : 0;
      if (cursor.clicks.some((k) => k.t >= s && k.t < s + step)) v = 1;
      bins.push({ t: pl.timelineStart + (s - pl.segment.sourceStart), v });
    }
  }
  return bins;
}

describe('activityBins', () => {
  it('matches the bin-by-bin definition on an hour-long cursor log', () => {
    const cursor = prepareCursor(hourOfCursor());
    const placements = layoutSegments(removeTimelineRange(addRecording(createProject('Test'), hourRecording()), sec(1800), sec(1900.25)));
    expect(placements).toHaveLength(2);
    expect(activityBins(placements, { r1: cursor })).toEqual(slowActivityBins(placements, cursor));
  });
});

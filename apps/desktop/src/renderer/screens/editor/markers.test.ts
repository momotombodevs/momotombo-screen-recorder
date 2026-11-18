import { describe, expect, it } from 'vitest';
import { addRecording, createProject, layoutSegments, removeSegment, splitAt, type Project, type Recording } from '@momotombo/project-model';
import { secondsToTicks as sec } from '@momotombo/timing';
import { adjacentMarker, markerTimes } from './markers';

function recording(id: string, seconds: number, markers: number[]): Recording {
  return {
    id, createdAt: '2026-10-16T00:00:00Z', duration: sec(seconds),
    sources: { screen: { kind: 'screen', file: `media/${id}/screen.mp4`, mime: 'video/mp4', width: 1920, height: 1080, fps: 30, startOffset: 0, duration: sec(seconds) } },
    capture: { backend: 'web', platform: 'test', target: { kind: 'display', label: 'P', bounds: { x: 0, y: 0, w: 10, h: 10 }, scaleFactor: 1 }, cursorInFrames: false, hasClicks: false },
    syncOffsets: {}, markers: markers.map(sec),
  };
}

const seconds = (p: Project) => markerTimes(p, layoutSegments(p)).map((t) => t / sec(1));

describe('markerTimes', () => {
  it('lists every recording marker in timeline order', () => {
    const p = addRecording(addRecording(createProject('M'), recording('r1', 10, [8, 2])), recording('r2', 5, [1]));
    expect(seconds(p)).toEqual([2, 8, 11]);
  });

  it('skips markers inside removed material and shifts the ones after the cut', () => {
    let p = addRecording(createProject('M'), recording('r1', 10, [1, 3, 7]));
    p = splitAt(splitAt(p, sec(2)), sec(5));
    p = removeSegment(p, p.sequence.segments[1]!.id);
    expect(seconds(p)).toEqual([1, 4]);
  });
});

describe('adjacentMarker', () => {
  const times = [sec(1), sec(4), sec(9)];
  const half = sec(1 / 60);

  it('jumps to the next and previous marker from between two', () => {
    expect(adjacentMarker(times, sec(2), 1, half)).toBe(sec(4));
    expect(adjacentMarker(times, sec(2), -1, half)).toBe(sec(1));
  });

  it('moves on from a marker the playhead already sits on, even a few ticks off', () => {
    expect(adjacentMarker(times, sec(4) + 3, 1, half)).toBe(sec(9));
    expect(adjacentMarker(times, sec(4) - 3, -1, half)).toBe(sec(1));
  });

  it('returns null past the last or before the first marker, and with none', () => {
    expect(adjacentMarker(times, sec(9), 1, half)).toBeNull();
    expect(adjacentMarker(times, sec(1), -1, half)).toBeNull();
    expect(adjacentMarker([], 0, 1, half)).toBeNull();
  });
});

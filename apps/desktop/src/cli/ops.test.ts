import { addRecording, createProject, type Project, type Recording } from '@momotombo/project-model';
import { secondsToTicks } from '@momotombo/timing';
import { describe, expect, it } from 'vitest';
import { validatedProjectText } from '../main/project-file';
import { OpError, Ops, applyOps, describeProject } from './ops';

const recording: Recording = {
  id: 'r1',
  createdAt: '2026-11-17T00:00:00Z',
  duration: secondsToTicks(60),
  sources: {
    screen: { kind: 'screen', file: 'media/r1/screen.mp4', mime: 'video/mp4', width: 1920, height: 1080, fps: 60, startOffset: 0, duration: secondsToTicks(60) },
  },
  capture: {
    backend: 'web', platform: 'test',
    target: { kind: 'display', label: 'Display', bounds: { x: 0, y: 0, w: 1920, h: 1080 }, scaleFactor: 1 },
    cursorInFrames: true, hasClicks: false,
  },
  syncOffsets: {},
  markers: [secondsToTicks(5), secondsToTicks(30)],
};

const sixtySeconds = (): Project => addRecording(createProject('Demo'), recording);
const edit = (ops: unknown, project = sixtySeconds()) => describeProject(applyOps(project, Ops.parse(ops)));

describe('applyOps', () => {
  it('cuts a timeline range and closes the gap', () => {
    const after = edit([{ op: 'cut', start: 10, end: 25 }]);
    expect(after.durationSeconds).toBe(45);
    expect(after.segments.map((s) => [s.start, s.end, s.sourceStart, s.sourceEnd])).toEqual([[0, 10, 0, 10], [10, 45, 25, 60]]);
  });

  it('gives each op the timeline the previous one left', () => {
    const after = edit([{ op: 'cut', start: 0, end: 10 }, { op: 'addZoom', start: 0, end: 2, scale: 2 }]);
    expect(after.zooms).toMatchObject([{ shown: [{ start: 0, end: 2 }], origin: 'manual', scale: 2 }]);
    expect(after.segments[0]).toMatchObject({ sourceStart: 10 });
  });

  it('hides a region with the frosted look unless an effect is given', () => {
    const region = { x: 0.1, y: 0.1, w: 0.3, h: 0.1 };
    const after = edit([
      { op: 'addPrivacy', start: 1, end: 4, region },
      { op: 'addPrivacy', start: 10, end: 12, region, effect: { kind: 'blur', strength: 12 } },
    ]);
    expect(after.privacy.map((a) => a.effect)).toEqual([{ kind: 'frosted' }, { kind: 'blur', strength: 12 }]);
  });

  it('removes an item by the id describe reported', () => {
    const withZoom = applyOps(sixtySeconds(), Ops.parse([{ op: 'addZoom', start: 3, end: 6 }]));
    const id = describeProject(withZoom).zooms[0]!.id;
    expect(edit([{ op: 'removeItem', track: 'zooms', id }], withZoom).zooms).toEqual([]);
  });

  it('drops markers that fall inside cut material and shifts the rest', () => {
    expect(edit([{ op: 'cut', start: 0, end: 10 }]).recordings[0]!.markers).toEqual([20]);
  });

  it('rejects the whole batch and names the op that failed', () => {
    const project = sixtySeconds();
    const ops = Ops.parse([{ op: 'cut', start: 0, end: 5 }, { op: 'addZoom', start: 1, end: 3 }, { op: 'addZoom', start: 2, end: 4 }]);
    expect(() => applyOps(project, ops)).toThrow(/^op 2 \(addZoom\): /);
    expect(describeProject(project).durationSeconds).toBe(60);
  });

  it.each([
    ['a cut past the end', { op: 'cut', start: 70, end: 80 }],
    ['an unknown segment', { op: 'removeSegment', id: 'seg_missing' }],
    ['an unknown item', { op: 'removeItem', track: 'zooms', id: 'zoom_missing' }],
  ])('refuses %s instead of reporting success', (_name, op) => {
    expect(() => edit([op])).toThrow(/changed nothing/);
  });

  it.each([
    ['a cut of everything', { op: 'cut', start: 0, end: 60 }],
    ['a backwards range', { op: 'cut', start: 9, end: 3 }],
  ])('refuses %s', (_name, op) => {
    expect(() => edit([op])).toThrow(OpError);
  });

  it('rejects misspelled fields before touching the project', () => {
    expect(() => Ops.parse([{ op: 'cut', from: 1, to: 2 }])).toThrow();
    expect(() => Ops.parse([{ op: 'addZoom', start: 1, end: 2, zoom: 3 }])).toThrow();
  });

  it('leaves a style the editor could not draw to the project validation', () => {
    const edited = applyOps(sixtySeconds(), Ops.parse([{ op: 'setStyle', patch: { frame: { padding: 'wide' } } }]));
    expect(() => validatedProjectText(edited)).toThrow(/style\.frame\.padding/);
  });
});

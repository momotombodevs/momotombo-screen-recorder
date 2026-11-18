import {
  activeVariant, addRecording, createProject, resolvedBaseCamera, type CursorTrack, type Project, type Recording, type ZoomItem,
} from '@momotombo/project-model';
import { secondsToTicks } from '@momotombo/timing';
import { describe, expect, it } from 'vitest';
import { validatedProjectText } from '../main/project-file';
import { OpError, Ops, applyOps, describeProject, parseOps, type OpContext } from './ops';

const recording: Recording = {
  id: 'r1',
  createdAt: '2026-11-17T00:00:00Z',
  duration: secondsToTicks(60),
  sources: {
    screen: { kind: 'screen', file: 'media/r1/screen.mp4', mime: 'video/mp4', width: 1920, height: 1080, fps: 60, startOffset: 0, duration: secondsToTicks(60) },
    camera: { kind: 'camera', file: 'media/r1/camera.webm', mime: 'video/webm', width: 1280, height: 720, fps: 30, startOffset: 0, duration: secondsToTicks(60) },
    mic: { kind: 'mic', file: 'media/r1/mic.webm', mime: 'audio/webm', sampleRate: 48_000, channels: 1, startOffset: 0, duration: secondsToTicks(60) },
  },
  capture: {
    backend: 'web', platform: 'test',
    target: { kind: 'display', label: 'Display', bounds: { x: 0, y: 0, w: 1920, h: 1080 }, scaleFactor: 1 },
    cursorInFrames: true, hasClicks: true,
  },
  syncOffsets: {},
  markers: [secondsToTicks(5), secondsToTicks(30)],
};

const sixtySeconds = (): Project => addRecording(createProject('Demo'), recording);
const run = (ops: unknown, project = sixtySeconds(), ctx?: OpContext) => applyOps(project, Ops.parse(ops), ctx);
const apply = (ops: unknown, project = sixtySeconds(), ctx?: OpContext) => run(ops, project, ctx).project;
const edit = (ops: unknown, project = sixtySeconds()) => describeProject(apply(ops, project));
const region = { x: 0.1, y: 0.1, w: 0.3, h: 0.1 };

const autoZoom = (start: number, end: number): Omit<ZoomItem, 'id'> => ({
  type: 'zoom', recordingId: 'r1', start: secondsToTicks(start), end: secondsToTicks(end), origin: 'auto',
  mode: 'region', center: { x: 0.5, y: 0.5 }, scale: 1.8, enter: createProject('').style.zoomDefaults.enter, exit: createProject('').style.zoomDefaults.exit,
});

describe('segment ops', () => {
  it('cuts a timeline range and closes the gap', () => {
    const after = edit([{ op: 'cut', start: 10, end: 25 }]);
    expect(after.durationSeconds).toBe(45);
    expect(after.segments.map((s) => [s.start, s.end, s.sourceStart, s.sourceEnd])).toEqual([[0, 10, 0, 10], [10, 45, 25, 60]]);
  });

  it('splits a segment in two at a timeline time', () => {
    expect(edit([{ op: 'split', at: 20 }]).segments.map((s) => [s.start, s.end])).toEqual([[0, 20], [20, 60]]);
  });

  it('moves a segment to another place in the timeline', () => {
    const split = apply([{ op: 'split', at: 20 }]);
    const second = describeProject(split).segments[1]!.id;
    expect(edit([{ op: 'moveSegment', id: second, toIndex: 0 }], split).segments.map((s) => [s.sourceStart, s.sourceEnd])).toEqual([[20, 60], [0, 20]]);
  });

  it('removes one segment and keeps the rest', () => {
    const split = apply([{ op: 'split', at: 20 }]);
    const first = describeProject(split).segments[0]!.id;
    const after = edit([{ op: 'removeSegment', id: first }], split);
    expect(after.durationSeconds).toBe(40);
    expect(after.segments[0]).toMatchObject({ sourceStart: 20, sourceEnd: 60 });
  });

  it('trims a segment to new source times', () => {
    const p = sixtySeconds();
    const id = p.sequence.segments[0]!.id;
    const { project, results, warnings } = run([{ op: 'trimSegment', id, start: 5, end: 50 }], p);
    expect(describeProject(project).segments[0]).toMatchObject({ start: 0, end: 45, sourceStart: 5, sourceEnd: 50 });
    expect(results[0]).toMatchObject({ sourceStart: 5, sourceEnd: 50 });
    expect(warnings).toEqual([]);
  });

  it('warns when a trim is kept inside the recording', () => {
    const p = sixtySeconds();
    const id = p.sequence.segments[0]!.id;
    const { project, warnings } = run([{ op: 'trimSegment', id, start: 10, end: 90 }], p);
    expect(describeProject(project).segments[0]).toMatchObject({ sourceStart: 10, sourceEnd: 60 });
    expect(warnings).toEqual([expect.stringMatching(/^op 0 \(trimSegment\): trimmed to 10–60 s/)]);
  });

  it.each([
    ['an unknown segment', { op: 'trimSegment', id: 'seg_missing', start: 1 }, /no segment with id seg_missing/],
    ['no edge', { op: 'trimSegment', id: 'x' }, /give start, end or both/],
  ])('refuses a trim of %s', (_name, op, message) => {
    expect(() => run([op])).toThrow(message);
  });
});

describe('adding items', () => {
  it('gives each op the timeline the previous one left', () => {
    const after = edit([{ op: 'cut', start: 0, end: 10 }, { op: 'addZoom', start: 0, end: 2, scale: 2 }]);
    expect(after.zooms).toMatchObject([{ shown: [{ start: 0, end: 2 }], origin: 'manual', scale: 2 }]);
    expect(after.segments[0]).toMatchObject({ sourceStart: 10 });
  });

  it('reports the id and range each added item got', () => {
    const { project, results, warnings } = run([{ op: 'addZoom', start: 3, end: 6 }]);
    expect(results).toEqual([{ index: 0, op: 'addZoom', id: project.zooms[0]!.id, placed: { start: 3, end: 6 } }]);
    expect(warnings).toEqual([]);
  });

  it('warns when a zoom across a cut is shortened to the clip section it starts in', () => {
    const { results, warnings } = run([{ op: 'cut', start: 10, end: 20 }, { op: 'addZoom', start: 8, end: 14 }]);
    expect(results[1]!.placed).toEqual({ start: 8, end: 10 });
    expect(warnings).toEqual([expect.stringMatching(/^op 1 \(addZoom\): placed 8–10 s instead of 8–14 s/)]);
  });

  it('warns when an item is shortened to stop before the next one', () => {
    const { results, warnings } = run([{ op: 'addMagnifier', start: 10, end: 12 }, { op: 'addMagnifier', start: 5, end: 11 }]);
    expect(results[1]!.placed).toEqual({ start: 5, end: 10 });
    expect(warnings).toHaveLength(1);
  });

  it('hides a region with the frosted look unless an effect is given', () => {
    const after = edit([
      { op: 'addPrivacy', start: 1, end: 4, region },
      { op: 'addPrivacy', start: 10, end: 12, region, effect: { kind: 'blur', strength: 12 } },
    ]);
    expect(after.privacy.map((a) => a.effect)).toEqual([{ kind: 'frosted' }, { kind: 'blur', strength: 12 }]);
  });

  it('adds a magnifier with the style defaults unless size or zoom is given', () => {
    const after = edit([{ op: 'addMagnifier', start: 2, end: 4 }, { op: 'addMagnifier', start: 6, end: 8, size: 300, zoom: 3 }]);
    expect(after.magnifiers.map((m) => [m.shown, m.size, m.zoom])).toEqual([
      [[{ start: 2, end: 4 }], 280, 2],
      [[{ start: 6, end: 8 }], 300, 3],
    ]);
  });

  it('refuses a magnifier where another one already is', () => {
    expect(() => run([{ op: 'addMagnifier', start: 2, end: 4 }, { op: 'addMagnifier', start: 3, end: 5 }])).toThrow(/^op 1 \(addMagnifier\): no free space/);
  });

  it('adds a camera layout from the current camera with a patched look', () => {
    const after = edit([{ op: 'addCameraLayout', start: 2, end: 6, layout: { shape: 'square', size: 0.3 }, enter: 'fast' }]);
    expect(after.cameraLayouts).toMatchObject([{ shown: [{ start: 2, end: 6 }], origin: 'manual', layout: { shape: 'square', size: 0.3, mirror: true } }]);
  });

  it('deep-merges a nested camera layout patch', () => {
    const after = apply([{ op: 'addCameraLayout', start: 2, end: 6, layout: { position: { x: 0.2 }, border: { width: 4 } } }]).cameraLayouts[0]!;
    const base = sixtySeconds().style.camera;
    expect(after.layout.position).toEqual({ x: 0.2, y: base.position.y });
    expect(after.layout.border).toEqual({ ...base.border, width: 4 });
  });

  it('refuses a camera layout patch with a misspelled field', () => {
    expect(() => run([{ op: 'addCameraLayout', start: 2, end: 6, layout: { shpe: 'square' } }])).toThrow(/unknown field layout\.shpe/);
  });

  it('adds a camera move with its second position', () => {
    const after = edit([{ op: 'addCameraMove', at: 4, duration: 2, second: { position: { x: 0.1, y: 0.2 } } }]);
    expect(after.cameraLayouts).toMatchObject([{ shown: [{ start: 4, end: 6 }], second: { position: { x: 0.1, y: 0.2 } } }]);
  });

  it('refuses a camera move where there is no timeline', () => {
    expect(() => run([{ op: 'addCameraMove', at: 70 }])).toThrow(/no free space on the camera track/);
  });
});

describe('updating items', () => {
  const withItems = () => apply([
    { op: 'addZoom', start: 3, end: 6, scale: 2 },
    { op: 'addPrivacy', start: 1, end: 4, region },
    { op: 'addPrivacy', start: 1, end: 4, region: { x: 0.6, y: 0.6, w: 0.2, h: 0.2 } },
    { op: 'addMagnifier', start: 8, end: 10 },
    { op: 'addCameraLayout', start: 2, end: 6 },
  ]);

  it('changes a zoom and keeps its transitions', () => {
    const p = withItems();
    const zoom = p.zooms[0]!;
    const after = apply([{ op: 'updateItem', track: 'zooms', id: zoom.id, patch: { scale: 2.5, center: { x: 0.3 } } }], p).zooms[0]!;
    expect(after).toMatchObject({ scale: 2.5, center: { x: 0.3, y: 0.5 }, enter: zoom.enter, exit: zoom.exit, start: zoom.start, end: zoom.end });
  });

  it('changes a privacy effect, a magnifier and a camera layout', () => {
    const p = withItems();
    const after = apply([
      { op: 'updateItem', track: 'privacy', id: p.privacy[0]!.id, patch: { effect: { kind: 'pixelate', block: 12 } } },
      { op: 'updateItem', track: 'magnifiers', id: p.magnifiers[0]!.id, patch: { zoom: 3 } },
      { op: 'updateItem', track: 'cameraLayouts', id: p.cameraLayouts[0]!.id, patch: { layout: { size: 0.2 }, second: { position: { x: 0.2, y: 0.2 }, size: 0.2 } } },
    ], p);
    expect(after.privacy[0]!.effect).toEqual({ kind: 'pixelate', block: 12 });
    expect(after.magnifiers[0]!.zoom).toBe(3);
    expect(after.cameraLayouts[0]).toMatchObject({ layout: { size: 0.2, shape: 'circle' }, second: { position: { x: 0.2, y: 0.2 } } });
  });

  it.each([
    ['a misspelled field', { scale: 2, centre: { x: 0.2 } }, /unknown field zooms\.centre/],
    ['a misspelled nested field', { center: { z: 0.2 } }, /unknown field zooms\.center\.z/],
    ['its source time range', { start: 0 }, /zooms\.start cannot be changed with a patch; retime it with the op's start and end/],
  ])('refuses a zoom patch with %s', (_name, patch, message) => {
    const p = withItems();
    expect(() => run([{ op: 'updateItem', track: 'zooms', id: p.zooms[0]!.id, patch }], p)).toThrow(message);
  });

  it('refuses a privacy effect patch with a misspelled field of a new kind', () => {
    const p = withItems();
    expect(() => run([{ op: 'updateItem', track: 'privacy', id: p.privacy[0]!.id, patch: { effect: { kind: 'blur', strenght: 1 } } }], p)).toThrow(/unknown field privacy\.effect\.strenght/);
  });

  it('retimes an item within the placement rules and reports where it landed', () => {
    const p = withItems();
    const zoom = p.zooms[0]!;
    const { project, results, warnings } = run([{ op: 'updateItem', track: 'zooms', id: zoom.id, start: 20, end: 24, patch: { scale: 3 } }], p);
    const moved = project.zooms.find((z) => z.id === zoom.id)!;
    expect(moved).toMatchObject({ scale: 3, enter: zoom.enter, start: secondsToTicks(20), end: secondsToTicks(24) });
    expect(results[0]).toMatchObject({ id: zoom.id, placed: { start: 20, end: 24 } });
    expect(warnings).toEqual([]);
  });

  it('moves one edge of an item and keeps the other', () => {
    const p = withItems();
    const zoom = p.zooms[0]!;
    expect(run([{ op: 'updateItem', track: 'zooms', id: zoom.id, end: 8 }], p).results[0]!.placed).toEqual({ start: 3, end: 8 });
  });

  it('shortens a retimed item that runs into a neighbour and warns', () => {
    const p = withItems();
    const { results, warnings } = run([{ op: 'updateItem', track: 'magnifiers', id: p.magnifiers[0]!.id, start: 8, end: 12 }],
      apply([{ op: 'addMagnifier', start: 11, end: 13 }], p));
    expect(results[0]!.placed).toEqual({ start: 8, end: 11 });
    expect(warnings).toEqual([expect.stringMatching(/^op 0 \(updateItem\): placed 8–11 s instead of 8–12 s/)]);
  });

  it('refuses to retime an item onto another one', () => {
    const p = apply([{ op: 'addMagnifier', start: 20, end: 22 }], withItems());
    expect(() => run([{ op: 'updateItem', track: 'magnifiers', id: p.magnifiers[0]!.id, start: 21, end: 23 }], p)).toThrow(/no free space|overlaps item/);
  });

  it('changes an item that already overlapped another one before the patch', () => {
    const p = withItems();
    const [a, b] = p.privacy;
    const legacy = { ...p, privacy: [a!, { ...b!, region: a!.region }] };
    expect(apply([{ op: 'updateItem', track: 'privacy', id: b!.id, patch: { cornerRadius: 0.2 } }], legacy).privacy[1]!.cornerRadius).toBe(0.2);
  });

  it('refuses to move a privacy area over another one at the same time', () => {
    const p = withItems();
    expect(() => run([{ op: 'updateItem', track: 'privacy', id: p.privacy[1]!.id, patch: { region } }], p)).toThrow(/would overlap item prv_/);
  });

  it('refuses an unknown item id', () => {
    expect(() => run([{ op: 'updateItem', track: 'zooms', id: 'zm_missing', patch: { scale: 2 } }], withItems())).toThrow(/changed nothing/);
  });

  it('removes an item from every track by the id describe reported', () => {
    const p = withItems();
    const described = describeProject(p);
    const after = edit([
      { op: 'removeItem', track: 'zooms', id: described.zooms[0]!.id },
      { op: 'removeItem', track: 'privacy', id: described.privacy[0]!.id },
      { op: 'removeItem', track: 'magnifiers', id: described.magnifiers[0]!.id },
      { op: 'removeItem', track: 'cameraLayouts', id: described.cameraLayouts[0]!.id },
    ], p);
    expect([after.zooms.length, after.privacy.length, after.magnifiers.length, after.cameraLayouts.length]).toEqual([0, 1, 0, 0]);
  });
});

describe('style and audio patches', () => {
  it('changes the style', () => {
    const after = apply([{ op: 'setStyle', patch: { frame: { padding: 0.1 }, cursor: { scale: 1.5 } } }]);
    expect(after.style.frame).toMatchObject({ padding: 0.1, radius: 14 });
    expect(after.style.cursor.scale).toBe(1.5);
  });

  it('switches the background to another kind', () => {
    expect(apply([{ op: 'setStyle', patch: { background: { kind: 'solid', color: '#000000' } } }]).style.background).toEqual({ kind: 'solid', color: '#000000' });
    expect(apply([{ op: 'setStyle', patch: { background: { kind: 'gradient', from: '#000000', to: '#ffffff', angle: 90 } } }]).style.background.kind).toBe('gradient');
  });

  it('refuses a misspelled field when switching to a background kind no preset uses', () => {
    expect(apply([{ op: 'setStyle', patch: { background: { kind: 'image', file: 'media/bg.png', blur: 0 } } }]).style.background.kind).toBe('image');
    expect(() => run([{ op: 'setStyle', patch: { background: { kind: 'image', file: 'media/bg.png', blur: 0, junk: 1 } } }])).toThrow(/unknown field style\.background\.junk/);
  });

  it('changes a field of the current background kind', () => {
    expect(apply([{ op: 'setStyle', patch: { background: { seed: 3 } } }]).style.background).toMatchObject({ kind: 'aurora', seed: 3 });
  });

  it.each([
    ['a misspelled camera field', { camera: { positon: { x: 0.1, y: 0.1 } } }, /unknown field style\.camera\.positon/],
    ['a misspelled section', { cursr: { scale: 2 } }, /unknown field style\.cursr/],
    ['a field of another background kind', { background: { color: '#000000' } }, /unknown field style\.background\.color/],
    ['a misspelled field of a new background kind', { background: { kind: 'solid', colour: '#000000' } }, /unknown field style\.background\.colour/],
  ])('refuses a style patch with %s', (_name, patch, message) => {
    expect(() => run([{ op: 'setStyle', patch }])).toThrow(message);
  });

  it('leaves a style the editor could not draw to the project validation', () => {
    const edited = apply([{ op: 'setStyle', patch: { frame: { padding: 'wide' } } }]);
    expect(() => validatedProjectText(edited)).toThrow(/style\.frame\.padding/);
  });

  it('changes the audio mix', () => {
    const { audio } = apply([{ op: 'setAudio', patch: { mic: { gain: 0.5 }, system: { muted: true } } }]);
    expect(audio.mic).toMatchObject({ gain: 0.5, muted: false });
    expect(audio.system).toMatchObject({ gain: 0.8, muted: true });
  });

  it('refuses an audio patch with a misspelled field', () => {
    expect(() => run([{ op: 'setAudio', patch: { mic: { gian: 0.5 } } }])).toThrow(/^op 0 \(setAudio\): unknown field audio\.mic\.gian/);
  });
});

describe('camera placement', () => {
  it('puts the camera in a corner of every format', () => {
    const p = apply([{ op: 'setCamera', corner: 'top-left', size: 0.2 }]);
    expect(p.style.camera).toMatchObject({ size: 0.2 });
    for (const v of p.variants) {
      const camera = resolvedBaseCamera(p, v);
      const margin = (0.04 * Math.min(v.width, v.height)) / v.height;
      expect(camera.position.y).toBeCloseTo(margin + camera.size / 2, 3);
      expect(camera.position.x).toBeLessThan(0.3);
    }
  });

  it('keeps each format its own camera size unless a size is given', () => {
    const p = apply([{ op: 'setCamera', corner: 'bottom-right' }]);
    const vertical = p.variants.find((v) => v.id === 'v_9x16')!;
    expect(resolvedBaseCamera(p, vertical).size).toBe(0.24);
    expect(resolvedBaseCamera(p, vertical).position.x).toBeGreaterThan(0.7);
    expect(resolvedBaseCamera(p, activeVariant(p)).position).toEqual({ x: 0.9016, y: 0.825 });
  });

  it('centres the camera vertically on a side', () => {
    expect(apply([{ op: 'setCamera', corner: 'left', visible: true }]).style.camera.position.y).toBe(0.5);
  });

  it('gives a format without its own camera place one when its shape differs', () => {
    const p = sixtySeconds();
    const square = { ...p, variants: p.variants.map((v) => (v.id === 'v_1x1' ? { ...v, cameraOverride: undefined } : v)) };
    const after = apply([{ op: 'setCamera', corner: 'top-right', size: 0.2 }], square);
    const v = after.variants.find((x) => x.id === 'v_1x1')!;
    expect(v.cameraOverride).toEqual({ position: { x: 0.86, y: 0.14 } });
    expect(after.variants.find((x) => x.id === 'v_16x9')!.cameraOverride).toBeUndefined();
  });

  it('refuses an unknown corner', () => {
    expect(() => Ops.parse([{ op: 'setCamera', corner: 'middle' }])).toThrow();
  });
});

describe('variants', () => {
  it('switches the active format', () => {
    const after = edit([{ op: 'setVariant', id: 'v_9x16' }]);
    expect(after).toMatchObject({ activeVariantId: 'v_9x16', canvas: { name: '9:16', width: 1080, height: 1920 } });
  });

  it('refuses an unknown format and names the known ones', () => {
    expect(() => run([{ op: 'setVariant', id: 'v_3x2' }])).toThrow(/no variant with id v_3x2; ids: v_16x9, v_9x16/);
  });

  it('refuses switching to the format already active', () => {
    expect(() => run([{ op: 'setVariant', id: 'v_16x9' }])).toThrow(/changed nothing/);
  });

  it('changes a format', () => {
    const after = apply([{ op: 'updateVariant', id: 'v_1x1', patch: { frameOverride: { radius: 20 }, cameraOverride: { mirror: false }, zoomStrength: 0.8 } }]);
    expect(after.variants.find((v) => v.id === 'v_1x1')).toMatchObject({ frameOverride: { padding: 0.06, radius: 20 }, cameraOverride: { mirror: false }, zoomStrength: 0.8 });
  });

  it.each([
    ['a misspelled field', { frameOverides: {} }, /unknown field variant\.frameOverides/],
    ['its id', { id: 'v_new' }, /variant\.id cannot be changed/],
  ])('refuses a format patch with %s', (_name, patch, message) => {
    expect(() => run([{ op: 'updateVariant', id: 'v_1x1', patch }])).toThrow(message);
  });
});

describe('automatic zooms', () => {
  const clicks = (): CursorTrack => {
    const samples = [];
    const down = [];
    for (let s = 0; s < 60; s += 0.1) samples.push({ t: secondsToTicks(s), x: s < 30 ? 0.2 : 0.8, y: s < 30 ? 0.3 : 0.7 });
    for (const s of [5, 6, 7, 35, 36, 37]) down.push({ t: secondsToTicks(s), x: s < 30 ? 0.2 : 0.8, y: s < 30 ? 0.3 : 0.7, button: 'left' as const, kind: 'down' as const });
    return { samples, clicks: down, scrolls: [] };
  };

  it('replaces automatic zooms with suggestions from the cursor log', () => {
    const { project, results, warnings } = run([{ op: 'applyZoomSuggestions' }], sixtySeconds(), { cursorTracks: { r1: clicks() } });
    expect(project.zooms.length).toBeGreaterThan(0);
    expect(project.zooms.every((z) => z.origin === 'auto')).toBe(true);
    expect(results[0]).toMatchObject({ added: project.zooms.length, replaced: 0 });
    expect(warnings).toEqual([]);
  });

  it('refuses to report success when there is no cursor log to suggest from', () => {
    expect(() => run([{ op: 'applyZoomSuggestions' }])).toThrow('op 0 (applyZoomSuggestions): no zoom suggestions added (r1: no cursor log)');
  });

  it('counts only the suggestions that were added, not those a manual zoom covers', () => {
    const manualOverAll = apply([{ op: 'addZoom', start: 0, end: 60 }]);
    expect(() => run([{ op: 'applyZoomSuggestions' }], manualOverAll, { cursorTracks: { r1: clicks() } })).toThrow(/no zoom suggestions added \(r1: \d+ suggestions overlap manual zooms\)/);
  });

  it('clears automatic zooms and keeps manual ones', () => {
    const p = apply([{ op: 'addZoom', start: 40, end: 42 }]);
    const withAuto = { ...p, zooms: [...p.zooms, { ...autoZoom(10, 12), id: 'zm_auto' }] };
    expect(apply([{ op: 'clearAutoZooms' }], withAuto).zooms.map((z) => z.origin)).toEqual(['manual']);
  });

  it('refuses to clear when there is nothing automatic', () => {
    expect(() => run([{ op: 'clearAutoZooms' }])).toThrow(/changed nothing/);
    expect(() => run([{ op: 'clearAutoZooms', recordingId: 'r9' }])).toThrow(/no recording with id r9/);
  });

  it('changes the suggestion sensitivity', () => {
    expect(apply([{ op: 'setZoomSensitivity', sensitivity: 'high' }]).zoomEngine.sensitivity).toBe('high');
    expect(() => run([{ op: 'setZoomSensitivity', sensitivity: 'medium' }])).toThrow(/changed nothing/);
  });
});

describe('batches', () => {
  it('rejects the whole batch and names the op that failed', () => {
    const project = sixtySeconds();
    const ops = Ops.parse([{ op: 'cut', start: 0, end: 5 }, { op: 'addZoom', start: 1, end: 3 }, { op: 'addZoom', start: 2, end: 4 }]);
    expect(() => applyOps(project, ops)).toThrow(/^op 2 \(addZoom\): /);
    expect(describeProject(project).durationSeconds).toBe(60);
  });

  it('renames the project', () => {
    expect(apply([{ op: 'rename', name: 'Launch demo' }]).name).toBe('Launch demo');
    expect(() => run([{ op: 'rename', name: 'Demo' }])).toThrow(/changed nothing/);
  });

  it('drops markers that fall inside cut material and shifts the rest', () => {
    expect(edit([{ op: 'cut', start: 0, end: 10 }]).recordings[0]!.markers).toEqual([20]);
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

  it('explains invalid ops one line per problem, naming the op and the field', () => {
    let message = '';
    try {
      parseOps([{ op: 'cut', start: 1, end: 2 }, { op: 'addZoom', start: 1, end: 2, center: { x: 2, y: 0.5 } }, { op: 'zoomIn' }]);
    } catch (e) {
      message = (e as Error).message;
    }
    const lines = message.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^op 1 \(addZoom\) center\.x: /);
    expect(lines[1]).toMatch(/^op 2 \(zoomIn\) op: /);
  });

  it('explains ops that are not a list', () => {
    expect(() => parseOps({ op: 'cut' })).toThrow(/^ops: /);
  });
});

describe('describeProject', () => {
  it('reports formats, camera layouts, media details and capture info', () => {
    const p = apply([{ op: 'addCameraMove', at: 4, duration: 2, second: { position: { x: 0.1, y: 0.2 } } }]);
    const d = describeProject(p);
    expect(d.activeVariantId).toBe('v_16x9');
    expect(d.variants.map((v) => v.id)).toEqual(['v_16x9', 'v_9x16', 'v_1x1', 'v_4x5']);
    expect(d.cameraLayouts[0]).toMatchObject({ origin: 'manual', layout: { shape: 'circle', visible: true }, enterSeconds: expect.any(Number), second: { position: { x: 0.1, y: 0.2 } } });
    expect(d.recordings[0]!.sources).toEqual({
      screen: { file: 'media/r1/screen.mp4', mime: 'video/mp4', width: 1920, height: 1080, fps: 60 },
      camera: { file: 'media/r1/camera.webm', mime: 'video/webm', width: 1280, height: 720, fps: 30 },
      mic: { file: 'media/r1/mic.webm', mime: 'audio/webm', sampleRate: 48_000, channels: 1 },
    });
    expect(d.recordings[0]!.capture).toMatchObject({ backend: 'web', hasClicks: true, target: { kind: 'display' } });
  });
});

describe('text ops', () => {
  const texts = (ops: unknown, project?: Project) => edit(ops, project).texts;

  it('adds a title by default and a preset when named, and reports where each landed', () => {
    const { project, results, warnings } = run([
      { op: 'addText', start: 1, end: 4, text: 'Momotombo' },
      { op: 'addText', start: 2, end: 6, text: 'Ana López\nDiseñadora', preset: 'lower-third' },
    ]);
    expect(warnings).toEqual([]);
    expect(results.map((r) => r.placed)).toEqual([{ start: 1, end: 4 }, { start: 2, end: 6 }]);
    const [title, lower] = describeProject(project).texts;
    expect(title).toMatchObject({ id: results[0]!.id, text: 'Momotombo', anchor: 'center', fontWeight: 800, enter: { kind: 'pop', duration: 0.5 }, shown: [{ start: 1, end: 4 }] });
    expect(lower).toMatchObject({ anchor: 'bottom-left', background: { color: '#C2410C' }, enter: { kind: 'slide-right', duration: 0.45 } });
    expect(() => validatedProjectText(project)).not.toThrow();
  });

  it('lets any field override the preset, and null drop a preset background', () => {
    const [t] = texts([{
      op: 'addText', start: 1, end: 3, text: 'Hola', preset: 'caption', position: { x: 0.2, y: 0.3 }, fontSize: 0.06, color: '#FF0000',
      background: null, stroke: { color: '#000000', width: 0.08 }, enter: { kind: 'typewriter', duration: 1.2 }, exit: { kind: 'none', duration: 0 },
    }]);
    expect(t).toMatchObject({ position: { x: 0.2, y: 0.3 }, fontSize: 0.06, color: '#FF0000', stroke: { width: 0.08 }, enter: { kind: 'typewriter', duration: 1.2 }, exit: { kind: 'none' } });
    expect(t).not.toHaveProperty('background');
  });

  it('places texts over each other in time without shortening them', () => {
    const { results, warnings } = run([
      { op: 'addText', start: 1, end: 6, text: 'Title' },
      { op: 'addText', start: 2, end: 5, text: 'Caption', preset: 'caption' },
    ]);
    expect(results[1]!.placed).toEqual({ start: 2, end: 5 });
    expect(warnings).toEqual([]);
  });

  it('warns when a text across a cut is shortened to the clip section it starts in', () => {
    const { results, warnings } = run([{ op: 'cut', start: 10, end: 20 }, { op: 'addText', start: 8, end: 14, text: 'x' }]);
    expect(results[1]!.placed).toEqual({ start: 8, end: 10 });
    expect(warnings).toHaveLength(1);
  });

  it.each([
    ['an unknown preset', { preset: 'banner' }, /preset/],
    ['an unknown animation kind', { enter: { kind: 'spin', duration: 0.3 } }, /enter\.kind/],
    ['a font size above the limit', { fontSize: 0.5 }, /fontSize/],
    ['a weight that is not offered', { fontWeight: 650 }, /fontWeight/],
    ['a colour that is not #rrggbb', { color: 'red' }, /color/],
    ['empty text', { text: '   ' }, /text/],
    ['a misspelled field', { colour: '#FFFFFF' }, /colour/],
  ])('refuses %s', (_, extra, message) => {
    expect(() => parseOps([{ op: 'addText', start: 1, end: 3, text: 'Hola', ...extra }])).toThrow(message);
  });

  it('updates fields, merges nested ones, converts animation seconds, drops and adds a background', () => {
    const added = run([{ op: 'addText', start: 1, end: 4, text: 'Hola', preset: 'lower-third' }]);
    const id = added.results[0]!.id!;
    const [t] = texts([
      { op: 'updateItem', track: 'texts', id, patch: { text: 'Adiós', position: { y: 0.5 }, background: { opacity: 0.4 }, exit: { duration: 1 } } },
    ], added.project);
    expect(t).toMatchObject({ text: 'Adiós', position: { x: 0.06, y: 0.5 }, background: { color: '#C2410C', opacity: 0.4 }, exit: { kind: 'fade', duration: 1 } });
    const dropped = apply([{ op: 'updateItem', track: 'texts', id, patch: { background: null } }], added.project);
    expect(dropped.texts[0]).not.toHaveProperty('background');
    expect(() => apply([{ op: 'updateItem', track: 'texts', id, patch: { background: { opacity: 0.5 } } }], dropped)).toThrow(/give all of color, opacity, padding, radius/);
    expect(apply([{ op: 'updateItem', track: 'texts', id, patch: { shadow: { color: '#000000', opacity: 0.5, blur: 0.2, offsetY: 0.05 } } }], dropped).texts[0]!.shadow).toBeDefined();
  });

  it('refuses a text patch with an out-of-range value, a misspelled field or a locked field', () => {
    const added = run([{ op: 'addText', start: 1, end: 4, text: 'Hola' }]);
    const id = added.results[0]!.id!;
    expect(() => run([{ op: 'updateItem', track: 'texts', id, patch: { fontSize: 2 } }], added.project)).toThrow(/texts\.fontSize/);
    expect(() => run([{ op: 'updateItem', track: 'texts', id, patch: { colour: '#000000' } }], added.project)).toThrow(/colour/);
    expect(() => run([{ op: 'updateItem', track: 'texts', id, patch: { id: 'x' } }], added.project)).toThrow(/texts\.id/);
  });

  it('retimes and removes a text', () => {
    const added = run([{ op: 'addText', start: 1, end: 4, text: 'Hola' }, { op: 'addText', start: 2, end: 3, text: 'Otro' }]);
    const id = added.results[0]!.id!;
    const moved = run([{ op: 'updateItem', track: 'texts', id, start: 2.5, end: 5 }], added.project);
    expect(describeProject(moved.project).texts.find((t) => t.text === 'Hola')!.shown).toEqual([{ start: 2.5, end: 5 }]);
    expect(edit([{ op: 'removeItem', track: 'texts', id: moved.results[0]!.id! }], moved.project).texts.map((t) => t.text)).toEqual(['Otro']);
  });
});

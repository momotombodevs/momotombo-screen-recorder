import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { frameDuration, secondsToTicks as sec } from '@momotombo/timing';
import {
  ProjectFormatError, addCameraLayout, addPrivacy, addRecording, addZoom, applyEasing, cameraAt, createProject,
  defaultCameraLayout, evaluate, frameGeometry, parseCursorLog, parseProject, prepareCursor, presetTransition,
  privacyActive, privacyRegionAt, resolveOverlaps, sequenceDuration, serializeProject, springResponse, springSettleTime, zoomViewAt,
  type CameraLayoutItem, type PrivacyItem, type Project, type Recording, type ZoomItem,
} from './index';

function rec(id = 'r1', seconds = 60): Recording {
  return {
    id, createdAt: '2026-10-16T00:00:00Z', duration: sec(seconds),
    sources: {
      screen: { kind: 'screen', file: 'media/s.mp4', mime: 'video/mp4', width: 1920, height: 1080, fps: 30, startOffset: 0, duration: sec(seconds) },
      camera: { kind: 'camera', file: 'media/c.mp4', mime: 'video/mp4', width: 1280, height: 720, fps: 30, startOffset: sec(-0.2), duration: sec(seconds) },
    },
    capture: { backend: 'web', platform: 't', target: { kind: 'display', label: '', bounds: { x: 0, y: 0, w: 1920, h: 1080 }, scaleFactor: 2 }, cursorInFrames: false, hasClicks: true },
    syncOffsets: { camera: sec(-0.04) }, markers: [sec(3)],
  };
}

const zoom = (id: string, a: number, b: number, cx: number, extra: Partial<ZoomItem> = {}): ZoomItem => ({
  id, type: 'zoom', recordingId: 'r1', start: sec(a), end: sec(b), origin: 'manual', mode: 'region',
  center: { x: cx, y: 0.5 }, scale: 2, enter: presetTransition('smooth'), exit: presetTransition('smooth'), ...extra,
});

function projectWithEveryItemKind(): Project {
  let p = addRecording(createProject('Tam'), rec());
  p = addZoom(p, { recordingId: 'r1', start: sec(1), end: sec(4), origin: 'manual', mode: 'follow', center: { x: 0.3, y: 0.4 }, scale: 2, enter: presetTransition('smooth'), exit: { duration: sec(0.6), easing: { kind: 'spring', zeta: 0.72, omega: 12 } } }).project;
  p = addZoom(p, { recordingId: 'r1', start: sec(5), end: sec(7), origin: 'auto', mode: 'region', center: { x: 0.6, y: 0.4 }, scale: 1.6, enter: { duration: sec(0.5), easing: { kind: 'bezier', x1: 0.3, y1: -0.2, x2: 0.4, y2: 1.3 } }, exit: { duration: 0, easing: { kind: 'instant' } }, confidence: 0.8 }).project;
  p = addCameraLayout(p, { recordingId: 'r1', start: sec(2), end: sec(6), origin: 'manual', layout: { ...defaultCameraLayout(), shape: 'free', aspect: 1.3 }, enter: { duration: sec(0.4), easing: { kind: 'linear' } }, second: { position: { x: 0.2, y: 0.2 }, size: 0.3 }, split: 0.4 }).project;
  p = addPrivacy(p, { recordingId: 'r1', start: sec(8), end: sec(12), origin: 'manual', region: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, keyframes: [{ t: sec(8), region: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } }, { t: sec(12), region: { x: 0.5, y: 0.6, w: 0.2, h: 0.1 } }], effect: { kind: 'pixelate', block: 12 }, cornerRadius: 0.1, padFrames: 2 }).project;
  p = addPrivacy(p, { recordingId: 'r1', start: sec(9), end: sec(10), origin: 'manual', region: { x: 0.7, y: 0.7, w: 0.1, h: 0.1 }, keyframes: [], effect: { kind: 'blur', strength: 8 }, cornerRadius: 0, padFrames: 0 }).project;
  return p;
}

const saved = (p: Project = projectWithEveryItemKind()) => JSON.parse(serializeProject(p)) as Record<string, any>;

function expectFormatError(json: unknown, field: string) {
  let err: unknown;
  try { parseProject(json); } catch (e) { err = e; }
  expect(err, `expected ProjectFormatError naming ${field}`).toBeInstanceOf(ProjectFormatError);
  expect((err as Error).message).toContain(field);
}

function everyNumberIsFinite(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (v && typeof v === 'object') return Object.values(v).every(everyNumberIsFinite);
  return true;
}

describe('parseProject validates the whole file (defect 1)', () => {
  it('still opens what the app writes, unchanged', () => {
    for (const p of [createProject('x'), addRecording(createProject('y'), rec()), projectWithEveryItemKind()]) {
      const back = parseProject(saved(p));
      expect({ ...back, updatedAt: p.updatedAt }).toEqual(p);
    }
  });

  it('keeps the defaults for sections older files lack', () => {
    const j = saved();
    delete j.variants; delete j.activeVariantId; delete j.audio; delete j.zoomEngine; delete j.magnifiers; delete j.cameraLayouts;
    delete j.style.frame; delete j.privacy[0].keyframes; delete j.createdAt;
    const back = parseProject(j);
    expect(back.variants.map((v) => v.id)).toEqual(createProject('x').variants.map((v) => v.id));
    expect(back.style.frame).toEqual(createProject('x').style.frame);
    expect(back.privacy.find((x) => x.start === sec(8))!.keyframes).toEqual([]);
    expect(back.zoomEngine).toEqual({ sensitivity: 'medium' });
    expect(back.magnifiers).toEqual([]);
  });

  it('rejects a null item with ProjectFormatError, not a TypeError', () => {
    for (const key of ['privacy', 'zooms', 'cameraLayouts', 'magnifiers'] as const) {
      const j = saved(); j[key] = [null];
      expectFormatError(j, `${key}[0]`);
    }
  });

  it('rejects a frame rate that would make frames infinitely long', () => {
    for (const fps of [{ num: 0, den: 1 }, { num: 30, den: 0 }, { num: -30, den: 1 }, { num: 30.5, den: 1 }, { num: 'x', den: 1 }]) {
      const j = saved(); j.sequence.fps = fps;
      expectFormatError(j, 'sequence.fps');
    }
  });

  it('rejects segment times that are not finite or not increasing, and segments of missing recordings', () => {
    const j = JSON.parse(serializeProject(projectWithEveryItemKind()).replace(`"sourceEnd": ${sec(60)}`, '"sourceEnd": 1e999'));
    expectFormatError(j, 'sequence.segments[0].sourceEnd');
    const k = saved(); k.sequence.segments[0].sourceEnd = k.sequence.segments[0].sourceStart;
    expectFormatError(k, 'sequence.segments[0]');
    const m = saved(); m.sequence.segments[0].recordingId = 'nope';
    expectFormatError(m, 'sequence.segments[0].recordingId');
  });

  it('rejects style values of the wrong type', () => {
    const a = saved(); a.style = { frame: { padding: 'abc' } };
    expectFormatError(a, 'style.frame.padding');
    const b = saved(); b.style = { frame: { area: null } };
    expectFormatError(b, 'style.frame.area');
    const c = saved(); c.style.camera.size = null;
    expectFormatError(c, 'style.camera.size');
  });

  it('rejects variants without a positive size, and bad overrides', () => {
    const a = saved(); a.variants = [{ id: 'x', name: 'x', width: 0, height: 0 }]; a.activeVariantId = 'x';
    expectFormatError(a, 'variants[0].width');
    const b = saved(); b.variants[1].frameOverride.area = null;
    expectFormatError(b, 'variants[1].frameOverride.area');
  });

  it('rejects malformed zoom, privacy, camera and magnifier items', () => {
    const cases: [(j: Record<string, any>) => void, string][] = [
      [(j) => { j.zooms[0].end = j.zooms[0].start; }, 'zooms[0]'],
      [(j) => { j.zooms[0].scale = 0; }, 'zooms[0].scale'],
      [(j) => { j.zooms[0].center = { x: 0.5 }; }, 'zooms[0].center.y'],
      [(j) => { j.zooms[0].mode = 'spin'; }, 'zooms[0].mode'],
      [(j) => { j.zooms[0].enter.duration = -1; }, 'zooms[0].enter.duration'],
      [(j) => { j.zooms[1].enter.easing = { kind: 'bezier', x1: 2, y1: 0, x2: 0.5, y2: 1 }; }, 'zooms[1].enter.easing.x1'],
      [(j) => { j.zooms[0].exit.easing = { kind: 'warp' }; }, 'zooms[0].exit.easing.kind'],
      [(j) => { j.privacy[0].region = null; }, 'privacy[0].region'],
      [(j) => { j.privacy[0].keyframes[1] = { t: 'later', region: { x: 0, y: 0, w: 1, h: 1 } }; }, 'privacy[0].keyframes[1].t'],
      [(j) => { j.privacy[0].effect = { kind: 'pixelate', block: 0 }; }, 'privacy[0].effect.block'],
      [(j) => { j.privacy[0].padFrames = -1; }, 'privacy[0].padFrames'],
      [(j) => { j.cameraLayouts[0].layout.position = null; }, 'cameraLayouts[0].layout.position'],
      [(j) => { j.cameraLayouts[0].second = { position: { x: 0, y: 0 }, size: 'big' }; }, 'cameraLayouts[0].second.size'],
      [(j) => { j.magnifiers = [{ id: 'm', type: 'magnifier', recordingId: 'r1', start: 0, end: sec(1), origin: 'manual', size: 280, zoom: Number.NaN }]; }, 'magnifiers[0].zoom'],
      [(j) => { j.recordings.r1.sources.screen.startOffset = null; }, 'recordings.r1.sources.screen.startOffset'],
      [(j) => { j.recordings.r1.capture.crop = { x: 0, y: 0, w: 0, h: 1 }; }, 'recordings.r1.capture.crop'],
    ];
    for (const [edit, field] of cases) {
      const j = saved(); edit(j);
      expectFormatError(j, field);
    }
  });

  it('does not let a "__proto__" key in the file change the style object', () => {
    const j = saved(); j.style = JSON.parse('{"__proto__": {"polluted": 1}}');
    const p = parseProject(j);
    expect(Object.getPrototypeOf(p.style)).toBe(Object.prototype);
    expect((p.style as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('never yields NaN or Infinity in a frame of a project it accepted', () => {
    const p = parseProject(saved());
    expect(Number.isFinite(sequenceDuration(p))).toBe(true);
    for (let t = 0; t < 60; t += 0.25) {
      for (const variantId of p.variants.map((v) => v.id)) {
        expect(everyNumberIsFinite(evaluate(p, sec(t), { variantId })), `t=${t} ${variantId}`).toBe(true);
      }
    }
  });
});

describe('zoom chaining across a gap shorter than 50 ms (defect 2)', () => {
  it('stays zoomed in between two adjacent zooms', () => {
    const geom = frameGeometry(1920, 1200, { padding: 0, radius: 0, shadow: { opacity: 0, blur: 0, offsetY: 0 }, border: { width: 0, color: '#fff' }, aspectMode: 'source', area: { x: 0, y: 0, w: 1, h: 1 } }, 1.6);
    const items = [zoom('a', 5, 9, 0.3), zoom('b', 9.03, 15, 0.7)];
    for (let t = 8.9; t <= 9.1 + 1e-9; t += 0.005) {
      expect(zoomViewAt(items, sec(t), geom).z, `t=${t.toFixed(3)}`).toBeCloseTo(2, 6);
    }
  });
  it('keeps the camera where the first move left it, instead of heading back to the base layout', () => {
    const at = (x: number) => ({ ...defaultCameraLayout(), position: { x, y: 0.5 } });
    const move = (id: string, a: number, b: number, x: number): CameraLayoutItem => ({ id, type: 'camera', recordingId: 'r1', start: sec(a), end: sec(b), origin: 'manual', layout: at(x), enter: { duration: sec(0.4), easing: { kind: 'linear' } } });
    const items = [move('a', 5, 9, 0.2), move('b', 9.03, 15, 0.2)];
    for (const t of [8.99, 9.01, 9.02, 9.04]) {
      expect(cameraAt(items, sec(t), at(0.9), 16 / 9).position.x, `t=${t}`).toBeCloseTo(0.2, 6);
    }
  });
});

describe('resolveOverlaps as the load-time repair (defect 3)', () => {
  const base = () => addRecording(createProject('x'), rec());

  it('sorts items by start even when nothing overlaps', () => {
    const q = { ...base(), zooms: [zoom('late', 20, 25, 0.5), zoom('early', 1, 3, 0.5)] };
    const r = resolveOverlaps(q);
    expect(r).not.toBe(q);
    expect(r.zooms.map((z) => z.id)).toEqual(['early', 'late']);
  });

  it('removes zoom, camera and magnifier items shorter than MIN_ITEM, but keeps short privacy areas', () => {
    const priv: PrivacyItem = { id: 'p', type: 'privacy', recordingId: 'r1', start: sec(1), end: sec(1.05), origin: 'manual', region: { x: 0, y: 0, w: 0.1, h: 0.1 }, keyframes: [], effect: { kind: 'frosted' }, cornerRadius: 0, padFrames: 0 };
    const q = { ...base(), zooms: [zoom('tiny', 1, 1.05, 0.5)], privacy: [priv] };
    const r = resolveOverlaps(q);
    expect(r.zooms).toEqual([]);
    expect(r.privacy).toEqual([priv]);
  });

  it('returns the same project when it is already valid', () => {
    const p = projectWithEveryItemKind();
    expect(resolveOverlaps(p)).toBe(p);
  });

  it('lets the evaluator pick the right item from a hand-edited, unsorted file', () => {
    const geom = frameGeometry(1920, 1080, createProject('x').style.frame, 16 / 9);
    const unsorted = [zoom('late', 20, 25, 0.5, { scale: 3 }), zoom('early', 1, 3, 0.5)];
    expect(zoomViewAt(unsorted, sec(2), geom).z).toBeCloseTo(2, 6);
    const layout = (x: number) => ({ ...defaultCameraLayout(), position: { x, y: 0.5 } });
    const cam = (id: string, a: number, b: number, x: number): CameraLayoutItem => ({ id, type: 'camera', recordingId: 'r1', start: sec(a), end: sec(b), origin: 'manual', layout: layout(x), enter: { duration: 0, easing: { kind: 'instant' } } });
    expect(cameraAt([cam('late', 20, 25, 0.9), cam('early', 1, 3, 0.1)], sec(2), defaultCameraLayout(), 16 / 9).position.x).toBeCloseTo(0.1, 6);
  });
});

describe('privacy keyframes out of order (defect 4)', () => {
  const item = { ...projectWithEveryItemKind().privacy[0]!, region: { x: 0, y: 0, w: 0.1, h: 0.1 }, keyframes: [{ t: sec(10), region: { x: 0.8, y: 0, w: 0.1, h: 0.1 } }, { t: sec(2), region: { x: 0.1, y: 0, w: 0.1, h: 0.1 } }] };

  it('interpolates as if they were sorted', () => {
    expect(privacyRegionAt(item, sec(6)).x).toBeCloseTo(0.45, 6);
  });

  it('are sorted when the file is opened', () => {
    const j = saved(); j.privacy[0].keyframes.reverse();
    expect(parseProject(j).privacy[0]!.keyframes.map((k) => k.t)).toEqual([sec(8), sec(12)]);
  });
});

describe('spring easing (defect 5)', () => {
  it('is finite for any parameters', () => {
    for (const zeta of [-1, 0, 1e-9, 0.01, 0.5, 1, 1.5, 4, 1e6, Number.NaN, Infinity]) {
      for (const omega of [-5, 0, 1e-9, 1, 12, 1e6, Number.NaN, Infinity]) {
        for (const u of [0, 0.1, 0.5, 0.9, 1]) {
          const v = springResponse(zeta, omega, u);
          expect(Number.isFinite(v), `zeta=${zeta} omega=${omega} u=${u} -> ${v}`).toBe(true);
        }
      }
    }
  });

  it('treats an overdamped spring as overdamped: slower than critical damping, and still settles at u = 1', () => {
    const atSeconds = (zeta: number, t: number) => springResponse(zeta, 10, t / springSettleTime(zeta, 10));
    expect(atSeconds(3, 0.2)).toBeLessThan(atSeconds(1, 0.2));
    const over = (u: number) => springResponse(3, 10, u);
    for (let u = 0; u <= 1; u += 0.05) {
      expect(over(u)).toBeGreaterThanOrEqual(0);
      expect(over(u)).toBeLessThanOrEqual(1);
    }
    expect(over(0.999)).toBeGreaterThan(0.998);
    expect(applyEasing({ kind: 'spring', zeta: 3, omega: 10 }, 1)).toBe(1);
  });

  it('is rejected at the file boundary when its parameters are invalid', () => {
    for (const [zeta, omega, field] of [[0.5, 0, 'omega'], [0, 12, 'zeta'], [-0.5, 12, 'zeta'], [0.5, null, 'omega']] as const) {
      const j = saved(); j.zooms[0].enter = { duration: sec(1), easing: { kind: 'spring', zeta, omega } };
      expectFormatError(j, `zooms[0].enter.easing.${field}`);
    }
  });
});

describe('cursor log robustness (defects 6 and 7)', () => {
  it('skips lines that are valid JSON but not an object', () => {
    const track = parseCursorLog('{"e":"m","t":0,"x":0,"y":0}\nnull\n42\n"m"\n[1]\n{"e":"m","t":10,"x":1,"y":1}\n');
    expect(track.samples.map((s) => s.t)).toEqual([0, 10]);
  });

  it('drops a stray sample far past any real recording instead of sizing the grid for it', () => {
    const samples = Array.from({ length: 121 }, (_, i) => ({ t: sec(i / 60), x: i / 120, y: 0.5 }));
    const stray = { t: sec(13 * 3600), x: 0, y: 0 };
    const c = prepareCursor({ samples: [...samples, stray], clicks: [], scrolls: [] });
    expect(c.end).toBe(sec(2));
    expect(c.rawAt(sec(3))!.x).toBeCloseTo(1, 6);
  });

  it('drops samples whose time is not a sane recording time', () => {
    const c = prepareCursor({ samples: [{ t: -1e18, x: 0, y: 0 }, { t: 0, x: 0.2, y: 0.2 }, { t: sec(1), x: 0.4, y: 0.4 }, { t: 1e18, x: 1, y: 1 }, { t: Number.NaN, x: 1, y: 1 }], clicks: [], scrolls: [] });
    expect([c.start, c.end]).toEqual([0, sec(1)]);
  });

  it('returns promptly for a sample at t = 1e18 (run in a child process so a regression cannot hang the suite)', () => {
    const script = `const { prepareCursor } = await import(${JSON.stringify(fileURLToPath(new URL('./cursor.ts', import.meta.url)))});
const c = prepareCursor({ samples: [{ t: 0, x: 0, y: 0 }, { t: 1e18, x: 1, y: 1 }], clicks: [], scrolls: [] });
process.stdout.write(String(c.end));`;
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], { timeout: 20_000, encoding: 'utf8' });
    expect(r.signal, r.stderr).toBeNull();
    expect(r.stdout).toBe('0');
  }, 30_000);
});

describe('privacy padding with a parsed frame rate', () => {
  it('a valid sequence keeps privacy active mid-item', () => {
    const p = parseProject(saved());
    const item = p.privacy[0]!;
    expect(privacyActive(item, sec(10), frameDuration(p.sequence.fps))).toBe(true);
  });
});

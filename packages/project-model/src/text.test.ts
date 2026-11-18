import { describe, expect, it } from 'vitest';
import { secondsToTicks as sec } from '@momotombo/timing';
import {
  History, TEXT_ANIMATION_KINDS, TEXT_PRESETS, TEXT_PRESET_IDS, addRecording, addText, conflictsFor, createProject, evaluate, laneRange,
  parseProject, placeItem, removeText, removeTimelineRange, resolveOverlaps, serializeProject, textAnimationAt, updateText,
  type NewText, type Project, type Recording, type TextAnimationKind,
} from './index';

function rec(): Recording {
  return {
    id: 'r1', createdAt: '2026-11-17T00:00:00Z', duration: sec(10),
    sources: { screen: { kind: 'screen', file: 'media/s.mp4', mime: 'video/mp4', width: 1920, height: 1080, fps: 30, startOffset: 0, duration: sec(10) } },
    capture: { backend: 'native-macos', platform: 'test', target: { kind: 'display', label: 'Screen', bounds: { x: 0, y: 0, w: 1920, h: 1080 }, scaleFactor: 1 }, cursorInFrames: false, hasClicks: false },
    syncOffsets: {}, markers: [],
  };
}

const base = () => addRecording(createProject('Text'), rec());
const text = (start: number, end: number, extra: Partial<NewText> = {}): NewText => ({
  recordingId: 'r1', start: sec(start), end: sec(end), origin: 'manual', text: 'Hello', ...TEXT_PRESETS.title, ...extra,
});
const withText = (extra: Partial<NewText> = {}, start = 2, end = 6): Project => addText(base(), text(start, end, extra)).project;
const reparse = (p: Project, edit: (json: Record<string, unknown>) => void = () => {}) => {
  const json = JSON.parse(serializeProject(p)) as Record<string, unknown>;
  edit(json);
  return parseProject(json);
};
const firstText = (json: Record<string, unknown>) => (json.texts as Record<string, unknown>[])[0]!;

describe('text items in project files', () => {
  it('opens a project saved before texts existed, with no texts and nothing else changed', () => {
    const p = base();
    const reopened = reparse(p, (json) => { delete json.texts; });
    expect(reopened.texts).toEqual([]);
    expect({ ...reopened, updatedAt: '' }).toEqual({ ...reparse(p), updatedAt: '' });
  });

  it('keeps every preset through save and open', () => {
    let p = base();
    for (const [i, id] of TEXT_PRESET_IDS.entries()) p = addText(p, { ...text(i, i + 1), ...TEXT_PRESETS[id], text: `${id}\nline 2` }).project;
    expect(reparse(p).texts).toEqual(p.texts);
  });

  it.each([
    ['an unknown animation kind', (t: Record<string, unknown>) => { t.enter = { kind: 'spin', duration: sec(0.3) }; }, 'texts[0].enter.kind'],
    ['an unknown anchor', (t: Record<string, unknown>) => { t.anchor = 'middle'; }, 'texts[0].anchor'],
    ['a font size above the limit', (t: Record<string, unknown>) => { t.fontSize = 0.5; }, 'texts[0].fontSize'],
    ['a position off the canvas', (t: Record<string, unknown>) => { t.position = { x: 1.2, y: 0.5 }; }, 'texts[0].position.x'],
    ['a weight that is not offered', (t: Record<string, unknown>) => { t.fontWeight = 650; }, 'texts[0].fontWeight'],
    ['a colour that is not #rrggbb', (t: Record<string, unknown>) => { t.color = 'red'; }, 'texts[0].color'],
    ['empty text', (t: Record<string, unknown>) => { t.text = '  \n'; }, 'texts[0].text'],
    ['text over 500 characters', (t: Record<string, unknown>) => { t.text = 'x'.repeat(501); }, 'texts[0].text'],
    ['a background opacity above 1', (t: Record<string, unknown>) => { t.background = { color: '#000000', opacity: 1.5, padding: 0.3, radius: 0.2 }; }, 'texts[0].background.opacity'],
    ['a stroke wider than allowed', (t: Record<string, unknown>) => { t.stroke = { color: '#000000', width: 1 }; }, 'texts[0].stroke.width'],
    ['an animation longer than 5 s', (t: Record<string, unknown>) => { t.exit = { kind: 'fade', duration: sec(6) }; }, 'texts[0].exit.duration'],
    ['an empty range', (t: Record<string, unknown>) => { t.end = t.start; }, 'texts[0]'],
  ])('rejects %s, naming the field', (_, edit, field) => {
    expect(() => reparse(withText(), (json) => edit(firstText(json)))).toThrow(field);
  });
});

describe('text animation', () => {
  const item = (enter: TextAnimationKind, exit: TextAnimationKind = 'none') => ({
    start: sec(2), end: sec(6), text: 'Hola mundo', enter: { kind: enter, duration: sec(0.5) }, exit: { kind: exit, duration: sec(0.5) },
  });

  it('is absent before start and at end, for every kind', () => {
    for (const kind of TEXT_ANIMATION_KINDS) {
      expect(textAnimationAt(item(kind, kind), sec(1.99))).toBeNull();
      expect(textAnimationAt(item(kind, kind), sec(6))).toBeNull();
    }
  });

  it('is settled between the enter and the exit, for every kind', () => {
    for (const kind of TEXT_ANIMATION_KINDS) {
      expect(textAnimationAt(item(kind, kind), sec(4))).toEqual({ opacity: 1, offsetEm: { x: 0, y: 0 }, scale: 1, visibleChars: 10 });
    }
  });

  it('starts hidden at start and settles exactly when the enter ends', () => {
    expect(textAnimationAt(item('fade'), sec(2))!.opacity).toBe(0);
    expect(textAnimationAt(item('fade'), sec(2.25))!.opacity).toBeGreaterThan(0.5);
    expect(textAnimationAt(item('fade'), sec(2.5))!.opacity).toBe(1);
    expect(textAnimationAt(item('none'), sec(2))!.opacity).toBe(1);
  });

  it('slides in from the opposite side of its direction and out along it', () => {
    const dirs = { 'slide-up': [0, 1], 'slide-down': [0, -1], 'slide-left': [1, 0], 'slide-right': [-1, 0] } as const;
    for (const [kind, [dx, dy]] of Object.entries(dirs) as [TextAnimationKind, readonly [number, number]][]) {
      const entering = textAnimationAt(item(kind), sec(2))!;
      expect(Math.sign(entering.offsetEm.x)).toBe(dx);
      expect(Math.sign(entering.offsetEm.y)).toBe(dy);
      expect(entering.opacity).toBe(0);
      const leaving = textAnimationAt(item('none', kind), sec(5.9))!;
      expect(Math.sign(leaving.offsetEm.x)).toBe(-dx || 0);
      expect(Math.sign(leaving.offsetEm.y)).toBe(-dy || 0);
      expect(leaving.opacity).toBeLessThan(1);
    }
  });

  it('pops from smaller, overshoots, then settles at full size', () => {
    expect(textAnimationAt(item('pop'), sec(2))!.scale).toBeCloseTo(0.6);
    const samples = Array.from({ length: 50 }, (_, i) => textAnimationAt(item('pop'), sec(2 + i * 0.01))!.scale);
    expect(Math.max(...samples)).toBeGreaterThan(1);
    expect(textAnimationAt(item('pop'), sec(2.5))!.scale).toBe(1);
  });

  it('types the text in one character at a time and deletes it on exit', () => {
    expect(textAnimationAt(item('typewriter'), sec(2))!.visibleChars).toBe(0);
    expect(textAnimationAt(item('typewriter'), sec(2.25))!.visibleChars).toBe(5);
    expect(textAnimationAt(item('typewriter'), sec(2.5))!.visibleChars).toBe(10);
    expect(textAnimationAt(item('typewriter'), sec(2))!.opacity).toBe(1);
    expect(textAnimationAt(item('none', 'typewriter'), sec(5.75))!.visibleChars).toBe(5);
  });

  it('counts emoji and accents as single characters', () => {
    expect(textAnimationAt({ ...item('typewriter'), text: 'añ👋' }, sec(4))!.visibleChars).toBe(3);
  });

  it('shortens enter and exit together when the range is too short for both', () => {
    const short = { ...item('fade', 'fade'), start: sec(2), end: sec(2.5) };
    expect(textAnimationAt(short, sec(2.25))!.opacity).toBeCloseTo(1, 5);
    expect(textAnimationAt(short, sec(2.1))!.opacity).toBeLessThan(1);
  });
});

describe('text layers in the render plan', () => {
  it('places the text on the canvas, sized from its shorter side, for every format', () => {
    const p = withText({ position: { x: 0.25, y: 0.75 }, fontSize: 0.1, maxWidth: 0.5 });
    for (const v of p.variants) {
      const [layer] = evaluate(p, sec(4), { variantId: v.id }).texts;
      expect(layer!.position).toEqual({ x: 0.25 * v.width, y: 0.75 * v.height });
      expect(layer!.fontSize).toBeCloseTo(0.1 * Math.min(v.width, v.height));
      expect(layer!.maxWidth).toBeCloseTo(0.5 * v.width);
    }
  });

  it('is not moved by a zoom on the screen', () => {
    const plain = withText();
    const zoomed = placeItem(plain, 'zooms', {
      recordingId: 'r1', start: sec(1), end: sec(8), origin: 'manual', mode: 'region', center: { x: 0.2, y: 0.2 }, scale: 3,
      enter: { duration: 0, easing: { kind: 'instant' } }, exit: { duration: 0, easing: { kind: 'instant' } },
    });
    if (!zoomed.ok) throw new Error('zoom not placed');
    expect(evaluate(zoomed.project, sec(4)).texts).toEqual(evaluate(plain, sec(4)).texts);
  });

  it('turns em lengths into pixels at the output size', () => {
    const p = withText({ fontSize: 0.05, background: { color: '#000000', opacity: 0.5, padding: 0.5, radius: 0.25 }, stroke: { color: '#000000', width: 0.1 } });
    const [layer] = evaluate(p, sec(4)).texts;
    expect(layer!.fontSize).toBeCloseTo(54);
    expect(layer!.background!.padding).toBeCloseTo(27);
    expect(layer!.stroke!.width).toBeCloseTo(5.4);
  });

  it('follows its content through a cut before it', () => {
    const p = withText({}, 5, 8);
    const cut = removeTimelineRange(p, sec(1), sec(3));
    expect(cut.texts).toEqual(p.texts);
    expect(evaluate(cut, sec(4)).texts).toHaveLength(1);
    expect(evaluate(cut, sec(2.9)).texts).toHaveLength(0);
  });

  it('shows only the part of its range left on the timeline when a cut goes through it', () => {
    const p = withText({ enter: { kind: 'none', duration: 0 } }, 2, 6);
    const cut = removeTimelineRange(p, sec(3), sec(5));
    expect(evaluate(cut, sec(2.5)).texts).toHaveLength(1);
    expect(evaluate(cut, sec(3.5)).texts[0]!.opacity).toBe(1);
    expect(evaluate(cut, sec(4.1)).texts).toHaveLength(0);
  });

  it('draws later-starting texts on top', () => {
    const p = addText(withText({ text: 'first' }, 2, 6), text(3, 5, { text: 'second' })).project;
    expect(evaluate(p, sec(4)).texts.map((l) => l.text)).toEqual(['first', 'second']);
  });
});

describe('text placement and commands', () => {
  it('lets texts share time with each other', () => {
    const p = withText({}, 2, 6);
    const second = placeItem(p, 'texts', text(3, 5, { position: { x: 0.5, y: 0.9 } }));
    expect(second.ok && !second.trimmed).toBe(true);
    if (!second.ok) return;
    expect(conflictsFor(second.project, 'texts', second.project.texts[0]!)).toEqual([]);
    expect(laneRange(second.project, 'texts', sec(4), sec(7))).toEqual({ recordingId: 'r1', start: sec(4), end: sec(7) });
    expect(resolveOverlaps(second.project)).toBe(second.project);
  });

  it('adds, updates and removes, and undo brings each step back', () => {
    const history = new History(base());
    const added = addText(history.present, text(1, 3));
    history.push(added.project);
    history.push(updateText(history.present, added.id, { text: 'Changed', background: { color: '#112233', opacity: 1, padding: 0.4, radius: 0.2 } }));
    expect(history.present.texts[0]!.text).toBe('Changed');
    expect(history.present.texts[0]!.anchor).toBe('center');
    history.push(removeText(history.present, added.id));
    expect(history.present.texts).toEqual([]);
    history.undo();
    expect(history.present.texts[0]!.text).toBe('Changed');
    history.undo();
    expect(history.present.texts[0]!.text).toBe('Hello');
    history.undo();
    expect(history.present.texts).toEqual([]);
  });
});

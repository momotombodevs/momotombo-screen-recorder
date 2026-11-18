import { describe, expect, it } from 'vitest';
import type { TextLayer } from '@momotombo/project-model';
import { RasterCache, anchoredBox, rasterFit, rasterKey, revealedLines, wrapText } from './text-raster';

const width = (s: string) => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)).length * 10;
const lines = (text: string, max: number, measure = width) => wrapText(text, max, measure).map((l) => text.slice(l.start, l.end));

describe('wrapText', () => {
  it('keeps a line that fits', () => {
    expect(lines('hola mundo', 200)).toEqual(['hola mundo']);
  });

  it('breaks at spaces before the line gets too wide', () => {
    expect(lines('uno dos tres cuatro', 80)).toEqual(['uno dos', 'tres', 'cuatro']);
  });

  it('keeps the line breaks written in the text, empty lines included', () => {
    expect(lines('a\n\nb', 100)).toEqual(['a', '', 'b']);
  });

  it('splits a word longer than a line between characters', () => {
    expect(lines('abcdefghij', 40)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('never splits inside a joined emoji, a flag or an accented letter', () => {
    expect(lines('ab👨‍👩‍👧🇳🇮é', 20)).toEqual(['ab', '👨‍👩‍👧🇳🇮', 'é']);
  });

  it('wraps the same way at any scale', () => {
    const text = 'Momotombo graba tu pantalla y la edita';
    expect(lines(text, 120, (s) => width(s) * 3.7)).toEqual(lines(text, 120 / 3.7));
  });
});

describe('revealedLines', () => {
  const text = 'uno dos tres';
  const spans = wrapText(text, 80, width);

  it('reveals characters in reading order, counting the space at the line break', () => {
    expect(revealedLines(text, spans, 0)).toEqual(['', '']);
    expect(revealedLines(text, spans, 3)).toEqual(['uno', '']);
    expect(revealedLines(text, spans, 8)).toEqual(['uno dos', '']);
    expect(revealedLines(text, spans, 9)).toEqual(['uno dos', 't']);
    expect(revealedLines(text, spans, 11)).toEqual(['uno dos', 'tre']);
  });

  it('shows the whole text only when every character is revealed', () => {
    expect(revealedLines(text, spans, 12)).toEqual(['uno dos', 'tres']);
  });

  it('reveals a joined emoji whole', () => {
    const emoji = 'a👨‍👩‍👧';
    expect(revealedLines(emoji, wrapText(emoji, 100, width), 2)).toEqual([emoji]);
    expect(revealedLines(emoji, wrapText(emoji, 100, width), 1)).toEqual(['a']);
  });
});

describe('rasterFit', () => {
  it('keeps full resolution when the raster is small', () => {
    expect(rasterFit(800, 200, 16384, 16_000_000)).toBe(1);
  });

  it('scales down to the largest texture side', () => {
    expect(rasterFit(8000, 100, 4096, 16_000_000)).toBeCloseTo(4096 / 8000);
  });

  it('scales down so the raster stays under the pixel budget', () => {
    const fit = rasterFit(6000, 6000, 16384, 16_000_000);
    expect(6000 * fit * 6000 * fit).toBeLessThanOrEqual(16_000_000 + 1);
  });
});

const layer = (patch: Partial<TextLayer> = {}): TextLayer => ({
  id: 't1', text: 'Hola', visibleGraphemes: 4, position: { x: 10, y: 10 }, anchor: 'center', align: 'center', fontSize: 50, fontWeight: 700,
  color: '#FFFFFF', maxWidth: 900, background: null, stroke: null, shadow: null, opacity: 1, scale: 1, offset: { x: 0, y: 0 }, ...patch,
});

describe('text raster cache', () => {
  it('reuses a raster across frames whose only change is animation or position', () => {
    const base = rasterKey(layer());
    expect(rasterKey(layer({ opacity: 0.3, scale: 1.1, offset: { x: 4, y: 0 }, position: { x: 99, y: 9 } }))).toBe(base);
  });

  it('makes a new raster when the output size, text or reveal changes', () => {
    const base = rasterKey(layer());
    expect(rasterKey(layer({ fontSize: 100, maxWidth: 1800 }))).not.toBe(base);
    expect(rasterKey(layer({ text: 'Adiós' }))).not.toBe(base);
    expect(rasterKey(layer({ visibleGraphemes: 2 }))).not.toBe(base);
  });

  it('creates once per key, and frees what a frame did not use', () => {
    const created: string[] = [];
    const freed: string[] = [];
    const cache = new RasterCache<string>((v) => freed.push(v));
    const get = (key: string) => cache.get(key, () => { created.push(key); return key; });
    get('a'); get('a'); get('b');
    cache.endFrame();
    expect(created).toEqual(['a', 'b']);
    get('a');
    cache.endFrame();
    expect(freed).toEqual(['b']);
    get('b');
    expect(created).toEqual(['a', 'b', 'b']);
  });
});

describe('anchoredBox', () => {
  it('puts the anchor point of the box at the position', () => {
    expect(anchoredBox('top-left', { x: 100, y: 50 }, 40, 20)).toEqual({ x: 100, y: 50, w: 40, h: 20 });
    expect(anchoredBox('center', { x: 100, y: 50 }, 40, 20)).toEqual({ x: 80, y: 40, w: 40, h: 20 });
    expect(anchoredBox('bottom-right', { x: 100, y: 50 }, 40, 20)).toEqual({ x: 60, y: 30, w: 40, h: 20 });
  });
});

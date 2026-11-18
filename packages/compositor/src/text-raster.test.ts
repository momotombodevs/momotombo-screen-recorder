import { describe, expect, it } from 'vitest';
import { anchoredBox, wrapText } from './text-raster';

const width = (s: string) => Array.from(s).length * 10;

describe('wrapText', () => {
  it('keeps a line that fits', () => {
    expect(wrapText('hola mundo', 200, width)).toEqual(['hola mundo']);
  });

  it('breaks at spaces before the line gets too wide', () => {
    expect(wrapText('uno dos tres cuatro', 80, width)).toEqual(['uno dos', 'tres', 'cuatro']);
  });

  it('keeps the line breaks written in the text, empty lines included', () => {
    expect(wrapText('a\n\nb', 100, width)).toEqual(['a', '', 'b']);
  });

  it('splits a word longer than a line between characters', () => {
    expect(wrapText('abcdefghij', 40, width)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('wraps the same way at any scale', () => {
    const text = 'Momotombo graba tu pantalla y la edita';
    expect(wrapText(text, 120, (s) => width(s) * 3.7)).toEqual(wrapText(text, 120 / 3.7, width));
  });
});

describe('anchoredBox', () => {
  it('puts the anchor point of the box at the position', () => {
    expect(anchoredBox('top-left', { x: 100, y: 50 }, 40, 20)).toEqual({ x: 100, y: 50, w: 40, h: 20 });
    expect(anchoredBox('center', { x: 100, y: 50 }, 40, 20)).toEqual({ x: 80, y: 40, w: 40, h: 20 });
    expect(anchoredBox('bottom-right', { x: 100, y: 50 }, 40, 20)).toEqual({ x: 60, y: 30, w: 40, h: 20 });
  });
});

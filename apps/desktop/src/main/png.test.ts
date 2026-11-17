import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { appIcon } from './png';

function decode(png: Buffer) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idat = png.subarray(41, 41 + png.readUInt32BE(33));
  const raw = inflateSync(idat);
  const stride = width * 4 + 1;
  const pixel = (x: number, y: number) => Array.from(raw.subarray(y * stride + 1 + x * 4, y * stride + 1 + x * 4 + 4));
  return { width, height, pixel };
}

describe('appIcon', () => {
  const size = 512;
  const scale = (size * 0.82) / 134;
  const origin = (size - 150 * scale) / 2;
  const at = (u: number, v: number) => [Math.floor(origin + u * scale), Math.floor(origin + v * scale)] as const;
  const icon = decode(appIcon(size));

  it('keeps the requested size and a transparent margin', () => {
    expect(icon.width).toBe(size);
    expect(icon.height).toBe(size);
    expect(icon.pixel(0, 0)[3]).toBe(0);
    expect(icon.pixel(size - 1, size - 1)[3]).toBe(0);
  });

  it('draws the near-black tile, the light back peak, the orange front peak and the record dot', () => {
    expect(icon.pixel(...at(75, 125))).toEqual([5, 5, 5, 255]);
    expect(icon.pixel(...at(95, 85))).toEqual([235, 235, 235, 255]);
    expect(icon.pixel(...at(60, 90))).toEqual([232, 78, 15, 255]);
    expect(icon.pixel(...at(103, 42))).toEqual([232, 78, 15, 255]);
  });
});

import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Minimal RGBA PNG encoder, used for generated tray icons (no image assets shipped). */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Anti-aliased filled circle; `ring` draws an outline instead. */
export function circleIcon(size: number, rgb: [number, number, number], ring = false): Buffer {
  const px = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  const r = size * 0.36;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = ring
        ? Math.max(0, Math.min(1, 1.2 - Math.abs(d - r) / (size * 0.06)))
        : Math.max(0, Math.min(1, r - d + 0.5));
      const i = (y * size + x) * 4;
      px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, px);
}

type Rgb = readonly [number, number, number];
type Point = readonly [number, number];

function roundBoxSdf(px: number, py: number, cx: number, cy: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function polygonSdf(px: number, py: number, poly: readonly Point[]): number {
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[i]!;
    const [bx, by] = poly[j]!;
    const ex = bx - ax;
    const ey = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey)));
    d = Math.min(d, Math.hypot(px - ax - ex * t, py - ay - ey * t));
    if ((ay > py) !== (by > py) && px < ax + ((py - ay) * ex) / ey) inside = !inside;
  }
  return inside ? -d : d;
}

const ICON_CANVAS = 150;
const ICON_TILE = 134;
const ICON_TILE_RADIUS = 30;
const ICON_EDGE_WIDTH = 1.5;
const ISOTYPE_SCALE = 96 / 2792;
const ISOTYPE_ORIGIN: Point = [27, 52];
const toIconSpace = (points: readonly Point[]): Point[] =>
  points.map(([x, y]) => [ISOTYPE_ORIGIN[0] + x * ISOTYPE_SCALE, ISOTYPE_ORIGIN[1] + y * ISOTYPE_SCALE]);
const BACK_PEAK = toIconSpace([[1324.695, 520.395], [2016.987, 1340.695], [2644.329, 1340.695], [1638.43, 148.69]]);
const FRONT_PEAK = toIconSpace([[185.39, 1340.695], [1815.76, 1340.695], [1000.581, 366.29]]);
const ERUPTION: Point = [103, 42];
const ERUPTION_RADIUS = 10;

const ICON_GROUND: Rgb = [0x05, 0x05, 0x05];
const ICON_EDGE: Rgb = [0x2d, 0x0e, 0x00];
const ICON_SNOW: Rgb = [0xeb, 0xeb, 0xeb];
const ICON_LAVA: Rgb = [0xe8, 0x4e, 0x0f];

/**
 * Momotombo's app icon, rasterized from the same design as `assets/icon.svg`: a near-black tile
 * with the two-peak isotype and the record dot erupting above the back peak.
 */
export function appIcon(size: number): Buffer {
  const px = new Uint8Array(size * size * 4);
  const tilePx = size * 0.82;
  const scale = tilePx / ICON_TILE;
  const origin = (size - ICON_CANVAS * scale) / 2;
  const centre = ICON_CANVAS / 2;
  const cov = (dDesign: number) => Math.max(0, Math.min(1, 0.5 - dDesign * scale));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5 - origin) / scale;
      const v = (y + 0.5 - origin) / scale;
      const dTile = roundBoxSdf(u, v, centre, centre, ICON_TILE / 2, ICON_TILE / 2, ICON_TILE_RADIUS);
      const aTile = cov(dTile);
      if (aTile <= 0) continue;
      const color: [number, number, number] = [...ICON_EDGE];
      const paint = (rgb: Rgb, a: number) => {
        for (let k = 0; k < 3; k++) color[k]! += (rgb[k]! - color[k]!) * a;
      };
      paint(ICON_GROUND, cov(dTile + ICON_EDGE_WIDTH));
      paint(ICON_SNOW, cov(polygonSdf(u, v, BACK_PEAK)));
      paint(ICON_LAVA, cov(polygonSdf(u, v, FRONT_PEAK)));
      paint(ICON_LAVA, cov(Math.hypot(u - ERUPTION[0], v - ERUPTION[1]) - ERUPTION_RADIUS));
      const i = (y * size + x) * 4;
      px[i] = Math.round(color[0]); px[i + 1] = Math.round(color[1]); px[i + 2] = Math.round(color[2]); px[i + 3] = Math.round(aTile * 255);
    }
  }
  return encodePng(size, size, px);
}

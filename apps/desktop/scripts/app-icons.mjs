import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appIcon } from '../src/main/png.ts';

const ICONSET = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
];

export function appIconPng() {
  const rendered = new Map();
  return (size) => {
    if (!rendered.has(size)) rendered.set(size, appIcon(size));
    return rendered.get(size);
  };
}

export function writeIcns(target) {
  const png = appIconPng();
  const work = mkdtempSync(join(tmpdir(), 'momotombo-icon-'));
  const iconset = join(work, 'Momotombo.iconset');
  mkdirSync(iconset);
  for (const [name, size] of ICONSET) writeFileSync(join(iconset, name), png(size));
  try {
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', target]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

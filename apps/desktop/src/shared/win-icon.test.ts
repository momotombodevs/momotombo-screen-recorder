import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { findResources, setIcons } from '../../../../tools/win-version-info.mjs';
import { cached } from '../../../../tools/electron-artifacts.mjs';

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const SECTION_RVA = 0x1000;
const SECTION_RAW = 0x400;

type Resource = { type: number; name: number; data: Buffer };

function fakeExe(resources: Resource[]): Buffer {
  const types = [...new Set(resources.map((r) => r.type))].sort((a, b) => a - b);
  const dirSize = (n: number) => 16 + 8 * n;
  let cursor = 0;
  const alloc = (size: number) => { const at = cursor; cursor += size; return at; };
  const writeDir = (b: Buffer, at: number, children: { id: number; to: number }[]) => {
    b.writeUInt16LE(children.length, at + 14);
    children.forEach((c, i) => { b.writeUInt32LE(c.id, at + 16 + 8 * i); b.writeUInt32LE(c.to >>> 0, at + 20 + 8 * i); });
  };
  const rootAt = alloc(dirSize(types.length));
  const typeDirs = types.map((type) => {
    const items = resources.filter((r) => r.type === type);
    const at = alloc(dirSize(items.length));
    const names = items.map((r) => {
      const langAt = alloc(dirSize(1));
      const entryAt = alloc(16);
      return { r, langAt, entryAt };
    });
    return { type, at, names };
  });
  const datas = typeDirs.flatMap((t) => t.names).map((n) => ({ ...n, dataAt: alloc(n.r.data.length + 8) }));
  const section = Buffer.alloc(cursor);
  writeDir(section, rootAt, typeDirs.map((t) => ({ id: t.type, to: 0x80000000 | t.at })));
  for (const t of typeDirs) writeDir(section, t.at, t.names.map((n) => ({ id: n.r.name, to: 0x80000000 | n.langAt })));
  for (const d of datas) {
    writeDir(section, d.langAt, [{ id: 0x409, to: d.entryAt }]);
    section.writeUInt32LE(SECTION_RVA + d.dataAt, d.entryAt);
    section.writeUInt32LE(d.r.data.length, d.entryAt + 4);
    d.r.data.copy(section, d.dataAt);
  }

  const pe = 0x40;
  const opt = pe + 24;
  const optSize = 240;
  const header = Buffer.alloc(SECTION_RAW);
  header.writeUInt16LE(0x5a4d, 0);
  header.writeUInt32LE(pe, 0x3c);
  header.writeUInt32LE(0x00004550, pe);
  header.writeUInt16LE(1, pe + 6);
  header.writeUInt16LE(optSize, pe + 20);
  header.writeUInt16LE(0x20b, opt);
  header.writeUInt32LE(SECTION_RVA, opt + 112 + 16);
  header.writeUInt32LE(section.length, opt + 112 + 20);
  const s = opt + optSize;
  header.writeUInt32LE(section.length, s + 8);
  header.writeUInt32LE(SECTION_RVA, s + 12);
  header.writeUInt32LE(section.length, s + 16);
  header.writeUInt32LE(SECTION_RAW, s + 20);
  return Buffer.concat([header, section]);
}

function iconGroup(images: { size: number; id: number; bytes: number }[]): Buffer {
  const b = Buffer.alloc(6 + 14 * images.length);
  b.writeUInt16LE(1, 2);
  b.writeUInt16LE(images.length, 4);
  images.forEach((img, i) => {
    const r = 6 + 14 * i;
    b[r] = img.size === 256 ? 0 : img.size;
    b[r + 1] = img.size === 256 ? 0 : img.size;
    b.writeUInt16LE(1, r + 4);
    b.writeUInt16LE(32, r + 6);
    b.writeUInt32LE(img.bytes, r + 8);
    b.writeUInt16LE(img.id, r + 12);
  });
  return b;
}

const fakePng = (size: number) => Buffer.from(`png-${size}`);

describe('Windows executable icon', () => {
  const images = [{ size: 16, id: 1, bytes: 64 }, { size: 256, id: 2, bytes: 128 }];
  const exe = () => fakeExe([
    { type: RT_GROUP_ICON, name: 1, data: iconGroup(images) },
    ...images.map((img) => ({ type: RT_ICON, name: img.id, data: Buffer.alloc(img.bytes, 0xaa) })),
  ]);

  it('replaces every image with a PNG of its size and updates the group records', () => {
    const buf = exe();
    expect(setIcons(buf, fakePng)).toEqual([16, 256]);
    const icons = findResources(buf, RT_ICON).entries;
    for (const img of images) {
      const e = icons.find((x) => x.name === img.id)!;
      expect(buf.subarray(e.offset, e.offset + e.size)).toEqual(fakePng(img.size));
    }
    const group = findResources(buf, RT_GROUP_ICON).entries[0]!;
    expect(buf.readUInt32LE(group.offset + 6 + 8)).toBe(fakePng(16).length);
    expect(buf.readUInt16LE(group.offset + 6 + 14 + 6)).toBe(32);
  });

  it('refuses an image that would not fit in place', () => {
    expect(() => setIcons(exe(), (size) => Buffer.alloc(size === 256 ? 129 : 1))).toThrow(/larger than the old one/);
  });
});

const zip = cached('electron:win32:x64');
describe.skipIf(!zip || !existsSync(zip))("Electron for Windows executable's icon", () => {
  let exe: Buffer;
  beforeAll(() => { exe = execFileSync('unzip', ['-p', zip!, 'electron.exe'], { maxBuffer: 512 * 1024 * 1024 }); }, 120_000);

  it("fits Momotombo's icon in place of Electron's", async () => {
    const { appIcon } = await import('../main/png');
    const buf = Buffer.from(exe);
    const sizes = setIcons(buf, appIcon);
    expect(sizes.length).toBeGreaterThan(0);
    expect(buf.length).toBe(exe.length);
  });
});

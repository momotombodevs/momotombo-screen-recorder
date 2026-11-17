import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileAtomic } from './fsutil';

const roots: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'momotombo-fsutil-'));
  roots.push(d);
  return d;
}

afterAll(async () => {
  await Promise.all(roots.map((d) => rm(d, { recursive: true, force: true })));
});

describe('writeFileAtomic', () => {
  it('lets 20 concurrent writes to one path all succeed, the last call winning', async () => {
    const dir = await tempDir();
    const target = join(dir, 'settings.json');
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => writeFileAtomic(target, `v${i}`)));
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await readFile(target, 'utf8')).toBe('v19');
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps call order when an earlier write is much larger than a later one', async () => {
    const dir = await tempDir();
    const target = join(dir, 'thumbnail.jpg');
    const big = new Uint8Array(32 * 1024 * 1024).fill(1);
    await Promise.all([writeFileAtomic(target, big), writeFileAtomic(target, 'small')]);
    expect(await readFile(target, 'utf8')).toBe('small');
  });

  it('removes its temp file when the final rename fails', async () => {
    const dir = await tempDir();
    const target = join(dir, 'occupied');
    await mkdir(target);
    await writeFile(join(target, 'keep'), 'x');
    await expect(writeFileAtomic(target, 'data')).rejects.toThrow();
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a failed write does not block the next write to the same path', async () => {
    const dir = await tempDir();
    const target = join(dir, 'occupied');
    await mkdir(target);
    await writeFile(join(target, 'keep'), 'x');
    await expect(writeFileAtomic(target, 'a')).rejects.toThrow();
    await rm(target, { recursive: true });
    await writeFileAtomic(target, 'b');
    expect(await readFile(target, 'utf8')).toBe('b');
  });
});

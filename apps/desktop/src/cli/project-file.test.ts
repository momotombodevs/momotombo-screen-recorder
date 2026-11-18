import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUPS_KEPT, WriteConflictError, backupDir, writeProjectTextIfUnchanged, writeProjectTextKeepingBackup,
} from '../main/project-file';

let dir: string;
const file = () => join(dir, 'project.json');
const backups = async () => (await readdir(backupDir(dir))).sort();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'momotombo-project-file-'));
  await writeFile(file(), 'v0');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('writeProjectTextIfUnchanged', () => {
  it('writes the new text and keeps the old one as the latest backup', async () => {
    await writeProjectTextIfUnchanged(dir, 'v0', 'v1');
    expect(await readFile(file(), 'utf8')).toBe('v1');
    expect(await readFile(`${file()}.bak`, 'utf8')).toBe('v0');
    expect(await backups()).toHaveLength(1);
  });

  it('writes nothing when the file changed since it was read', async () => {
    await writeFile(file(), 'saved by the editor');
    await expect(writeProjectTextIfUnchanged(dir, 'v0', 'v1')).rejects.toBeInstanceOf(WriteConflictError);
    expect(await readFile(file(), 'utf8')).toBe('saved by the editor');
    expect(await readdir(dir)).toEqual(['project.json']);
  });
});

describe('backup history', () => {
  it(`keeps the last ${BACKUPS_KEPT} versions, oldest dropped first`, async () => {
    for (let i = 1; i <= BACKUPS_KEPT + 2; i++) await writeProjectTextKeepingBackup(dir, `v${i}`);
    const kept = await backups();
    expect(kept).toHaveLength(BACKUPS_KEPT);
    const texts = await Promise.all(kept.map((n) => readFile(join(backupDir(dir), n), 'utf8')));
    expect(texts).toEqual(['v2', 'v3', 'v4', 'v5', 'v6']);
    expect(await readFile(`${file()}.bak`, 'utf8')).toBe('v6');
  });
});

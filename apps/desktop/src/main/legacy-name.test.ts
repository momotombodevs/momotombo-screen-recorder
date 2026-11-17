import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyData } from './legacy-name';

const PROJECTS = 'Proyectos Momotombo';

let dir = '';
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

async function setup(legacy: { name: string; projects: string }[]): Promise<{ videos: string; userData: string; support: string }> {
  dir = await mkdtemp(join(tmpdir(), 'momotombo-legacy-'));
  const videos = join(dir, 'Movies');
  const support = join(dir, 'Application Support');
  await mkdir(videos, { recursive: true });
  for (const { name, projects } of legacy) {
    await mkdir(join(videos, projects, 'p1', 'media'), { recursive: true });
    await writeFile(join(videos, projects, 'p1', 'project.json'), `{"name":"${name}"}`);
    await mkdir(join(support, name), { recursive: true });
    await writeFile(join(support, name, 'settings.json'), `{"from":"${name}"}`);
  }
  return { videos, userData: join(support, 'Momotombo'), support };
}

const SAHNE = { name: 'Sahne', projects: 'Sahne Projeleri' };
const ZEYVOLA = { name: 'Zeyvola', projects: 'Zeyvola Projeleri' };

describe('moving data from earlier names', () => {
  it('moves the development-name projects folder and copies its settings once', async () => {
    const { support, ...p } = await setup([SAHNE]);
    const done = await migrateLegacyData({ ...p, projectsFolder: PROJECTS });
    expect(done).toHaveLength(2);
    expect(await readFile(join(p.videos, PROJECTS, 'p1', 'project.json'), 'utf8')).toBe('{"name":"Sahne"}');
    expect(await readdir(p.videos)).toEqual([PROJECTS]);
    expect(await readFile(join(p.userData, 'settings.json'), 'utf8')).toBe('{"from":"Sahne"}');
    // The old settings stay where they were; a second start changes nothing.
    expect(await readFile(join(support, 'Sahne', 'settings.json'), 'utf8')).toBe('{"from":"Sahne"}');
    expect(await migrateLegacyData({ ...p, projectsFolder: PROJECTS })).toEqual([]);
  });

  it('moves the Zeyvola projects folder and copies the Zeyvola settings', async () => {
    const { support, ...p } = await setup([ZEYVOLA]);
    expect(await migrateLegacyData({ ...p, projectsFolder: PROJECTS })).toHaveLength(2);
    expect(await readFile(join(p.videos, PROJECTS, 'p1', 'project.json'), 'utf8')).toBe('{"name":"Zeyvola"}');
    expect(await readdir(p.videos)).toEqual([PROJECTS]);
    expect(await readFile(join(p.userData, 'settings.json'), 'utf8')).toBe('{"from":"Zeyvola"}');
    expect(await readFile(join(support, 'Zeyvola', 'settings.json'), 'utf8')).toBe('{"from":"Zeyvola"}');
    expect(await migrateLegacyData({ ...p, projectsFolder: PROJECTS })).toEqual([]);
  });

  it('prefers the most recent name when both earlier names left data', async () => {
    const { support: _, ...p } = await setup([SAHNE, ZEYVOLA]);
    expect(await migrateLegacyData({ ...p, projectsFolder: PROJECTS })).toHaveLength(2);
    expect(await readFile(join(p.videos, PROJECTS, 'p1', 'project.json'), 'utf8')).toBe('{"name":"Zeyvola"}');
    expect((await readdir(p.videos)).sort()).toEqual([PROJECTS, 'Sahne Projeleri']);
    expect(await readFile(join(p.userData, 'settings.json'), 'utf8')).toBe('{"from":"Zeyvola"}');
  });

  it('leaves every folder alone when the new one already exists', async () => {
    const { support: _, ...p } = await setup([SAHNE, ZEYVOLA]);
    await mkdir(join(p.videos, PROJECTS), { recursive: true });
    await mkdir(p.userData, { recursive: true });
    await writeFile(join(p.userData, 'settings.json'), '{"language":"tr"}');
    expect(await migrateLegacyData({ ...p, projectsFolder: PROJECTS })).toEqual([]);
    expect((await readdir(p.videos)).sort()).toEqual([PROJECTS, 'Sahne Projeleri', 'Zeyvola Projeleri']);
    expect(await readFile(join(p.userData, 'settings.json'), 'utf8')).toBe('{"language":"tr"}');
  });
});

import { mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeProject, type Recording } from '@momotombo/project-model';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getPreferredSystemLanguages: () => ['en-US'], getLocale: () => 'en' },
}));
const afterNextRead: { run?: () => Promise<void> } = {};
vi.mock('./project-file', async (original) => {
  const real = await original<typeof import('./project-file')>();
  return {
    ...real,
    readProjectText: async (dir: string) => {
      const text = await real.readProjectText(dir);
      const run = afterNextRead.run;
      afterNextRead.run = undefined;
      await run?.();
      return text;
    },
  };
});
const { ProjectStore } = await import('./projects');

const roots: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'momotombo-projects-'));
  roots.push(d);
  return d;
}

afterAll(async () => {
  await Promise.all(roots.map((d) => rm(d, { recursive: true, force: true })));
});

async function storeWith(count: number) {
  const store = new ProjectStore(await tempDir());
  await store.init();
  const created = [];
  for (let i = 0; i < count; i++) created.push(await store.create(`P${i}`));
  return { store, created };
}

const recording = {
  id: 'r1',
  createdAt: '2026-10-16T00:00:00Z',
  duration: 1000,
  sources: {
    screen: { kind: 'screen', file: 'media/s.mp4', mime: 'video/mp4', width: 100, height: 100, fps: 60, startOffset: 0, duration: 1000 },
  },
  capture: {
    backend: 'web', platform: 'test',
    target: { kind: 'display', label: 'E', bounds: { x: 0, y: 0, w: 10, h: 10 }, scaleFactor: 1 },
    cursorInFrames: false, hasClicks: true,
  },
  syncOffsets: {},
  markers: [],
} as unknown as Recording;

describe('ProjectStore: lookups during a rescan', () => {
  it('dirOf, resolve and read keep working while list() rescans', async () => {
    const { store, created } = await storeWith(6);
    const { id, dir } = created[0]!;
    const listing = store.list();
    expect(store.dirOf(id)).toBe(dir);
    expect(store.resolve(id, 'media/x.mp4')).toBe(join(dir, 'media', 'x.mp4'));
    const reading = store.read(id);
    await listing;
    expect((await reading).id).toBe(id);
  });

  it('dirOf keeps working while entries() rescans', async () => {
    const { store, created } = await storeWith(3);
    const scanning = store.entries();
    expect(store.dirOf(created[1]!.id)).toBe(created[1]!.dir);
    expect((await scanning).map((e) => e.id).sort()).toEqual(created.map((c) => c.id).sort());
  });

  it('keeps a project created while a scan runs', async () => {
    const { store } = await storeWith(5);
    const listing = store.list();
    const made = await store.create('Late');
    await listing;
    expect(store.dirOf(made.id)).toBe(made.dir);
    await store.entries();
    expect(store.dirOf(made.id)).toBe(made.dir);
  });

  it('does not bring back a project forgotten while a scan runs', async () => {
    const { store, created } = await storeWith(3);
    const { id, dir } = created[0]!;
    const listing = store.list();
    await rm(dir, { recursive: true });
    store.forget(id);
    await listing;
    expect(() => store.dirOf(id)).toThrow();
  });
});

describe('ProjectStore: read-modify-write is serialised with saves', () => {
  it('a save racing appendRecording keeps both changes', async () => {
    const { store, created } = await storeWith(1);
    const { id, project } = created[0]!;
    await Promise.all([
      store.appendRecording(id, recording),
      store.save(id, serializeProject({ ...project, name: 'Edited by user' })),
    ]);
    const final = await store.read(id);
    expect(final.name).toBe('Edited by user');
    expect(Object.keys(final.recordings)).toEqual(['r1']);
  });

  it('a stale save after an append keeps the recording and its clip, once', async () => {
    const { store, created } = await storeWith(1);
    const { id, project } = created[0]!;
    await store.appendRecording(id, recording);
    await store.save(id, serializeProject({ ...project, name: 'Stale edit' }));
    const merged = await store.read(id);
    expect(merged.name).toBe('Stale edit');
    expect(Object.keys(merged.recordings)).toEqual(['r1']);
    expect(merged.sequence.segments.map((s) => s.recordingId)).toEqual(['r1']);
    await store.save(id, serializeProject({ ...merged, sequence: { ...merged.sequence, segments: [] } }));
    expect((await store.read(id)).sequence.segments).toEqual([]);
  });

  it('rename racing appendRecording keeps both changes', async () => {
    const { store, created } = await storeWith(1);
    const { id } = created[0]!;
    await Promise.all([store.appendRecording(id, recording), store.rename(id, 'Renamed')]);
    const final = await store.read(id);
    expect(final.name).toBe('Renamed');
    expect(Object.keys(final.recordings)).toEqual(['r1']);
  });

  it('a failed append does not block later saves', async () => {
    const { store, created } = await storeWith(1);
    const { id, dir, project } = created[0]!;
    await writeFile(join(dir, 'project.json'), 'not json');
    await expect(store.appendRecording(id, recording)).rejects.toThrow();
    await store.save(id, serializeProject({ ...project, name: 'After' }));
    expect((await store.read(id)).name).toBe('After');
  });
});

describe('ProjectStore: importVideo', () => {
  it('removes the partial media folder when the copy fails, and rethrows', async () => {
    const { store, created } = await storeWith(1);
    const { id, dir } = created[0]!;
    await expect(store.importVideo(id, join(await tempDir(), 'missing.mp4'))).rejects.toThrow();
    expect(await readdir(join(dir, 'media'))).toEqual([]);
  });
});

describe('ProjectStore: list', () => {
  it('summarises every readable project, newest first', async () => {
    const root = await tempDir();
    const store = new ProjectStore(root);
    await store.init();
    const a = await store.create('Alpha');
    const b = await store.create('Beta');
    const stamp = (c: typeof a, updatedAt: string) =>
      writeFile(join(c.dir, 'project.json'), JSON.stringify({ ...JSON.parse(serializeProject(c.project)), updatedAt }));
    await stamp(a, '2026-01-01T00:00:00.000Z');
    await stamp(b, '2026-02-01T00:00:00.000Z');
    await mkdir(join(a.dir, 'media', 'rec', 'deep'), { recursive: true });
    await writeFile(join(a.dir, 'media', 'rec', 'a.bin'), new Uint8Array(100));
    await writeFile(join(a.dir, 'media', 'rec', 'deep', 'b.bin'), new Uint8Array(23));
    await store.setThumbnail(b.id, new Uint8Array([1, 2, 3]));
    await mkdir(join(root, 'not a project'));
    await mkdir(join(root, 'broken'));
    await writeFile(join(root, 'broken', 'project.json'), '{"id":"prj_broken"}');
    await writeFile(join(root, 'loose.txt'), 'x');

    const list = await store.list();
    expect(list.map((p) => p.id)).toEqual([b.id, a.id]);
    expect(list[0]).toEqual({
      id: b.id, name: 'Beta', createdAt: b.project.createdAt, updatedAt: '2026-02-01T00:00:00.000Z',
      durationTicks: 0, recordings: 0, thumbnail: `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}`, sizeBytes: 0,
    });
    expect(list[1]).toMatchObject({ id: a.id, name: 'Alpha', thumbnail: null, sizeBytes: 123 });
    expect(store.dirOf('prj_broken')).toBe(join(root, 'broken'));
    expect(JSON.parse(await readFile(join(a.dir, 'project.json'), 'utf8')).id).toBe(a.id);
  });
});

describe('ProjectStore: edits made outside the app', () => {
  const settled = () => new Promise((r) => setTimeout(r, 400));

  async function watched() {
    const { store, created } = await storeWith(1);
    const { id, dir } = created[0]!;
    const opened = await store.read(id);
    const seen: string[] = [];
    await store.watchExternalEdits(id, (p) => seen.push(p.name));
    return { store, id, dir, opened, seen };
  }
  const writeOutside = (dir: string, text: string) => writeFile(join(dir, 'project.json'), text);

  it('delivers a project.json another program rewrote', async () => {
    const { store, dir, opened, seen } = await watched();
    await writeOutside(dir, serializeProject({ ...opened, name: 'Edited outside' }));
    await vi.waitFor(() => expect(seen).toEqual(['Edited outside']));
    store.stopWatching();
  });

  it('stays quiet for the saves the app makes itself, even back to back', async () => {
    const { store, id, opened, seen } = await watched();
    await Promise.all([1, 2, 3, 4].map((n) => store.save(id, serializeProject({ ...opened, name: `Save ${n}` }))));
    await store.rename(id, 'Renamed in the app');
    await settled();
    expect(seen).toEqual([]);
    store.stopWatching();
  });

  it('refuses a save over an outside edit the editor has not received, and hands that edit over', async () => {
    const { store, id, dir, opened, seen } = await watched();
    await writeOutside(dir, serializeProject({ ...opened, name: 'From the CLI' }));
    await expect(store.save(id, serializeProject({ ...opened, name: 'Stale editor state' }))).rejects.toThrow();
    expect(seen).toEqual(['From the CLI']);
    expect((await store.read(id)).name).toBe('From the CLI');
    await settled();
    expect(seen).toEqual(['From the CLI']);
    store.stopWatching();
  });

  it('hands an outside edit to the editor before a rename builds on it', async () => {
    const { store, id, dir, opened, seen } = await watched();
    await writeOutside(dir, serializeProject({ ...opened, zooms: [], name: 'From the CLI' }));
    await store.rename(id, 'Renamed in the app');
    expect(seen).toEqual(['From the CLI']);
    store.stopWatching();
  });

  it('delivers a project.json replaced by a renamed temporary file, as the CLI writes it', async () => {
    const { store, dir, opened, seen } = await watched();
    const tmp = join(dir, 'project.json.cli.tmp');
    await writeFile(tmp, serializeProject({ ...opened, name: 'Renamed into place' }));
    await rename(tmp, join(dir, 'project.json'));
    await vi.waitFor(() => expect(seen).toEqual(['Renamed into place']));
    store.stopWatching();
  });

  it('delivers an edit that lands while the watch is starting', async () => {
    const { store, created } = await storeWith(1);
    const { id, dir } = created[0]!;
    const opened = await store.read(id);
    const seen: string[] = [];
    afterNextRead.run = () => writeOutside(dir, serializeProject({ ...opened, name: 'Edited while starting' }));
    await store.watchExternalEdits(id, (p) => seen.push(p.name));
    await vi.waitFor(() => expect(seen).toEqual(['Edited while starting']));
    store.stopWatching();
  });

  it('keeps only the latest of two overlapping watches', async () => {
    const { store, created } = await storeWith(2);
    const [a, b] = created;
    const openedA = await store.read(a!.id);
    const openedB = await store.read(b!.id);
    const seenA: string[] = [];
    const seenB: string[] = [];
    await Promise.all([store.watchExternalEdits(a!.id, (p) => seenA.push(p.name)), store.watchExternalEdits(b!.id, (p) => seenB.push(p.name))]);
    await writeOutside(a!.dir, serializeProject({ ...openedA, name: 'A edited' }));
    await writeOutside(b!.dir, serializeProject({ ...openedB, name: 'B edited' }));
    await vi.waitFor(() => expect(seenB).toEqual(['B edited']));
    await settled();
    expect(seenA).toEqual([]);
    store.stopWatching();
  });

  it('does not start a watch that was stopped while it was starting', async () => {
    const { store, created } = await storeWith(1);
    const { id, dir } = created[0]!;
    const opened = await store.read(id);
    const seen: string[] = [];
    afterNextRead.run = async () => store.stopWatching();
    await store.watchExternalEdits(id, (p) => seen.push(p.name));
    await writeOutside(dir, serializeProject({ ...opened, name: 'After close' }));
    await settled();
    expect(seen).toEqual([]);
  });

  it('ignores a file that is not a valid project and delivers the next valid one', async () => {
    const { store, dir, opened, seen } = await watched();
    await writeOutside(dir, '{ "schema": 1, "id":');
    await settled();
    expect(seen).toEqual([]);
    await writeOutside(dir, serializeProject({ ...opened, name: 'Repaired' }));
    await vi.waitFor(() => expect(seen).toEqual(['Repaired']));
    store.stopWatching();
  });

  it('stops delivering once the watch is closed or the project is forgotten', async () => {
    const { store, id, dir, opened, seen } = await watched();
    store.stopWatching();
    await writeOutside(dir, serializeProject({ ...opened, name: 'After close' }));
    await store.watchExternalEdits(id, (p) => seen.push(p.name));
    store.forget(id);
    await writeOutside(dir, serializeProject({ ...opened, name: 'After forget' }));
    await settled();
    expect(seen).toEqual([]);
  });

  it('survives the project folder being deleted while watched', async () => {
    const { store, dir, seen } = await watched();
    await rm(dir, { recursive: true, force: true });
    await settled();
    expect(seen).toEqual([]);
    store.stopWatching();
  });
});

describe('ProjectStore: waveform peaks cache', () => {
  async function withMedia() {
    const { store, created } = await storeWith(1);
    const { id, dir } = created[0]!;
    await mkdir(join(dir, 'media', 'r1'), { recursive: true });
    await writeFile(join(dir, 'media', 'r1', 'mic.m4a'), 'first take');
    return { store, id, dir, file: 'media/r1/mic.m4a' };
  }

  it('returns no peaks until written, then the written peaks, stored under cache/', async () => {
    const { store, id, dir, file } = await withMedia();
    const first = await store.readPeaks(id, file);
    expect(first.data).toBeNull();
    expect(await store.writePeaks(id, file, first.stamp, new Uint8Array([1, 2, 3]))).toBe(true);
    expect([...(await store.readPeaks(id, file)).data!]).toEqual([1, 2, 3]);
    expect((await readdir(join(dir, 'cache'))).some((f) => f.startsWith('peaks-'))).toBe(true);
    expect(await readdir(join(dir, 'media', 'r1'))).toEqual(['mic.m4a']);
  });

  it('forgets the peaks once the source file changes size or modification time', async () => {
    const { store, id, dir, file } = await withMedia();
    await store.writePeaks(id, file, (await store.readPeaks(id, file)).stamp, new Uint8Array([9]));
    await writeFile(join(dir, file), 'a longer second take');
    expect((await store.readPeaks(id, file)).data).toBeNull();

    await store.writePeaks(id, file, (await store.readPeaks(id, file)).stamp, new Uint8Array([7]));
    const later = new Date(Date.now() + 60_000);
    await utimes(join(dir, file), later, later);
    expect((await store.readPeaks(id, file)).data).toBeNull();
  });

  it('refuses peaks computed from an older version of the file', async () => {
    const { store, id, dir, file } = await withMedia();
    const stale = (await store.readPeaks(id, file)).stamp;
    await writeFile(join(dir, file), 'replaced while decoding');
    expect(await store.writePeaks(id, file, stale, new Uint8Array([5]))).toBe(false);
    expect((await store.readPeaks(id, file)).data).toBeNull();
  });

  it('only reads peaks for files under media/', async () => {
    const { store, id } = await withMedia();
    await expect(store.readPeaks(id, 'project.json')).rejects.toThrow();
    await expect(store.writePeaks(id, 'cache/x.bin', { size: 0, mtimeMs: 0 }, new Uint8Array(1))).rejects.toThrow();
  });
});

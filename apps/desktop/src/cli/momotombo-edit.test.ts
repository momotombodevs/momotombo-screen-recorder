import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRecording, createProject, serializeProject, type Project, type Recording } from '@momotombo/project-model';
import { secondsToTicks } from '@momotombo/timing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, launch, run } from './momotombo-edit';

const recording: Recording = {
  id: 'r1',
  createdAt: '2026-11-17T00:00:00Z',
  duration: secondsToTicks(60),
  sources: { screen: { kind: 'screen', file: 'media/r1/screen.mp4', mime: 'video/mp4', width: 1920, height: 1080, fps: 30, startOffset: 0, duration: secondsToTicks(60) } },
  capture: {
    backend: 'web', platform: 'test',
    target: { kind: 'display', label: 'Display', bounds: { x: 0, y: 0, w: 1920, h: 1080 }, scaleFactor: 1 },
    cursorInFrames: true, hasClicks: false,
  },
  syncOffsets: {},
  markers: [],
};

let root: string;

async function saveProject(folder: string, name: string, updatedAt: string): Promise<{ project: Project; dir: string }> {
  const project = { ...addRecording(createProject(name), recording), updatedAt };
  const dir = join(root, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'project.json'), serializeProject(project, new Date(updatedAt)));
  return { project, dir };
}

async function cli(args: string[], stdin = async () => '') {
  let out = '';
  let err = '';
  const code = await run([...args, '--root', root], { out: (t) => { out += t; }, err: (t) => { err += t; }, stdin, env: {} });
  return { code, out, err, json: () => JSON.parse(out) };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'momotombo-cli-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('picking a project', () => {
  it('lists projects newest first', async () => {
    await saveProject('a', 'Older', '2026-11-01T00:00:00.000Z');
    await saveProject('b', 'Newer', '2026-11-02T00:00:00.000Z');
    const { code, json } = await cli(['list']);
    expect(code).toBe(EXIT.ok);
    expect(json().projects.map((p: { name: string }) => p.name)).toEqual(['Newer', 'Older']);
    expect(json().skipped).toEqual([]);
  });

  it('describes the latest project, or one by id or name', async () => {
    const older = await saveProject('a', 'Older', '2026-11-01T00:00:00.000Z');
    await saveProject('b', 'Newer', '2026-11-02T00:00:00.000Z');
    expect((await cli(['describe', 'latest'])).json().name).toBe('Newer');
    expect((await cli(['describe', older.project.id])).json().name).toBe('Older');
    expect((await cli(['describe', 'older'])).json()).toMatchObject({ name: 'Older', dir: older.dir });
  });

  it('refuses a name two projects share', async () => {
    await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    await saveProject('b', 'Demo', '2026-11-02T00:00:00.000Z');
    const { code, err } = await cli(['describe', 'Demo']);
    expect(code).toBe(EXIT.usage);
    expect(err).toMatch(/2 projects are named "Demo"; use the id/);
  });

  it('reports unreadable projects instead of hiding them', async () => {
    await saveProject('a', 'Fine', '2026-11-01T00:00:00.000Z');
    await mkdir(join(root, 'broken'));
    await writeFile(join(root, 'broken', 'project.json'), '{"schema": 1');
    await utimes(join(root, 'a', 'project.json'), new Date('2026-11-01'), new Date('2026-11-01'));
    const { code, json, err } = await cli(['list']);
    expect(code).toBe(EXIT.ok);
    expect(json().projects).toHaveLength(1);
    expect(json().skipped).toEqual([{ dir: join(root, 'broken'), error: expect.any(String) }]);
    expect(err).toMatch(/warning: skipped .*broken/);
  });

  it('fails loudly when the newest project is the unreadable one', async () => {
    await saveProject('a', 'Fine', '2026-11-01T00:00:00.000Z');
    await utimes(join(root, 'a', 'project.json'), new Date('2026-11-01'), new Date('2026-11-01'));
    await mkdir(join(root, 'broken'));
    await writeFile(join(root, 'broken', 'project.json'), '{"schema": 99}');
    const { code, err } = await cli(['describe', 'latest']);
    expect(code).toBe(EXIT.usage);
    expect(err).toMatch(/most recently changed project, .*broken, cannot be read/);
  });

  it('reads the folder given with --root and nothing else', async () => {
    const { code, err } = await cli(['describe', 'latest']);
    expect(code).toBe(EXIT.usage);
    expect(err).toContain(`No projects in ${root}`);
  });
});

describe('apply', () => {
  const ops = (value: unknown) => async () => JSON.stringify(value);

  it('applies ops from stdin, writes them and reports each op', async () => {
    const { dir } = await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    const { code, json } = await cli(['apply', 'latest', '-'], ops([{ op: 'cut', start: 0, end: 10 }, { op: 'addZoom', start: 1, end: 3 }]));
    expect(code).toBe(EXIT.ok);
    expect(json()).toMatchObject({ applied: 2, written: true, durationSeconds: { before: 60, after: 50 }, ops: [{ op: 'cut' }, { op: 'addZoom', placed: { start: 1, end: 3 } }], warnings: [] });
    expect(JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')).zooms).toHaveLength(1);
    expect(await readFile(join(dir, 'project.json.bak'), 'utf8')).toContain('"zooms": []');
  });

  it('reads ops from a file', async () => {
    await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    const file = join(root, 'ops.json');
    await writeFile(file, JSON.stringify([{ op: 'rename', name: 'Renamed' }]));
    expect((await cli(['apply', 'latest', file])).code).toBe(EXIT.ok);
    expect((await cli(['describe', 'latest'])).json().name).toBe('Renamed');
  });

  it('writes nothing on a dry run', async () => {
    const { dir } = await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    const before = await readFile(join(dir, 'project.json'), 'utf8');
    const { code, json } = await cli(['apply', 'latest', '-', '--dry-run'], ops([{ op: 'cut', start: 0, end: 10 }]));
    expect(code).toBe(EXIT.ok);
    expect(json()).toMatchObject({ written: false, durationSeconds: { after: 50 } });
    expect(await readFile(join(dir, 'project.json'), 'utf8')).toBe(before);
  });

  it('writes nothing when the editor saved the project meanwhile', async () => {
    const { dir } = await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    const file = join(dir, 'project.json');
    const editorSave = async () => {
      await writeFile(file, (await readFile(file, 'utf8')).replace('"Demo"', '"Saved by the editor"'));
      return JSON.stringify([{ op: 'rename', name: 'From the CLI' }]);
    };
    const { code, err } = await cli(['apply', 'latest', '-'], editorSave);
    expect(code).toBe(EXIT.conflict);
    expect(err).toMatch(/changed while the ops were applied/);
    expect(await readFile(file, 'utf8')).toContain('Saved by the editor');
  });

  it('names the op and field of each invalid op, one per line', async () => {
    await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    const { code, err } = await cli(['apply', 'latest', '-'], ops([{ op: 'addZoom', start: 1, end: 2, zoom: 3 }, { op: 'cut', start: -1, end: 2 }]));
    expect(code).toBe(EXIT.invalid);
    expect(err.trim().split('\n')).toEqual([
      expect.stringMatching(/^momotombo-edit: op 0 \(addZoom\): .*zoom/),
      expect.stringMatching(/^momotombo-edit: op 1 \(cut\) start: /),
    ]);
  });

  it('refuses a misspelled style field', async () => {
    await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    const { code, err } = await cli(['apply', 'latest', '-'], ops([{ op: 'setStyle', patch: { camera: { positon: { x: 0.1, y: 0.1 } } } }]));
    expect(code).toBe(EXIT.invalid);
    expect(err).toBe('momotombo-edit: op 0 (setStyle): unknown field style.camera.positon\n');
  });

  it('says where ops that are not JSON came from', async () => {
    await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    const { code, err } = await cli(['apply', 'latest', '-'], async () => '[{"op": "cut",]');
    expect(code).toBe(EXIT.invalid);
    expect(err).toMatch(/^momotombo-edit: The ops in stdin are not valid JSON: /);
  });

  it('refuses ops that leave a project the editor cannot open', async () => {
    await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    const { code, err } = await cli(['apply', 'latest', '-'], ops([{ op: 'setStyle', patch: { frame: { padding: 'wide' } } }]));
    expect(code).toBe(EXIT.invalid);
    expect(err).toMatch(/style\.frame\.padding/);
  });

  it('treats an unknown command as a usage error', async () => {
    const { code, err } = await cli(['zoom']);
    expect(code).toBe(EXIT.usage);
    expect(err).toMatch(/Unknown command "zoom"/);
  });
});

describe('open', () => {
  it('refuses --root, since the app only reads its own folder', async () => {
    expect((await cli(['open', 'latest'])).code).toBe(EXIT.usage);
  });

  it('reports a launcher that could not start or failed', async () => {
    await expect(launch('/nonexistent/momotombo', [], false)).rejects.toThrow(/Could not start/);
    await expect(launch('false', [], true)).rejects.toThrow(/failed \(exit 1\)/);
    await expect(launch('true', [], true)).resolves.toBeUndefined();
  });
});

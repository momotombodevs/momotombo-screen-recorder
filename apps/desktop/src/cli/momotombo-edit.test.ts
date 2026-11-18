import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { addRecording, createProject, serializeProject, type Project, type Recording } from '@momotombo/project-model';
import { secondsToTicks } from '@momotombo/timing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, launch, mediaSummary, openArgs, run, type Io } from './momotombo-edit';

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

describe('export', () => {
  const ffprobe = JSON.stringify({
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '60/1' },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
    ],
    format: { duration: '60.016' },
  });
  type Step = (request: { requestId: string; out?: string }, statusFile: string) => Promise<void>;

  async function exportCli(args: string[], app: Step | null, extra: Partial<Io> = {}) {
    let out = '';
    let err = '';
    const launched: string[] = [];
    const io: Io = {
      out: (t) => { out += t; }, err: (t) => { err += t; }, stdin: async () => '', env: { MOMOTOMBO_TEST_HOME: dirname(root) }, pollMs: 10,
      run: async () => ffprobe,
      launchApp: async (flag) => {
        launched.push(flag);
        const file = flag.slice('--export-request='.length);
        const request = JSON.parse(await readFile(file, 'utf8'));
        if (app) void app(request, join(dirname(file), `export-status-${request.requestId}.json`));
        return 'Fake.app';
      },
      ...extra,
    };
    const code = await run(['export', ...args], io);
    return { code, out, err, launched, json: () => JSON.parse(out) };
  }

  const status = (requestId: string, fields: Record<string, unknown>) => JSON.stringify({
    requestId, state: 'running', progress: 0, phase: null, outFile: null, bytes: null, error: null, reason: null, startedAt: '2026-11-17T00:00:00Z', finishedAt: null, ...fields,
  });

  beforeEach(async () => {
    root = join(root, 'projects');
    await mkdir(root);
  });

  it('asks the app to export, waits for the file and reports it', async () => {
    const { dir } = await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    const out = join(dirname(root), 'final.mp4');
    const { code, json, launched } = await exportCli(['latest', '--out', out, '--fps', '30'], async (request, file) => {
      await writeFile(file, status(request.requestId, { progress: 0.5 }));
      await writeFile(out, 'video-bytes');
      await writeFile(file, status(request.requestId, { state: 'done', progress: 1, outFile: out, bytes: 11, finishedAt: '2026-11-17T00:01:00Z' }));
    });
    expect(code).toBe(EXIT.ok);
    expect(launched[0]).toMatch(/^--export-request=.*cache\/export-request-xr_[0-9a-f]{16}\.json$/);
    expect(json()).toMatchObject({
      outFile: out, bytes: 11, format: 'mp4', timelineSeconds: 60, privacyAreas: 0,
      media: { durationSeconds: 60.016, video: { codec: 'h264', width: 1920, height: 1080, fps: 60 }, audio: { codec: 'aac', sampleRate: 48000, channels: 2 } },
    });
    expect((await readdir(join(dir, 'cache'))).filter((f) => f.startsWith('export-'))).toEqual([]);
  });

  it('exits 6 when the app refuses and 7 when the export fails', async () => {
    await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    const refused = await exportCli(['latest'], async (r, file) => writeFile(file, status(r.requestId, { state: 'refused', reason: 'recording', error: 'Momotombo is recording.' })));
    expect(refused.code).toBe(EXIT.refused);
    expect(refused.err).toMatch(/refused the export \(recording\): Momotombo is recording/);
    const failed = await exportCli(['latest'], async (r, file) => writeFile(file, status(r.requestId, { state: 'failed', error: 'disk full' })));
    expect(failed.code).toBe(EXIT.failed);
    expect(failed.err).toMatch(/disk full/);
  });

  it('never takes another request\'s status for this one, and fails fast when the app never answers', async () => {
    await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    const { code, err } = await exportCli(['latest'], async (_r, file) =>
      writeFile(file, status('xr_ffffffffffffffff', { state: 'done', outFile: '/old.mp4', bytes: 1 })), { takeDeadlineMs: 150 });
    expect(code).toBe(EXIT.usage);
    expect(err).toMatch(/did not acknowledge the export request within 0 s/);
  });

  it('cancels the export at --timeout and says how far it got', async () => {
    await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    const { code, err } = await exportCli(['latest', '--timeout', '0.2'], async (r, file) => {
      await writeFile(file, status(r.requestId, { progress: 0.4 }));
      const cancel = join(dirname(file), `export-cancel-${r.requestId}`);
      while (!(await readFile(cancel).then(() => true, () => false))) await new Promise((x) => setTimeout(x, 10));
      await writeFile(file, status(r.requestId, { state: 'failed', progress: 0.4, error: 'Cancelled by momotombo-edit' }));
    });
    expect(code).toBe(EXIT.timeout);
    expect(err).toMatch(/No result after 0.2 s \(it was running at 40%\); the app cancelled it and removed the partial file/);
  });

  it('says when the app does not confirm a cancellation', async () => {
    await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    const { code, err } = await exportCli(['latest', '--timeout', '0.2'], async (r, file) => writeFile(file, status(r.requestId, { progress: 0.4 })), { cancelWaitMs: 50 });
    expect(code).toBe(EXIT.timeout);
    expect(err).toMatch(/did not confirm the cancellation \(.*export-status-xr_[0-9a-f]{16}\.json\)/);
  });

  it('cancels the export when interrupted', async () => {
    await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    const interrupt = new AbortController();
    const { code, err } = await exportCli(['latest'], async (r, file) => {
      await writeFile(file, status(r.requestId, { progress: 0.1 }));
      interrupt.abort();
    }, { interrupt: interrupt.signal, cancelWaitMs: 50 });
    expect(code).toBe(EXIT.interrupted);
    expect(err).toMatch(/Interrupted \(it was running at 10%\)/);
  });

  it('exits 3 when the app rejects the request as invalid', async () => {
    await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    const { code } = await exportCli(['latest'], async (r, file) =>
      writeFile(file, status(r.requestId, { state: 'refused', reason: 'invalid-request', error: 'bad --out' })));
    expect(code).toBe(EXIT.invalid);
  });

  it('fails when the app wrote a different file than --out', async () => {
    await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    const out = join(dirname(root), 'wanted.mp4');
    const other = join(dirname(root), 'wanted (2).mp4');
    const { code, err } = await exportCli(['latest', '--out', out], async (r, file) => {
      await writeFile(other, 'abc');
      await writeFile(file, status(r.requestId, { state: 'done', outFile: other, bytes: 3 }));
    });
    expect(code).toBe(EXIT.failed);
    expect(err).toMatch(/wrote .*wanted \(2\)\.mp4 instead of/);
  });

  it('does not report success for a file that is missing or incomplete', async () => {
    await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    const out = join(dirname(root), 'short.mp4');
    const { code } = await exportCli(['latest', '--out', out], async (r, file) => {
      await writeFile(out, 'abc');
      await writeFile(file, status(r.requestId, { state: 'done', outFile: out, bytes: 99 }));
    });
    expect(code).toBe(EXIT.failed);
  });

  it('checks the options before starting the app', async () => {
    const { dir } = await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    await mkdir(join(dir, 'media', 'r1'), { recursive: true });
    for (const args of [
      ['--out', join(dir, 'media', 'r1', 'screen.mp4')],
      ['--out', join(dirname(root), 'x.mov')],
      ['--fps', '24'],
      ['--variant', 'cinema'],
      ['--format', 'avi'],
    ]) {
      const r = await exportCli(['latest', ...args], null);
      expect(r.code, args.join(' ')).toBe(EXIT.invalid);
      expect(r.launched).toEqual([]);
    }
    expect((await exportCli(['latest', '--timeout', 'soon'], null)).code).toBe(EXIT.usage);
  });

  it('picks the format by name and the file type from --out', async () => {
    await saveProject('a', 'Demo', '2026-11-01T00:00:00.000Z');
    let seen: Record<string, unknown> = {};
    const out = join(dirname(root), 'vertical.webm');
    await exportCli(['latest', '--variant', '9:16', '--out', out, '--no-audio'], async (r, file) => {
      seen = r;
      await writeFile(file, status(r.requestId, { state: 'failed', error: 'stop here' }));
    });
    expect(seen).toMatchObject({ variantId: 'v_9x16', format: 'webm', includeAudio: false, out });
  });
});

describe('launching the app', () => {
  it('starts an export in the background and passes the test home along', () => {
    expect(openArgs('/A.app', '--export-request=/r.json', { MOMOTOMBO_TEST_HOME: '/tmp/h' }, true, '/dir')).toEqual(
      ['-n', '-g', '--env', 'MOMOTOMBO_TEST_HOME=/tmp/h', '/A.app', '--args', '/dir', '--export-request=/r.json'],
    );
    expect(openArgs('/A.app', '--open-project=prj_1', {}, false)).toEqual(['-n', '/A.app', '--args', '--open-project=prj_1']);
  });

  it('summarises what ffprobe says about a file', () => {
    expect(mediaSummary(JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'vp9', width: 1080, height: 1920, avg_frame_rate: '30000/1001' }] }))).toEqual({
      durationSeconds: null, video: { codec: 'vp9', width: 1080, height: 1920, fps: 29.97 }, audio: null,
    });
  });
});

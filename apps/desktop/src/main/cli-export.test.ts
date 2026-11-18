import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, type Project } from '@momotombo/project-model';
import type { CliExportReport } from '@momotombo/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startStatus } from '../shared/export-request';
import { CliExports, completeFileProblem, loadExportRequest, writeStatus, writeStatusNow, type CliExportHost } from './cli-export';

let base: string;
let root: string;
let projectDir: string;
const projectId = 'prj_12345678';
const requestId = 'xr_0123456789abcdef';

const projects = () => ({ root, dirOf: async (id: string) => (id === projectId ? projectDir : null) });

async function request(fields: Record<string, unknown>): Promise<string> {
  const file = join(base, 'request.json');
  await writeFile(file, JSON.stringify({ requestId, projectId, format: 'mp4', ...fields }));
  return file;
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'momotombo-cli-export-')));
  root = join(base, 'projects');
  projectDir = join(root, 'Demo 12345678');
  await mkdir(join(projectDir, 'media', 'rec_1'), { recursive: true });
  await mkdir(join(base, 'out'));
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe('loadExportRequest', () => {
  it('accepts a request for a known project and a new file', async () => {
    const out = join(base, 'out', 'a.mp4');
    const loaded = await loadExportRequest(await request({ out }), projects());
    expect(loaded).toMatchObject({ ok: true, dir: projectDir, out, request: { requestId, projectId } });
  });

  it('accepts a request without --out', async () => {
    expect(await loadExportRequest(await request({}), projects())).toMatchObject({ ok: true, out: null });
  });

  it('refuses a file inside a project media folder and says which project it was for', async () => {
    const loaded = await loadExportRequest(await request({ out: join(projectDir, 'media', 'rec_1', 'screen.mp4') }), projects());
    expect(loaded).toMatchObject({ ok: false, dir: projectDir, requestId, error: expect.stringMatching(/exports/) });
  });

  it('follows a symlinked folder before deciding', async () => {
    await symlink(join(projectDir, 'media'), join(base, 'out', 'link'));
    const loaded = await loadExportRequest(await request({ out: join(base, 'out', 'link', 'x.mp4') }), projects());
    expect(loaded).toMatchObject({ ok: false, error: expect.stringMatching(/exports/) });
  });

  it('refuses to replace an existing file', async () => {
    const out = join(base, 'out', 'a.mp4');
    await writeFile(out, 'old');
    expect(await loadExportRequest(await request({ out }), projects())).toMatchObject({ ok: false, error: expect.stringMatching(/already exists/) });
  });

  it('rejects an unknown project and a climbing id without naming a folder to write to', async () => {
    expect(await loadExportRequest(await request({ projectId: 'prj_87654321' }), projects())).toMatchObject({ ok: false, dir: null });
    expect(await loadExportRequest(await request({ projectId: '../../etc' }), projects())).toMatchObject({ ok: false, dir: null, requestId: null });
  });

  it('reads only a small regular file', async () => {
    expect(await loadExportRequest(base, projects())).toMatchObject({ ok: false, error: expect.stringMatching(/regular file/) });
    const big = join(base, 'big.json');
    await writeFile(big, ' '.repeat(20_000));
    expect(await loadExportRequest(big, projects())).toMatchObject({ ok: false, error: expect.stringMatching(/larger/) });
    const link = join(base, 'link.json');
    await symlink(await request({}), link);
    expect(await loadExportRequest(link, projects())).toMatchObject({ ok: false, error: expect.stringMatching(/Cannot read/) });
  });
});

describe('status file', () => {
  it('writes the status inside the project cache folder', async () => {
    const status = startStatus(requestId, new Date('2026-11-17T00:00:00Z'));
    await writeStatus(projectDir, status);
    expect(JSON.parse(await readFile(join(projectDir, 'cache', `export-status-${requestId}.json`), 'utf8'))).toEqual(status);
  });

  it('confirms a finished file only when its size matches what was written', async () => {
    const out = join(base, 'out', 'a.mp4');
    await writeFile(out, '12345');
    expect(await completeFileProblem(out, 5)).toBeNull();
    expect(await completeFileProblem(out, 6)).toMatch(/expected 6/);
    expect(await completeFileProblem(join(base, 'out', 'none.mp4'), 5)).toMatch(/missing/);
    expect(await completeFileProblem(null, null)).toMatch(/without a file/);
  });
});

describe('writeStatusNow', () => {
  it('writes through a fresh temporary file, never a planted one', async () => {
    const status = startStatus(requestId, new Date('2026-11-17T00:00:00Z'));
    await mkdir(join(projectDir, 'cache'));
    const victim = join(base, 'victim.txt');
    await writeFile(victim, 'keep');
    await symlink(victim, join(projectDir, 'cache', `export-status-${requestId}.json.${process.pid}.tmp`));
    writeStatusNow(projectDir, status);
    expect(await readFile(victim, 'utf8')).toBe('keep');
    expect(JSON.parse(await readFile(join(projectDir, 'cache', `export-status-${requestId}.json`), 'utf8'))).toEqual(status);
    expect((await readdir(join(projectDir, 'cache'))).filter((f) => f.endsWith('.tmp') && !f.includes(String(process.pid)))).toEqual([]);
  });
});

describe('CliExports', () => {
  const project: Project = { ...createProject('Demo'), id: projectId };
  const otherId = 'xr_fedcba9876543210';
  let host: CliExportHost & { calls: string[]; release: () => void };
  let cli: CliExports;

  function fakeHost(slowRead = false): typeof host {
    const calls: string[] = [];
    let release = () => {};
    const gate = slowRead ? new Promise<void>((r) => { release = r; }) : Promise.resolve();
    let n = 0;
    return {
      calls,
      get release() { return release; },
      root,
      projectDirs: async () => [{ id: projectId, dir: projectDir }],
      readProject: async () => { await gate; return project; },
      busy: () => ({ capturePhase: 'idle', exportsRunning: 0 }),
      issueTarget: (path) => { calls.push(`issue ${path}`); return { token: `exp_${++n}`, name: 'a.mp4', folder: '~', chosen: true }; },
      defaultTarget: async (_id, baseName, ext) => { calls.push(`default ${baseName}.${ext}`); return { token: `exp_${++n}`, name: `${baseName}.${ext}`, folder: '~', chosen: false }; },
      mediaBase: (id) => `momotombo-media://${id}/`,
      showJob: () => calls.push('show'),
      restoreThrottling: () => calls.push('restore'),
      cancelExport: async (id) => { calls.push(`cancel ${id}`); },
      abortInRenderer: (id) => calls.push(`abort ${id}`),
      log: () => {},
      settled: () => calls.push('settled'),
    };
  }

  const statusOf = async (id = requestId) => JSON.parse(await readFile(join(projectDir, 'cache', `export-status-${id}.json`), 'utf8'));
  const report = (fields: Partial<CliExportReport>): CliExportReport => ({
    requestId, state: 'running', progress: 0.5, phase: 'video', outFile: null, bytes: null, error: null, reason: null, ...fields,
  });
  async function requestFile(fields: Record<string, unknown> = {}, name = 'r.json'): Promise<string> {
    const file = join(base, name);
    await writeFile(file, JSON.stringify({ requestId, projectId, format: 'mp4', ...fields }));
    return file;
  }

  beforeEach(() => {
    host = fakeHost();
    cli = new CliExports(host, 60_000);
  });

  it('queues a job with a target from main and hands it to the main window once', async () => {
    await cli.accept(await requestFile());
    expect(await statusOf()).toMatchObject({ state: 'queued' });
    expect(host.calls).toEqual(['default Demo 16:9.mp4'.replace(':', 'x'), 'show']);
    expect(host.calls).not.toContain('settled');
    expect(cli.take(false)).toBeNull();
    const job = cli.take(true);
    expect(job).toMatchObject({ requestId, target: { token: 'exp_1' }, choices: { format: 'mp4' }, opened: { id: projectId, dir: projectDir } });
    expect(cli.take(true)).toBeNull();
    cli.failNow('stop');
  });

  it('refuses the second of two requests that arrive together', async () => {
    host = fakeHost(true);
    cli = new CliExports(host, 60_000);
    const first = cli.accept(await requestFile({}, 'a.json'));
    const second = cli.accept(await requestFile({ requestId: otherId }, 'b.json'));
    await second;
    expect(await statusOf(otherId)).toMatchObject({ state: 'refused', reason: 'exporting' });
    expect(host.calls).not.toContain('settled');
    host.release();
    await first;
    expect(await statusOf()).toMatchObject({ state: 'queued' });
    expect(host.calls.filter((c) => c.startsWith('default'))).toHaveLength(1);
    cli.failNow('stop');
  });

  it('refuses while recording, and refuses a bad --out with invalid-request in the project', async () => {
    host.busy = () => ({ capturePhase: 'recording', exportsRunning: 0 });
    await cli.accept(await requestFile());
    expect(await statusOf()).toMatchObject({ state: 'refused', reason: 'recording' });
    host.busy = () => ({ capturePhase: 'idle', exportsRunning: 0 });
    await cli.accept(await requestFile({ requestId: otherId, out: join(projectDir, 'media', 'x.mp4') }));
    expect(await statusOf(otherId)).toMatchObject({ state: 'refused', reason: 'invalid-request', error: expect.stringMatching(/exports/) });
    expect(cli.busy).toBe(false);
    expect(host.calls.filter((c) => c === 'settled')).toHaveLength(2);
  });

  it('refuses an unreadable request file found in a project cache folder', async () => {
    await mkdir(join(projectDir, 'cache'), { recursive: true });
    const file = join(projectDir, 'cache', `export-request-${requestId}.json`);
    await writeFile(file, '{"requestId": ');
    await cli.accept(file);
    expect(await statusOf()).toMatchObject({ state: 'refused', reason: 'invalid-request', error: expect.stringMatching(/not valid JSON/) });
  });

  it('refuses a format the project does not have', async () => {
    await cli.accept(await requestFile({ variantId: 'v_nope' }));
    expect(await statusOf()).toMatchObject({ state: 'refused', reason: 'invalid-request', error: expect.stringMatching(/no format v_nope/) });
    expect(cli.busy).toBe(false);
  });

  it('reports the file main wrote, not the one the renderer names', async () => {
    const out = join(base, 'out', 'a.mp4');
    await cli.accept(await requestFile({ out }));
    cli.take(true);
    cli.noteBegin('exp_1', 'e1');
    await writeFile(out, '12345');
    cli.noteEnd('e1', { path: out, bytes: 5 });
    await cli.report(report({}), true);
    expect(await statusOf()).toMatchObject({ state: 'running', progress: 0.5 });
    await cli.report(report({ state: 'done', outFile: '/etc/passwd', bytes: 5 }), true);
    expect(await statusOf()).toMatchObject({ state: 'done', outFile: out, bytes: 5, progress: 1 });
    expect(host.calls.slice(-2)).toEqual(['restore', 'settled']);
  });

  it('fails a done report when main recorded no finished file', async () => {
    await cli.accept(await requestFile());
    cli.take(true);
    await cli.report(report({ state: 'done', outFile: '/x.mp4', bytes: 1 }), true);
    expect(await statusOf()).toMatchObject({ state: 'failed', error: expect.stringMatching(/without a file/) });
  });

  it('ignores reports from other windows, other requests or before the job was taken', async () => {
    await cli.accept(await requestFile());
    await cli.report(report({ state: 'failed', error: 'x' }), true);
    cli.take(true);
    await cli.report(report({ state: 'failed', error: 'x' }), false);
    await cli.report(report({ state: 'failed', error: 'x', requestId: otherId }), true);
    expect(await statusOf()).toMatchObject({ state: 'queued' });
    expect(cli.busy).toBe(true);
    cli.failNow('stop');
  });

  it('restores throttling on every way a job ends', async () => {
    const ends: Array<(c: CliExports, id: string) => Promise<void>> = [
      (c, id) => c.report(report({ requestId: id, state: 'refused', reason: 'editing-other-project', error: 'busy' }), true),
      (c, id) => c.report(report({ requestId: id, state: 'failed', error: 'disk full' }), true),
      (c) => c.windowLost(),
    ];
    for (const [i, end] of ends.entries()) {
      host = fakeHost();
      cli = new CliExports(host, 60_000);
      const id = `xr_${String(i).repeat(16)}`;
      await cli.accept(await requestFile({ requestId: id }));
      cli.take(true);
      await end(cli, id);
      expect(host.calls.slice(-2), String(i)).toEqual(['restore', 'settled']);
      expect(cli.busy).toBe(false);
    }
    expect(await statusOf('xr_0000000000000000')).toMatchObject({ state: 'refused', reason: 'editing-other-project' });
  });

  it('cancels on request: aborts the renderer, deletes the partial file and says so', async () => {
    await cli.accept(await requestFile());
    cli.take(true);
    cli.noteBegin('exp_1', 'e1');
    await cli.checkCancel();
    expect(cli.busy).toBe(true);
    await writeFile(join(projectDir, 'cache', `export-cancel-${requestId}`), '');
    await cli.checkCancel();
    expect(host.calls).toEqual(expect.arrayContaining(['cancel e1', `abort ${requestId}`, 'restore']));
    expect(await statusOf()).toMatchObject({ state: 'failed', error: expect.stringMatching(/Cancelled/) });
    expect(await readdir(join(projectDir, 'cache'))).not.toContain(`export-cancel-${requestId}`);
  });

  it('keeps only the latest few requests\' files in the cache', async () => {
    await mkdir(join(projectDir, 'cache'), { recursive: true });
    for (let i = 0; i < 8; i++) await writeFile(join(projectDir, 'cache', `export-status-xr_${String(i).repeat(16)}.json`), '{}');
    await cli.accept(await requestFile());
    const left = (await readdir(join(projectDir, 'cache'))).filter((f) => f.startsWith('export-status-'));
    expect(left).toHaveLength(6);
    expect(left).toContain(`export-status-${requestId}.json`);
    cli.failNow('stop');
  });
});

describe('CliExports with a request it cannot place', () => {
  it('still says it is idle, so an app started only for it can quit', async () => {
    const calls: string[] = [];
    const cli = new CliExports({
      root, projectDirs: async () => [], readProject: async () => { throw new Error('no'); }, busy: () => ({ capturePhase: 'idle', exportsRunning: 0 }),
      issueTarget: () => { throw new Error('no'); }, defaultTarget: async () => { throw new Error('no'); }, mediaBase: () => '',
      showJob: () => {}, restoreThrottling: () => {}, cancelExport: async () => {}, abortInRenderer: () => {}, log: () => {},
      settled: () => calls.push('settled'),
    });
    await cli.accept(join(base, 'missing.json'));
    expect(calls).toEqual(['settled']);
  });
});

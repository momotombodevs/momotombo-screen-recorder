import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startStatus } from '../shared/export-request';
import { completeFileProblem, loadExportRequest, writeStatus } from './cli-export';

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

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXPORT_REQUEST_FLAG, busyReason, exportRequestPathFromArgv, nextStatus, outPathProblem, parseExportRequest, parseExportStatus, requestFileLocation, staleExportFiles, startStatus, statusForRequest,
  type ExportStatus,
} from './export-request';

const valid = { requestId: 'xr_0123456789abcdef', projectId: 'prj_12345678', format: 'mp4' };
const root = '/Users/me/Movies/Momotombo';

describe('exportRequestPathFromArgv', () => {
  it('finds the request file wherever Chromium left the argument', () => {
    expect(exportRequestPathFromArgv(['Momotombo', '--allow-file-access', `${EXPORT_REQUEST_FLAG}/tmp/r.json`, '/app'])).toBe('/tmp/r.json');
  });

  it('is null in normal use and for an empty value', () => {
    expect(exportRequestPathFromArgv(['Momotombo', '/app'])).toBeNull();
    expect(exportRequestPathFromArgv(['Momotombo', EXPORT_REQUEST_FLAG])).toBeNull();
  });
});

describe('parseExportRequest', () => {
  it('accepts a minimal request and keeps the options it names', () => {
    expect(parseExportRequest(JSON.stringify(valid))).toEqual({ ok: true, request: valid });
    const full = { ...valid, variantId: 'v_9x16', resolution: '2160', fps: 60, quality: 'standard', includeAudio: false, out: '/tmp/a.mp4' };
    expect(parseExportRequest(JSON.stringify(full))).toEqual({ ok: true, request: full });
  });

  it.each([
    ['not JSON', '{'],
    ['a project id that climbs out', JSON.stringify({ ...valid, projectId: '../prj_12345678' })],
    ['a project id with a slash', JSON.stringify({ ...valid, projectId: 'prj_1234/5678' })],
    ['an unknown field', JSON.stringify({ ...valid, overwrite: true })],
    ['an odd frame rate', JSON.stringify({ ...valid, fps: 24 })],
    ['an unknown format', JSON.stringify({ ...valid, format: 'mov' })],
    ['a bad request id', JSON.stringify({ ...valid, requestId: 'xr_1' })],
    ['a variant id with path characters', JSON.stringify({ ...valid, variantId: '../v' })],
    ['an array', '[]'],
  ])('rejects %s', (_label, text) => {
    expect(parseExportRequest(text)).toMatchObject({ ok: false, error: expect.any(String) });
  });
});

describe('outPathProblem', () => {
  const facts = { realParent: '/Users/me/Desktop', projectsRoot: root, taken: false };

  it('accepts a new file with the right extension in an existing folder', () => {
    expect(outPathProblem('/Users/me/Desktop/out.mp4', 'mp4', facts)).toBeNull();
    expect(outPathProblem('/Users/me/Desktop/out.WEBM', 'webm', facts)).toBeNull();
  });

  it('accepts a project exports folder', () => {
    const exportsDir = join(root, 'Demo abc', 'exports');
    expect(outPathProblem(join(exportsDir, 'a.mp4'), 'mp4', { ...facts, realParent: exportsDir })).toBeNull();
  });

  it.each([
    ['a relative path', 'out.mp4', facts, /absolute/],
    ['the wrong extension', '/Users/me/Desktop/out.webm', facts, /\.mp4/],
    ['no extension', '/Users/me/Desktop/out', facts, /\.mp4/],
    ['a missing folder', '/Users/me/Nope/out.mp4', { ...facts, realParent: null }, /folder/],
    ['an existing file', '/Users/me/Desktop/out.mp4', { ...facts, taken: true }, /already exists/],
    ['a project media folder', join(root, 'Demo abc', 'media', 'rec_1', 'screen.mp4'), { ...facts, realParent: join(root, 'Demo abc', 'media', 'rec_1') }, /exports/],
    ['a project folder itself', join(root, 'Demo abc', 'x.mp4'), { ...facts, realParent: join(root, 'Demo abc') }, /exports/],
    ['the projects folder', join(root, 'x.mp4'), { ...facts, realParent: root }, /exports/],
    ['a symlinked folder that lands in media', '/Users/me/Desktop/link/x.mp4', { ...facts, realParent: join(root, 'Demo abc', 'media') }, /exports/],
  ])('rejects %s', (_label, out, f, message) => {
    expect(outPathProblem(out, 'mp4', f)).toMatch(message);
  });
});

describe('busyReason', () => {
  it('lets an idle app export', () => {
    expect(busyReason({ capturePhase: 'idle', exportsRunning: 0, jobActive: false })).toBeNull();
    expect(busyReason({ capturePhase: 'error', exportsRunning: 0, jobActive: false })).toBeNull();
  });

  it('refuses while recording, exporting or already serving a request', () => {
    expect(busyReason({ capturePhase: 'recording', exportsRunning: 0, jobActive: false })).toMatchObject({ reason: 'recording' });
    expect(busyReason({ capturePhase: 'countdown', exportsRunning: 0, jobActive: false })).toMatchObject({ reason: 'recording' });
    expect(busyReason({ capturePhase: 'idle', exportsRunning: 1, jobActive: false })).toMatchObject({ reason: 'exporting' });
    expect(busyReason({ capturePhase: 'idle', exportsRunning: 0, jobActive: true })).toMatchObject({ reason: 'exporting' });
  });
});

describe('statusForRequest', () => {
  const status: ExportStatus = {
    requestId: valid.requestId, state: 'running', progress: 0.5, phase: 'video', outFile: null, bytes: null, error: null, reason: null,
    startedAt: '2026-11-17T00:00:00.000Z', finishedAt: null,
  };

  it('returns the status written for this request', () => {
    expect(statusForRequest(JSON.stringify(status), valid.requestId)).toEqual(status);
  });

  it('ignores a file left by an earlier request, a half-written file or nothing', () => {
    expect(statusForRequest(JSON.stringify({ ...status, requestId: 'xr_ffffffffffffffff' }), valid.requestId)).toBeNull();
    expect(statusForRequest('{"requestId":', valid.requestId)).toBeNull();
    expect(statusForRequest(null, valid.requestId)).toBeNull();
  });

  it('round-trips through the schema', () => {
    expect(parseExportStatus(status)).toEqual(status);
    expect(() => parseExportStatus({ ...status, state: 'paused' })).toThrow();
  });
});

describe('status transitions', () => {
  const t0 = new Date('2026-11-17T10:00:00.000Z');
  const t1 = new Date('2026-11-17T10:01:00.000Z');
  const running = { state: 'running', progress: 0.25, phase: 'video', outFile: null, bytes: null, error: null, reason: null } as const;

  it('starts queued, runs, and stamps the end once done', () => {
    const queued = startStatus('xr_0123456789abcdef', t0);
    expect(queued).toMatchObject({ state: 'queued', progress: 0, startedAt: t0.toISOString(), finishedAt: null });
    const mid = nextStatus(queued, running, t1)!;
    expect(mid).toMatchObject({ state: 'running', progress: 0.25, finishedAt: null, startedAt: t0.toISOString() });
    const done = nextStatus(mid, { ...running, state: 'done', progress: 0.99, outFile: '/x.mp4', bytes: 10 }, t1)!;
    expect(done).toMatchObject({ state: 'done', progress: 1, outFile: '/x.mp4', bytes: 10, finishedAt: t1.toISOString() });
  });

  it('never changes a finished request', () => {
    const refused = startStatus('xr_0123456789abcdef', t0, { state: 'refused', reason: 'recording', error: 'busy' });
    expect(refused.finishedAt).toBe(t0.toISOString());
    expect(nextStatus(refused, running, t1)).toBeNull();
  });
});

describe('requestFileLocation', () => {
  it('names the project folder and request id of a CLI request file', () => {
    expect(requestFileLocation(join(root, 'Demo abc', 'cache', 'export-request-xr_0123456789abcdef.json'), root))
      .toEqual({ projectDir: join(root, 'Demo abc'), requestId: 'xr_0123456789abcdef' });
  });

  it.each([
    ['outside the projects folder', '/tmp/cache/export-request-xr_0123456789abcdef.json'],
    ['not in cache', join(root, 'Demo abc', 'export-request-xr_0123456789abcdef.json')],
    ['deeper than a project', join(root, 'Demo abc', 'media', 'cache', 'export-request-xr_0123456789abcdef.json')],
    ['another name', join(root, 'Demo abc', 'cache', 'export-request-xr_1.json')],
    ['climbing back in', join(root, 'Demo abc', '..', '..', 'x', 'cache', 'export-request-xr_0123456789abcdef.json')],
  ])('is null for a file %s', (_label, path) => {
    expect(requestFileLocation(path, root)).toBeNull();
  });
});

describe('staleExportFiles', () => {
  const file = (id: string, kind: string, mtimeMs: number) => ({ name: `export-${kind}-xr_${id}${kind === 'cancel' ? '' : '.json'}`, mtimeMs });

  it('keeps the newest requests and the current one, and names the rest', () => {
    const entries = [
      file('1'.repeat(16), 'status', 1), file('1'.repeat(16), 'request', 1),
      file('2'.repeat(16), 'status', 2), file('3'.repeat(16), 'status', 3), file('3'.repeat(16), 'cancel', 3),
      file('4'.repeat(16), 'status', 4), { name: 'thumbnail.jpg', mtimeMs: 0 },
    ];
    expect(staleExportFiles(entries, 2, `xr_${'1'.repeat(16)}`).sort()).toEqual([`export-status-xr_${'2'.repeat(16)}.json`]);
    expect(staleExportFiles(entries, 1, `xr_${'4'.repeat(16)}`).sort()).toEqual([
      `export-request-xr_${'1'.repeat(16)}.json`, `export-status-xr_${'1'.repeat(16)}.json`, `export-status-xr_${'2'.repeat(16)}.json`,
    ]);
  });
});

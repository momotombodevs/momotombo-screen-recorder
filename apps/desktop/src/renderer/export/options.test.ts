import { describe, expect, it } from 'vitest';
import { createProject } from '@momotombo/project-model';
import { cliExportChoices, cliReport, defaultExportChoices } from './options';

const project = createProject('Demo');
const progress = { frame: 30, total: 120, rate: 60, etaSeconds: 2 };

describe('cliExportChoices', () => {
  it('starts from the export window defaults and keeps what the request names', () => {
    expect(cliExportChoices(project, { format: 'mp4' })).toEqual({ ok: true, choices: { ...defaultExportChoices(project), format: 'mp4' } });
    const other = project.variants.find((v) => v.id !== project.activeVariantId)!;
    const r = cliExportChoices(project, { format: 'mp4', variantId: other.id, resolution: '2160', fps: 30, quality: 'standard', includeAudio: false });
    expect(r).toEqual({ ok: true, choices: { variantId: other.id, format: 'mp4', resolution: '2160', fps: 30, quality: 'standard', includeAudio: false } });
  });

  it('refuses a format the project does not have', () => {
    expect(cliExportChoices(project, { format: 'mp4', variantId: 'v_nope' })).toMatchObject({ ok: false, error: expect.stringMatching(/no format v_nope/) });
  });
});

describe('cliReport', () => {
  it('reports progress while the export runs', () => {
    expect(cliReport('xr_0123456789abcdef', { ...progress, phase: 'video' })).toMatchObject({ state: 'running', progress: 0.25, phase: 'video' });
  });

  it('reports the written file when done', () => {
    expect(cliReport('xr_0123456789abcdef', { ...progress, phase: 'done', path: '/x.mp4', bytes: 9 })).toMatchObject({ state: 'done', progress: 1, outFile: '/x.mp4', bytes: 9 });
  });

  it('reports errors and cancellation as failures', () => {
    expect(cliReport('xr_0123456789abcdef', { ...progress, phase: 'error', message: 'disk full' })).toMatchObject({ state: 'failed', error: 'disk full' });
    expect(cliReport('xr_0123456789abcdef', { ...progress, phase: 'cancelled' })).toMatchObject({ state: 'failed', error: expect.stringMatching(/cancelled/) });
  });
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const userData = await mkdtemp(join(tmpdir(), 'momotombo-settings-'));
vi.mock('electron', () => ({
  app: { getPath: () => userData, getPreferredSystemLanguages: () => ['es-NI'], getLocale: () => 'es' },
}));
const settings = await import('./settings');

afterAll(async () => { await rm(userData, { recursive: true, force: true }); });

describe('settings: last export folder', () => {
  it('remembers the folder across restarts, next to the language', async () => {
    await settings.loadSettings();
    expect(settings.getLastExportFolder()).toBeNull();
    await settings.updateSettings({ language: 'en' });
    await settings.setLastExportFolder('/Volumes/Video/Exports');
    const saved = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8'));
    expect(saved).toEqual({ language: 'en', lastExportFolder: '/Volumes/Video/Exports' });
    // Changing the language keeps the folder.
    await settings.updateSettings({ language: 'es' });
    expect(JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')).lastExportFolder).toBe('/Volumes/Video/Exports');
  });

  it('ignores a folder that is not an absolute path', async () => {
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ language: 'es', lastExportFolder: '../escape' }));
    vi.resetModules();
    const fresh = await import('./settings');
    await fresh.loadSettings();
    expect(fresh.getLastExportFolder()).toBeNull();
    await fresh.setLastExportFolder('relative/dir');
    expect(fresh.getLastExportFolder()).toBeNull();
  });

  it('test runs keep it in memory and never write the settings file', async () => {
    vi.resetModules();
    const fresh = await import('./settings');
    await writeFile(join(userData, 'settings.json'), '{"language":"es"}');
    await fresh.loadSettings({ ephemeral: true });
    await fresh.setLastExportFolder('/tmp/somewhere');
    expect(fresh.getLastExportFolder()).toBe('/tmp/somewhere');
    expect(await readFile(join(userData, 'settings.json'), 'utf8')).toBe('{"language":"es"}');
  });
});

describe('settings: language from an older version', () => {
  it('reads a stored Turkish setting as automatic', async () => {
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ language: 'tr' }));
    vi.resetModules();
    const fresh = await import('./settings');
    await fresh.loadSettings();
    expect(fresh.settingsInfo()).toMatchObject({ language: 'auto', resolved: 'es' });
  });
});

describe('settings: overlapping saves', () => {
  it('concurrent changes all reach the file and the latest snapshot wins', async () => {
    vi.resetModules();
    const fresh = await import('./settings');
    await rm(join(userData, 'settings.json'), { force: true });
    await fresh.loadSettings();
    await Promise.all([
      fresh.updateSettings({ language: 'en' }),
      fresh.setLastExportFolder('/Volumes/A'),
      fresh.updateSettings({ language: 'es' }),
      fresh.setLastExportFolder('/Volumes/B'),
    ]);
    expect(JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8'))).toEqual({ language: 'es', lastExportFolder: '/Volumes/B' });
  });
});

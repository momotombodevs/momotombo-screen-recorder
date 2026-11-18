import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RECORDER_PREFS } from '@momotombo/protocol';

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
    expect(saved).toEqual({ language: 'en', recorder: DEFAULT_RECORDER_PREFS, lastExportFolder: '/Volumes/Video/Exports' });
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
    expect(JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8'))).toEqual({ language: 'es', recorder: DEFAULT_RECORDER_PREFS, lastExportFolder: '/Volumes/B' });
  });
});

describe('settings: recorder preferences', () => {
  async function fresh() {
    vi.resetModules();
    return import('./settings');
  }

  beforeEach(async () => { await rm(join(userData, 'settings.json'), { force: true }); });

  it('start from the defaults', async () => {
    const s = await fresh();
    await s.loadSettings();
    expect(s.recorderPrefs()).toEqual(DEFAULT_RECORDER_PREFS);
  });

  it('survive a restart', async () => {
    const first = await fresh();
    await first.loadSettings();
    await first.updateRecorderPrefs({ micDeviceId: 'usb-mic', cameraOn: false, fps: 30, quality: 'max', countdown: 0 });
    const second = await fresh();
    await second.loadSettings();
    expect(second.recorderPrefs()).toEqual({ ...DEFAULT_RECORDER_PREFS, micDeviceId: 'usb-mic', cameraOn: false, fps: 30, quality: 'max', countdown: 0 });
  });

  it('keep the language and the export folder', async () => {
    const s = await fresh();
    await s.loadSettings();
    await s.updateSettings({ language: 'es' });
    await s.setLastExportFolder('/Volumes/C');
    await s.updateRecorderPrefs({ micOn: false });
    const saved = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8'));
    expect(saved).toMatchObject({ language: 'es', lastExportFolder: '/Volumes/C', recorder: { micOn: false } });
  });

  it('fall back field by field when the saved file holds bad values', async () => {
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ recorder: { fps: 24, micOn: false, quality: 'ultra' } }));
    const s = await fresh();
    await s.loadSettings();
    expect(s.recorderPrefs()).toEqual({ ...DEFAULT_RECORDER_PREFS, micOn: false });
  });

  it('stay in memory during test runs', async () => {
    const s = await fresh();
    await s.loadSettings({ ephemeral: true });
    await s.updateRecorderPrefs({ micOn: false });
    expect(s.recorderPrefs().micOn).toBe(false);
    await expect(readFile(join(userData, 'settings.json'))).rejects.toThrow();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, renameProject, serializeProject } from '@momotombo/project-model';
import { EditorStore } from './editor-store';

function openStore(saveProject: (json: string) => Promise<void>): EditorStore {
  vi.stubGlobal('window', {
    momotombo: {
      platform: 'test',
      on: () => () => undefined,
      invoke: async (channel: string, payload?: unknown) => {
        if (channel === 'projects:save') return saveProject((payload as { json: string }).json);
        return undefined;
      },
    },
  });
  const project = createProject('Demo');
  return new EditorStore({ id: project.id, json: JSON.parse(serializeProject(project)), mediaBase: 'app-media://p/', dir: '/tmp/p' });
}

describe('EditorStore.requestLeave', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('keeps the user in the editor when the latest edits could not be saved', async () => {
    const store = openStore(async () => { throw new Error('disk full'); });
    store.apply((p) => renameProject(p, 'Edited'));
    await expect(store.requestLeave()).resolves.toBe(false);
    expect(store.getState().save).toBe('error');
    expect(store.getState().saveError).toBe('disk full');
    expect(store.getState().leaveBlocked).toBe(true);
  });

  it('lets the user leave once a retry saves the edits', async () => {
    let fail = true;
    const saved: string[] = [];
    const store = openStore(async (json) => { if (fail) throw new Error('disk full'); saved.push(json); });
    store.apply((p) => renameProject(p, 'Edited'));
    await expect(store.requestLeave()).resolves.toBe(false);
    fail = false;
    await expect(store.requestLeave()).resolves.toBe(true);
    expect(store.getState().leaveBlocked).toBe(false);
    expect(saved).toHaveLength(1);
  });

  it('leaves at once when there is nothing to save', async () => {
    const save = vi.fn(async () => undefined);
    const store = openStore(save);
    await expect(store.requestLeave()).resolves.toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
});

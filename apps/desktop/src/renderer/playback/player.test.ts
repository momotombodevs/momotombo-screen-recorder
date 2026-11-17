import { afterEach, describe, expect, it, vi } from 'vitest';
import { addRecording, createProject, serializeProject, type Recording } from '@momotombo/project-model';
import { secondsToTicks as sec } from '@momotombo/timing';
import { EditorStore } from '../state/editor-store';
import { Player } from './player';

class FakeMedia {
  src = '';
  paused = true;
  readyState = 0;
  currentTime = 0;
  duration = Number.NaN;
  playbackRate = 1;
  volume = 1;
  muted = false;
  crossOrigin: string | null = null;
  preload = '';
  playsInline = false;
  released = false;
  addEventListener() { return undefined; }
  pause() { this.paused = true; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() { if (!this.src) this.released = true; }
}

function recording(id: string): Recording {
  return {
    id, createdAt: '2026-10-16T00:00:00Z', duration: sec(5),
    sources: {
      screen: { kind: 'screen', file: `${id}/screen.webm`, mime: 'video/webm', width: 1920, height: 1080, fps: 30, startOffset: 0, duration: sec(5) },
      mic: { kind: 'mic', file: `${id}/mic.webm`, mime: 'audio/webm', startOffset: 0, duration: sec(5) },
    },
    capture: { backend: 'web', platform: 'test', target: { kind: 'display', label: 'Pantalla', bounds: { x: 0, y: 0, w: 1440, h: 900 }, scaleFactor: 2 }, cursorInFrames: false, hasClicks: false },
    syncOffsets: {}, markers: [],
  };
}

function setup() {
  const created: FakeMedia[] = [];
  vi.stubGlobal('document', { createElement: () => { const el = new FakeMedia(); created.push(el); return el; } });
  vi.stubGlobal('window', { momotombo: { platform: 'test', on: () => () => undefined, invoke: async () => undefined } });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.useFakeTimers();
  const project = addRecording(createProject('Demo'), recording('r1'));
  const store = new EditorStore({ id: project.id, json: JSON.parse(serializeProject(project)), mediaBase: 'app-media://p/', dir: '/tmp/p' });
  return { store, player: new Player(store), created };
}

describe('Player', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('releases the media of a recording that left the project', () => {
    const { store, player, created } = setup();
    store.apply((p) => addRecording(p, recording('r2')));
    const added = player.elementsFor('r2');
    expect(added?.screen).toBeDefined();
    expect(added?.mic).toBeDefined();
    store.undo();
    expect(player.elementsFor('r2')).toBeUndefined();
    const r2 = created.filter((el) => el.released);
    expect(r2).toHaveLength(2);
    expect(player.elementsFor('r1')?.screen?.src).toContain('r1/screen.webm');
    player.dispose();
  });

  it('loads them again when the recording comes back', () => {
    const { store, player } = setup();
    store.apply((p) => addRecording(p, recording('r2')));
    store.undo();
    store.redo();
    expect(player.elementsFor('r2')?.screen?.src).toContain('r2/screen.webm');
    player.dispose();
  });
});

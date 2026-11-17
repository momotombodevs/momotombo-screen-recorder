/**
 * Interface test (`pnpm uitest`): the main flow, driven through the interface the way a person
 * uses it — buttons are found by their visible text or accessible name and clicked.
 *
 *   project list → open the project → edit (zoom tool, undo/redo, split, play) →
 *   automatic zoom (clear, generate) → export (finish one, pick another folder, cancel one) →
 *   back to the list
 *
 * Every exported MP4 is also opened with the operating system's own decoders (tests/media-check:
 * AVFoundation on macOS, Media Foundation on Windows), the way QuickTime or the Windows player sees
 * it: Chromium plays VP9-in-MP4 happily, QuickTime shows no picture. The packaged app's Chromium has
 * no AAC (or, without a GPU, H.264) decoder, so an MP4's picture and sound are judged by that probe.
 * A device without an H.264 hardware encoder cannot write MP4 at all: the export window must say so
 * before anything starts and offer WebM; the test checks that and goes on with WebM.
 *
 * The editor's state is only read, to check what each click did. `pnpm smoke` stays the test of
 * the parts (compositor, privacy, codecs, timeline gestures); this one checks that the parts
 * work together from the first screen to the exported file.
 */
import { parseProject, sequenceDuration, type Project } from '@momotombo/project-model';
import { secondsToTicks } from '@momotombo/timing';
import { TICKS_PER_SECOND } from '@momotombo/timing';
import { Mp4Writer } from '@momotombo/media-web';
import { PROFILE, DIST } from '../../shared/distribution';
import { api } from '../api';
import { renderStill } from '../export/exporter';
import { colorDistance, darkBands, findSquare, isFound, meanColor, type Pixels, type SquareFound } from './frame-measure';
import type { EditorStore } from '../state/editor-store';
import { avcProfileName, compareFrames, mp4Tracks, sharpness } from './mp4-stats';
import { t } from '../i18n';
import { KNOWN_SQUARE, recordLikeBrowser, synthesizeSquareScreen } from '../smoke-fixtures';
import {
  all, button, buttonStarting, click, commandKey, cpuNow, passed, cpuPercent, createSampleProject, currentEditor, decodeSound, exportsRel, frame, invoke, key, mediaUrl, Missing, option, peak, pressAt, probeVideo, q, routedExport, screenshot, sleep, text, until, type Check,
} from './harness';

/** Start of the undo / redo buttons' names; test runs are in Spanish, the shortcut part varies per platform. */
const UNDO = 'Deshacer';
const REDO = 'Rehacer';

export async function runUiTest(): Promise<unknown> {
  const checks: Check[] = [];
  const shots: string[] = [];
  const step = async (name: string, fn: () => Promise<string | void>): Promise<boolean> => {
    const t0 = performance.now();
    try {
      const detail = await fn();
      checks.push({ name, ok: true, ms: performance.now() - t0, ...(detail ? { detail } : {}) });
      return true;
    } catch (e) {
      const shot = await screenshot(`error-${checks.length + 1}`, 100).catch(() => null);
      if (shot) shots.push(shot);
      checks.push({ name, ok: false, ms: performance.now() - t0, detail: e instanceof Missing ? e.message : (e as Error).message });
      return false;
    }
  };
  const expect = (cond: unknown, message: string): void => { if (!cond) throw new Error(message); };

  // A sample recording made the way the Chromium recording path makes them, on disk before the
  // interface is touched: the list must show it like any project made earlier.
  const env = await invoke<{ realCapture: boolean; only: string | null; expectRoute: string | null }>('smoke:realRecording', { op: 'env' });
  /** MOMOTOMBO_UITEST_ONLY=export: only the project list and the export steps (CI's extra runs). */
  const editing = env.only !== 'export';
  const sample = await createSampleProject(8, 'Prueba de interfaz', recordLikeBrowser);
  const fileBase = () => currentEditor(sample.id)!.store.getState().mediaBase;

  const opened = await step('Project list: the sample project is shown and opens in the editor when clicked', async () => {
    click(button(t("Actualizar")), 'Refresh button');
    const card = await until(() => all('.project-card').find((c) => text(q('.project-meta strong', c)) === 'Prueba de interfaz'), 8000);
    expect(card, 'project card not in the list');
    // Test mode uses a fresh temporary projects folder: the sample is the only project listed.
    const cards = all('.project-card').map((c) => text(q('.project-meta strong', c)));
    expect(cards.length === 1, `the list has ${cards.length} projects: ${cards.join(', ')}`);
    click(q('.project-thumb', card!), 'project card');
    expect(await until(() => q('.editor') && currentEditor(sample.id), 10_000), 'editor did not open');
    expect(text(q('.project-title')) === 'Prueba de interfaz', `title: "${text(q('.project-title'))}"`);
    return `${cards.length} project card: ${cards[0]}`;
  });
  if (!opened) return { suite: 'ui', ok: false, checks, shots, dist: DIST };
  const { store } = currentEditor(sample.id)!;
  const autoZooms = () => store.project.zooms.filter((z) => z.origin === 'auto').length;
  const manualZooms = () => store.project.zooms.filter((z) => z.origin === 'manual').length;

  if (editing) await step('First open: automatic zoom suggestions are shown on the timeline', async () => {
    expect(await until(() => autoZooms() > 0, 12_000), 'no suggestions created');
    expect(await until(() => all('.tl-item.tl-zoom.is-auto').length === autoZooms(), 3000), `${all('.tl-item.tl-zoom.is-auto').length} on the timeline, ${autoZooms()} suggestions in the project`);
    await until(() => store.getState().save === 'saved', 5000);
    return `${autoZooms()} suggestions`;
  });

  if (editing) await step('Editing: pressing the preview with the zoom tool adds a manual zoom; undo and redo work', async () => {
    // A moment without a zoom, so the press adds one instead of re-aiming an existing one.
    key('Home');
    click(option(t("Herramienta"), t("Zoom")), 'Herramienta de zoom');
    expect(await until(() => store.getState().tool === 'zoom', 2000), 'zoom tool not selected');
    const before = store.project.zooms.map((z) => ({ ...z }));
    const ids = (zs: readonly { id: string }[]) => zs.map((z) => z.id).sort().join(',');
    pressAt(q('.preview-overlay'), 0.3, 0.4, 'preview');
    const added = await until(() => store.project.zooms.find((z) => z.origin === 'manual'), 3000);
    expect(added, 'manual zoom not added');
    expect(manualZooms() === 1, `${manualZooms()} manual zooms, expected 1`);
    expect(added!.start <= store.getState().playhead && store.getState().playhead < added!.end, 'manual zoom is not at the playhead');
    // A manual zoom replaces the suggestions it overlaps, and only those: the total is
    // before + 1 − replaced, not before + 1.
    const overlaps = (a: { start: number; end: number }) => a.start < added!.end && added!.start < a.end;
    const replaced = before.filter((z) => z.origin === 'auto' && overlaps(z));
    const kept = before.filter((z) => !replaced.includes(z));
    expect(ids(store.project.zooms.filter((z) => z.id !== added!.id)) === ids(kept), `remaining zooms differ from the expected ones (before ${before.length}, replaced ${replaced.length})`);
    expect(store.project.zooms.length === before.length + 1 - replaced.length, `total ${store.project.zooms.length}, expected ${before.length + 1 - replaced.length}`);
    expect(await until(() => all('.tl-item.tl-zoom').length === store.project.zooms.length, 3000), `${all('.tl-item.tl-zoom').length} on the timeline, ${store.project.zooms.length} zooms in the project`);
    const withManual = ids(store.project.zooms);
    click(buttonStarting(UNDO), 'Undo');
    expect(await until(() => ids(store.project.zooms) === ids(before), 3000), 'undo did not bring back the previous zooms');
    expect(await until(() => all('.tl-item.tl-zoom').length === before.length, 3000), 'timeline not updated after undo');
    click(buttonStarting(REDO), 'Redo');
    expect(await until(() => ids(store.project.zooms) === withManual, 3000), 'redo did not bring back the manual zoom');
    click(option(t("Herramienta"), t("Seleccionar")), 'Select tool');
    return `${before.length} zooms → 1 manual added, ${replaced.length} suggestions replaced → ${store.project.zooms.length} zooms`;
  });

  if (editing) await step('Editing: the play button plays the preview, the timecode advances, pause stops it', async () => {
    key('Home');
    await sleep(300);
    const shown = () => text(q('.timecode'));
    const at0 = shown();
    click(button(t("Reproducir")), 'Play button');
    expect(await until(() => store.getState().playing, 2000), 'playback did not start');
    await sleep(1500);
    click(button(t("Pausar")), 'Pause button');
    expect(await until(() => !store.getState().playing, 2000), 'playback did not stop');
    const sec = store.getState().playhead / TICKS_PER_SECOND;
    expect(sec > 0.9 && sec < 2.2, `after 1.5 s of playback the playhead is at ${sec.toFixed(2)} s`);
    expect(shown() !== at0, 'timecode did not change');
    const still = store.getState().playhead;
    await sleep(300);
    expect(store.getState().playhead === still, 'the playhead kept moving after pause');
    return `playhead ${sec.toFixed(2)} s`;
  });

  if (editing) await step('Editing: the S key splits the clip at the playhead, undo joins it again', async () => {
    const before = store.project.sequence.segments.length;
    key('s');
    expect(await until(() => store.project.sequence.segments.length === before + 1, 2000), 'clip not split');
    expect(await until(() => all('.tl-seg.tl-seg-screen').length === before + 1, 3000), 'split clip not shown on the timeline');
    key('z', commandKey());
    expect(await until(() => store.project.sequence.segments.length === before, 2000), 'undo did not remove the split');
  });

  // Windows shows its own shortcut names: Ctrl, Alt, Shift — never the Mac's ⌘ ⌥ ⇧ (CLAUDE.md user
  // decision 2026-11-13). Every visible text, accessible name and tooltip of the editor is read.
  if (editing && window.momotombo?.platform === 'win32') await step('Windows shortcuts: no ⌘ ⌥ ⇧, Ctrl is shown; Ctrl+Z really undoes', async () => {
    const labels = all('button, [role="radio"], [title], kbd, .kbd, .shortcut').flatMap((el) => [text(el), el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? '']).filter(Boolean);
    const mac = [...new Set(labels.filter((l) => /[⌘⌥⇧]/.test(l)))];
    expect(mac.length === 0, `labels with Mac symbols: ${mac.slice(0, 8).join(' · ')}`);
    const undo = buttonStarting(UNDO);
    const undoLabel = undo?.getAttribute('aria-label') ?? text(undo);
    expect(/Ctrl/.test(undoLabel), `undo label: "${undoLabel}"`);
    // Ctrl+Z on a real change: a split, then Ctrl+Z, takes it back.
    const before = store.project.sequence.segments.length;
    key('s');
    expect(await until(() => store.project.sequence.segments.length === before + 1, 2000), 'clip not split');
    key('z', { ctrlKey: true });
    expect(await until(() => store.project.sequence.segments.length === before, 2000), 'Ctrl+Z did not undo the split');
    return `${labels.length} labels read, undo: "${undoLabel}"`;
  });

  if (editing) await step('Automatic zoom: "Clear suggestions" and "Generate suggestions" in the Zoom tab work and leave the manual zoom alone', async () => {
    click(option(t("Grupo de ajustes"), t("Zoom")), 'Zoom tab');
    const before = autoZooms();
    click(await until(() => button(t("Borrar sugerencias")), 3000), 'Borrar sugerencias');
    expect(await until(() => autoZooms() === 0, 3000), 'suggestions not cleared');
    expect(manualZooms() === 1, 'clearing also deleted the manual zoom');
    const t0 = performance.now();
    click(button(t("Generar sugerencias")), 'Generar sugerencias');
    expect(await until(() => autoZooms() > 0, 8000, 10), 'suggestions not generated');
    const ms = performance.now() - t0;
    expect(manualZooms() === 1, 'generating suggestions changed the manual zoom');
    // Suggestions never overlap each other or the manual zoom.
    const zs = [...store.project.zooms].sort((a, b) => a.start - b.start);
    expect(zs.every((z, i) => i === 0 || zs[i - 1]!.end <= z.start), 'zooms overlap');
    expect(await until(() => all('.tl-item.tl-zoom.is-auto').length === autoZooms(), 3000), 'suggestions not shown on the timeline');
    return `${before} suggestions cleared, ${autoZooms()} suggestions arrived in ${ms.toFixed(0)} ms`;
  });

  const expected = () => sequenceDuration(store.project) / TICKS_PER_SECOND;
  let ext: 'mp4' | 'webm' = PROFILE.defaultExport;
  /** Set when this device cannot write MP4 (no H.264 hardware encoder): the window's message. */
  let mp4Unavailable: string | null = null;
  let route = 'webcodecs';
  let encoderLine = '';
  let exportStart = 0;
  let cpuBefore = await cpuNow();
  /** Numbers of the first export (CI summary): route, speed, file and picture quality. */
  let exportFacts: Record<string, unknown> | null = null;
  let firstFolder = '';
  const exportedUrl = (n = 1) => mediaUrl(fileBase(), `exports/Prueba de interfaz 16x9${n > 1 ? ` (${n})` : ''}.${ext}`);
  /** The system's own decoders on an MP4 (WebM is not a QuickTime format; Chromium checks those). */
  const systemProbe = async (path: string): Promise<AvCheck | null> => {
    if (ext !== 'mp4') return null;
    const r = await invoke<AvCheck>('smoke:avCheck', { path, duration: expected() });
    if (r.skipped) return null;
    expect(r.ok, `${r.engine ?? 'system probe'}: ${r.problems.join('; ')}`);
    return r;
  };
  const describe = (r: AvCheck | null): string => (r
    ? `${r.engine}: ${r.video?.codec} ${r.video?.decodedFrames} frames decoded, ${r.audio?.codec.trim()} ${r.audio?.decodedSeconds?.toFixed(2)} s`
    : ext === 'mp4' ? 'no system probe' : 'WebM: no system probe');
  const systemCheck = async (path: string): Promise<string> => describe(await systemProbe(path));
  // Shown with the system's separators; compared with '/' (Windows writes '\').
  /**
   * Presses the window's "Exportar" once it can start: after any change (format, target, a
   * finished or cancelled export) the window asks the encoders and the target again, and the button
   * stays disabled until both answered.
   */
  const clickExport = async (): Promise<void> => {
    const footer = () => q('.export-modal footer');
    const ready = await until(() => (footer() ? button(t("Exportar"), footer()!) : null), 20_000);
    const state = footer() ? all<HTMLButtonElement>('button', footer()!).map((b) => `${text(b)}${b.disabled ? ' (disabled)' : ''}`).join(', ') : 'no window';
    click(ready, `Export in the window (not pressable within 20 s; footer: ${state})`);
  };
  const donePath = (): string => (q('.export-done span')?.getAttribute('title') ?? '').replace(/\\/g, '/');

  await step(`Export: the window writes a ${ext.toUpperCase()} 1080p30 file that plays`, async () => {
    // Export-only runs skip the editing steps: the first automatic zoom suggestions must have arrived
    // (and been saved) before the export, or the file and the reference frame show different projects.
    if (!editing) await until(() => autoZooms() > 0, 12_000);
    await until(() => store.getState().save === 'saved', 5000);
    click(button(t("Exportar"), q('.topbar-right')!), 'Export in the top bar');
    const dialog = await until(() => q('.export-modal'), 3000);
    expect(dialog, 'export window did not open');
    click(option(t("Fotogramas por segundo"), t("30 fps"), dialog!), '30 fps');
    await frame();
    // The window decides the route before anything starts (export/route.ts): hardware H.264,
    // Windows' Media Foundation encoders ("codificador por software de Windows"), or WebM said plainly.
    const footer = () => q('.export-modal footer')!;
    const decided = await until(() => q('.export-unsupported', dialog!) ?? (button(t("Exportar"), footer()) && q('.export-encoder', dialog!)), 20_000);
    expect(decided, 'the window did not say which encoder will write the file');
    expect(!decided!.classList.contains('export-unsupported'), `${ext.toUpperCase()} cannot be written: ${text(decided)}`);
    encoderLine = text(q('.export-encoder', dialog!));
    const fallback = q('.export-fallback', dialog!);
    route = fallback ? 'webm-fallback' : /Windows/.test(encoderLine) ? 'mf' : 'webcodecs';
    if (env.expectRoute) expect(route === env.expectRoute, `route ${route}, expected ${env.expectRoute} · "${encoderLine}"${fallback ? ` · "${text(fallback)}"` : ''}`);
    if (fallback) {
      // WebM instead of MP4: the window says so, names the .webm file, and the export can start.
      mp4Unavailable = text(fallback);
      expect(ext === 'mp4', `WebM notice for ${ext}`);
      expect(/WebM/.test(mp4Unavailable) && /\.webm/.test(mp4Unavailable), `the notice does not name the WebM file: "${mp4Unavailable}"`);
      ext = 'webm';
      expect(await until(() => text(q('.export-target-text strong')).endsWith('.webm'), 3000), 'save location is not .webm');
    }
    cpuBefore = await cpuNow();
    exportStart = performance.now();
    await clickExport();
    expect(await until(() => q('.export-progress .bar') || q('.export-done') || q('.export-progress .is-error'), 10_000, 20), 'progress bar not shown');
    const end = await until(() => q('.export-done') ?? q('.export-progress .is-error'), 150_000, 50);
    expect(end, 'export did not finish within 150 s');
    expect(end!.classList.contains('export-done'), `error: ${text(end)}`);
    const seconds = (performance.now() - exportStart) / 1000;
    const cpu = cpuPercent(cpuBefore, await cpuNow());
    expect(button(t("Mostrar en la carpeta"), dialog!), 'no "Mostrar en la carpeta" button');
    if (mp4Unavailable) expect(q('.export-fallback-done'), 'no "Se guardó como WebM en lugar de MP4." note at the end');
    const done = text(q('.export-done span'));
    expect(/MB/.test(done), `no file size in the done line: "${done}"`);
    expect(donePath().endsWith(`/exports/Prueba de interfaz 16x9.${ext}`), `file path: "${donePath()}"`);
    firstFolder = donePath().slice(0, donePath().lastIndexOf('/'));
    // An MP4 is judged by the system's decoders; Chromium's view is reported next to it. A WebM
    // (or an MP4 on a system without a probe) is judged by Chromium.
    const system = await systemProbe(donePath());
    const chromium = await probeVideo(exportedUrl(), expected() / 2);
    const file = system
      ? { duration: system.duration, width: Math.round(system.video?.width ?? 0), height: Math.round(system.video?.height ?? 0), spread: system.video?.spread ?? 0 }
      : chromium;
    if (!system) expect(chromium.ok, 'exported file could not be opened');
    // Never shorter than the timeline by more than one frame (1/30 s). Longer by at most 0.12 s:
    // the Opus encoder pads the last packets and the writers do not trim that tail (about 0.09 s
    // measured), so the file reads a little longer than the picture.
    const diff = file.duration - expected();
    expect(diff > -1 / 30 && diff < 0.12, `file ${file.duration.toFixed(3)} s, timeline ${expected().toFixed(3)} s`);
    expect(file.width === 1920 && file.height === 1080, `size ${file.width}×${file.height}`);
    expect(file.spread > 0.02, `middle frame is one color (brightness spread ${file.spread.toFixed(3)})`);
    let soundSeconds: number;
    if (system) {
      soundSeconds = system.audio?.decodedSeconds ?? 0;
      expect((system.audio?.peak ?? 0) > 0.01, `audio is silent (peak ${(system.audio?.peak ?? 0).toFixed(4)})`);
    } else {
      const sound = await decodeSound(exportedUrl()).catch((e: Error) => { throw new Error(`audio could not be decoded: ${e.message}`); });
      soundSeconds = sound.duration;
      expect(peak(sound) > 0.01, `audio is silent (peak ${peak(sound).toFixed(4)})`);
    }
    expect(soundSeconds > expected() - 0.05 && soundSeconds < expected() + 0.12, `audio ${soundSeconds.toFixed(2)} s, timeline ${expected().toFixed(2)} s`);
    // What the file itself says (boxes) and how its picture compares with the frame it should show.
    const bytes = new Uint8Array(await (await fetch(exportedUrl())).arrayBuffer());
    const tracks = ext === 'mp4' ? mp4Tracks(bytes) : [];
    const v = tracks.find((x) => x.handler === 'vide');
    const a = tracks.find((x) => x.handler === 'soun');
    const quality = chromium.ok ? await pictureQuality(store, exportedUrl(), expected() / 2).catch((e: Error) => ({ error: e.message })) : { error: 'Chromium cannot decode this file' };
    exportFacts = {
      route, encoder: encoderLine, format: ext, seconds: Math.round(seconds * 10) / 10, framesPerSecond: Math.round(((expected() * 30) / seconds) * 10) / 10, cpuPercent: Math.round(cpu),
      bytes: bytes.length, fileKbps: Math.round((bytes.length * 8) / file.duration / 1000),
      ...(v ? { video: { codec: v.codec, profile: avcProfileName(v.avcProfile), level: v.avcLevel, kbps: Math.round(v.kbps), frames: v.samples } } : {}),
      ...(a ? { audio: { codec: a.codec, kbps: Math.round(a.kbps) } } : {}),
      quality, ...(mp4Unavailable ? { fallback: mp4Unavailable } : {}),
      // The real recording test reads frames of its export the same way (grabFrame): does it work on
      // this export of this machine? (Windows CI run 9 could not read the recording's WebM export.)
      frameGrab: await grabFrame(exportedUrl(), expected() / 2).then((g) => ({ ok: true, size: `${g.px.width}×${g.px.height}`, reached: g.reached }), (e: Error) => ({ ok: false, error: e.message })),
    };
    if (route === 'mf') {
      expect(v?.codec === 'avc1' && a?.codec === 'mp4a', `Media Foundation file is not H.264 + AAC: ${tracks.map((x) => x.codec).join(', ')}`);
      // bitrateFor: 1080p30 high quality is 12 Mbit/s; a software encoder may stay below it on simple pictures.
      expect(v!.kbps > 2_000 && v!.kbps < 16_000, `video bit rate ${Math.round(v!.kbps)} kbit/s (target 12 000)`);
      expect(a!.kbps > 150 && a!.kbps < 230, `audio bit rate ${Math.round(a!.kbps)} kbit/s (target 192)`);
    }
    if ('psnr' in quality) {
      expect(quality.psnr > 24, `decoded frame differs too much from the expected one (PSNR ${quality.psnr.toFixed(1)} dB)`);
      expect(quality.sharpnessRatio > 0.5, `decoded frame is blurry (sharpness ratio ${quality.sharpnessRatio.toFixed(2)})`);
    }
    const shot = await screenshot('export-done', 200);
    if (shot) shots.push(shot);
    const viewer = system ? ` · Chromium ${chromium.ok ? `opened it too (${chromium.width}×${chromium.height})` : 'could not open it (no decoder in this package)'}` : '';
    return `${done}, ${file.duration.toFixed(2)} s (timeline ${expected().toFixed(2)}), ${file.width}×${file.height}, audio ${soundSeconds.toFixed(2)} s · ${describe(system)}${viewer} · ${JSON.stringify(exportFacts)}`;
  });

  // Test runs never open the system save dialog: "Cambiar…" picks a temporary folder outside
  // the project, standing in for the user's choice (main.ts export:chooseTarget).
  let chosenFolder = '';
  await step('Save location: the folder picked with "Cambiar…" is shown in the window and the file is written there', async () => {
    const dialog = q('.export-modal');
    expect(dialog, 'export window is closed');
    expect(await until(() => text(q('.export-target-text strong')).endsWith(`.${ext}`), 3000), `save location not shown: "${text(q('.export-target'))}"`);
    click(button(t("Cambiar…"), q('.export-target')!), 'Cambiar…');
    expect(await until(() => text(q('.export-target-text span')).endsWith('Chosen folder'), 3000), `chosen folder not shown: "${text(q('.export-target-text span'))}"`);
    const shot = await screenshot('export-save-location', 200);
    if (shot) shots.push(shot);
    await clickExport();
    // The previous export's "Ready" line goes away first; only then wait for this one's.
    expect(await until(() => !q('.export-done'), 5000, 10), 'export did not start');
    const end = await until(() => q('.export-done') ?? q('.export-progress .is-error'), 150_000, 50);
    expect(end?.classList.contains('export-done'), `error: ${text(end) || text(q('.export-progress'))}`);
    const path = donePath();
    chosenFolder = path.slice(0, path.lastIndexOf('/'));
    expect(chosenFolder.endsWith('/Chosen folder') && !chosenFolder.includes('/exports'), `file written elsewhere: "${path}"`);
    const files = await invoke<string[]>('smoke:listDir', { path: chosenFolder });
    expect(files.length === 1 && files[0] === `Prueba de interfaz 16x9.${ext}`, `in the folder: ${files.join(', ') || 'nothing'}`);
    const system = await systemCheck(path);
    // The folder stays for the next export: the window offers a fresh name in it.
    expect(await until(() => text(q('.export-target-text strong')) === `Prueba de interfaz 16x9 (2).${ext}`, 3000), `next name: "${text(q('.export-target-text strong'))}"`);
    return `${path.slice(path.indexOf('/Chosen folder'))} · ${system}`;
  });

  await step('Export: Cancel deletes the partial file and the window can be used again', async () => {
    const dialog = q('.export-modal');
    expect(dialog, 'export window is closed');
    await clickExport();
    click(await until(() => button(t("Cancelar"), dialog!), 5000, 10), 'Cancelar');
    expect(await until(() => text(q('.export-progress')).includes(t("Cancelado; se eliminó el archivo incompleto.")), 15_000, 50), `no cancel message: "${text(q('.export-progress'))}"`);
    expect(!(await probeVideo(exportedUrl(2))).ok, 'the cancelled file stayed on disk');
    // The Media Foundation path writes "<name>.<random>.momotombo-part.mp4" while it works.
    if (firstFolder) {
      const left = (await invoke<string[]>('smoke:listDir', { path: firstFolder })).filter((f) => /momotombo-part|\.part$/i.test(f));
      expect(left.length === 0, `a partial file stayed after cancel: ${left.join(', ')}`);
    }
    if (chosenFolder) {
      const files = await invoke<string[]>('smoke:listDir', { path: chosenFolder });
      expect(files.length === 1 && files[0] === `Prueba de interfaz 16x9.${ext}`, `in the chosen folder after cancel: ${files.join(', ')}`);
    }
    // The window asks the encoders again after a cancel; on a slow machine that takes a moment.
    const again = await until(() => button(t("Exportar"), q('.export-modal footer')!), 10_000);
    const state = all<HTMLButtonElement>('button', q('.export-modal footer')!).map((b) => `${text(b)}${b.disabled ? ' (disabled)' : ''}`).join(', ');
    expect(again, `no Export button 10 s after cancel; footer: ${state || 'empty'}; ${text(q('.export-unsupported')) || ''}`);
    click(button(t("Cerrar"), dialog!), 'close the window');
    expect(await until(() => !q('.export-modal'), 2000), 'window did not close');
  });

  if (editing) await step('Back to projects: changes are saved, the project stays in the list with its thumbnail', async () => {
    const saved = JSON.stringify([...store.project.zooms].sort((a, b) => a.start - b.start));
    click(button(t("Volver a proyectos")), 'Back to projects');
    const card = await until(() => all('.project-card').find((c) => text(q('.project-meta strong', c)) === 'Prueba de interfaz'), 8000);
    expect(card, 'project not in the list');
    expect(await until(() => q('.project-thumb img', card!), 5000), 'no thumbnail');
    click(q('.project-thumb', card!), 'project card');
    const again = await until(() => (q('.editor') ? currentEditor(sample.id) : null), 10_000);
    expect(again, 'project did not reopen');
    // What was edited is what comes back from disk.
    const p = again!.store.project;
    expect(p.zooms.filter((z) => z.origin === 'manual').length === 1 && p.zooms.filter((z) => z.origin === 'auto').length > 0, `${p.zooms.length} zooms after reopening`);
    expect(JSON.stringify([...p.zooms].sort((a, b) => a.start - b.start)) === saved, 'zooms read from disk differ from the ones before closing');
    return `${p.zooms.length} zooms saved`;
  });

  if (editing) await step('The system probe proves itself: on the old build\'s VP9 + Opus MP4 it says "video cannot be decoded"', async () => {
    if (PROFILE.defaultExport !== 'mp4') return 'WebM distribution: skipped';
    // What the published build wrote as "MP4" until 2026-11-13 (vp09 + Opus boxes).
    await invoke('smoke:writeFile', { projectId: sample.id, path: 'exports/old-vp9.mp4', data: await oldStyleMp4() });
    const r = await invoke<AvCheck>('smoke:avCheck', { projectId: sample.id, path: 'exports/old-vp9.mp4' });
    if (r.skipped) return `no system probe: ${r.problems.join('; ')}`;
    expect(!r.ok, 'the probe accepted the VP9 MP4');
    expect(r.problems.some((p) => p.startsWith('video cannot be decoded')), `problems: ${r.problems.join('; ')}`);
    expect(r.problems.some((p) => p.startsWith('audio is not AAC')), `problems: ${r.problems.join('; ')}`);
    return `${r.engine}: ${r.problems.join('; ')}`;
  });

  // The export the real recording test measures goes where the user's last export went: after
  // "Cambiar…" above, the picked folder outside the project, which the media protocol does not
  // serve. The same reading (readExport → Blob URL) and the same square measurement, on a synthetic
  // 4:3 screen with the click driver's square, so they run on every machine (Windows CI run 10
  // could not read that export).
  if (editing && chosenFolder) {
    await step('Export (to the chosen folder): the known square of a synthetic recording is read in the exported frame, centered in place, square and magenta', async () => {
      const k = KNOWN_SQUARE;
      const syn = await synthesizeSquareScreen(3);
      const { id } = await api.createProject('Square measurement');
      const recordingId = `rec_${crypto.randomUUID()}`;
      const file = `media/${recordingId}/screen.${syn.videoMime === 'video/webm' ? 'webm' : 'mp4'}`;
      await invoke('smoke:writeFile', { projectId: id, path: file, data: syn.screen });
      const dur = secondsToTicks(3);
      await invoke('smoke:appendRecording', {
        projectId: id,
        recording: {
          id: recordingId, createdAt: new Date().toISOString(), duration: dur,
          sources: { screen: { kind: 'screen', file, mime: syn.videoMime, width: syn.width, height: syn.height, fps: 30, startOffset: 0, duration: dur } },
          capture: { backend: 'web', platform: 'smoke', target: { kind: 'display', label: 'Synthetic square', bounds: { x: 0, y: 0, w: syn.width, h: syn.height }, scaleFactor: 1 }, cursorInFrames: true, hasClicks: false },
          syncOffsets: {}, markers: [],
        },
      });
      const opened = await api.openProject(id);
      const project = parseProject(opened.json);
      const r = await routedExport(project, {}, opened.mediaBase, { variantId: 'v_16x9', format: 'webm', resolution: '1080', fps: 30, quality: 'standard', includeAudio: false }, () => undefined, new AbortController().signal);
      expect(r.phase === 'done' && r.path, `export did not finish: ${r.phase} ${r.message ?? ''}`);
      const where = r.path!.replace(/\\/g, '/');
      expect(!where.includes('/exports/') && where.includes('/Chosen folder/'), `file not written to the chosen folder: ${where}`);
      const src = await exportedFrameSource(r.path!, opened.mediaBase);
      let g: Awaited<ReturnType<typeof grabFrame>>;
      try { g = await grabFrame(src.url, 1.5); } finally { src.release(); }
      // The 4:3 screen sits centered in the 16:9 frame (pillars): x and width shrink by 3/4.
      const share = (k.screenW / k.screenH) / (16 / 9);
      const e = { fx: 0.5 + (k.x / k.screenW - 0.5) * share, fy: k.y / k.screenH, fw: (k.size / k.screenW) * share, fh: k.size / k.screenH };
      const f = findSquare(g.px, { cx: e.fx + e.fw / 2, cy: e.fy + e.fh / 2, fw: e.fw, fh: e.fh });
      expect(isFound(f), `square not found: ${isFound(f) ? '' : f.reason} (${src.how})`);
      const box = f as SquareFound;
      const near = (a: number, b: number) => Math.abs(a - b) < 0.012;
      const ratio = (box.fw * g.px.width) / (box.fh * g.px.height);
      const at = `expected x ${e.fx.toFixed(3)} y ${e.fy.toFixed(3)} w ${e.fw.toFixed(3)} h ${e.fh.toFixed(3)} · found x ${box.fx.toFixed(3)} y ${box.fy.toFixed(3)} w ${box.fw.toFixed(3)} h ${box.fh.toFixed(3)}`;
      // The scene's background frame shrinks the screen around the middle (layout), so the square's
      // middle is judged here, its size only reported; the shape and the colour are judged exactly.
      expect(near(box.fx + box.fw / 2, e.fx + e.fw / 2) && near(box.fy + box.fh / 2, e.fy + e.fh / 2), `the square's center is not in place: ${at}`);
      expect(Math.abs(ratio - 1) < 0.02, `aspect ${ratio.toFixed(3)} (should be 1) · ${at}`);
      expect(colorDistance(box.rgb, [255, 0, 255]) < 60, `color ${JSON.stringify(box.rgb)} (should be magenta)`);
      return `${where.slice(where.indexOf('/Chosen folder/'))} · ${src.how} · ${g.px.width}×${g.px.height} · aspect ${ratio.toFixed(3)}, color ${JSON.stringify(box.rgb)} · ${at}`;
    });
  }

  // Only when asked (CI on Windows): macOS needs the screen recording permission, which a test
  // run never asks for.
  let realCapture: RealCapture | null = null;
  if (editing && env.realCapture) {
    await step('Real screen recording (Chromium path): a few seconds of recording files are written, the picture is not blank, the clicks are in the cursor log', async () => {
      realCapture = await recordScreen(shots);
      return realCapture.summary;
    });
    const rc = realCapture as RealCapture | null;
    // The driver's known square (tests/real-capture-web/windows-clicks.ps1), measured in the real
    // recording. Every check here stops a release: since Windows CI run 10 the recording is of the real
    // display (run 9 showed the fake capture device's pattern instead, main.ts). Only a frame the test
    // itself cannot read is reported as "not measured" (known issue).
    if (rc && !rc.shape) {
      checks.push({ name: 'Real screen recording: the known square could be measured', ok: false, detail: rc.shapeMissing ?? 'square not measured' });
    }
    if (rc?.shape) {
      const { expected: e, found: f, ratio, drawn } = rc.shape;
      const near = (a: number, b: number) => Math.abs(a - b) < 0.012;
      const where = `on screen x ${e.fx.toFixed(3)} y ${e.fy.toFixed(3)} w ${e.fw.toFixed(3)} h ${e.fh.toFixed(3)}${f ? ` · in the video x ${f.fx.toFixed(3)} y ${f.fy.toFixed(3)} w ${f.fw.toFixed(3)} h ${f.fh.toFixed(3)} (fill ${f.fill}, black frame ${f.ring})` : ''}`;
      // 1. The recording shows the desktop: the square is in the raw frame, at its place and size
      //    (fractions of the screen and of the frame, so a squeezed frame keeps them).
      const placed = !!f && near(f.fx, e.fx) && near(f.fy, e.fy) && near(f.fw, e.fw) && near(f.fh, e.fh);
      checks.push({
        name: 'Real screen recording: the recording shows the desktop (the known square on screen is in the raw frame, place and size ±0.012)',
        ok: placed,
        detail: f ? where : `square not in the recording · ${where} · moments tried: ${JSON.stringify(rc.shape.samples)} · driver: ${JSON.stringify(rc.shape.driver)}`,
      });
      // 2. A square stays a square: as the app draws it, and in the file itself unless the source
      //    stored the display's shape (displayAspect: the file's frames are then known to be squeezed).
      if (f) {
        const rawOk = ratio !== null && Math.abs(ratio - 1) < 0.02;
        const drawnOk = drawn !== null && Math.abs(drawn - 1) < 0.02;
        const stored = rc.source?.displayAspect;
        checks.push({
          name: 'Real screen recording: the known square stays square (aspect 1 ± 2% in the raw file and as the app draws it)',
          ok: drawnOk && (rawOk || !!stored),
          detail: `raw file ${ratio}, drawn ${drawn}${stored ? ` (displayAspect ${stored.toFixed(4)} stored: the raw frames are known to be squeezed, the raw ratio is only reported)` : ''} · ${where}`,
        });
      }
      // 3. Colours: the square's colour in the recording against what the driver read off the screen.
      const screenRgb = (rc.shape.driver as { screenColor?: unknown } | null)?.screenColor;
      if (f) {
        const ok = Array.isArray(screenRgb) && colorDistance(f.rgb, screenRgb.map(Number)) < 60;
        checks.push({
          name: 'Real screen recording: colors are right (the magenta square on screen is magenta in the recording too, difference < 60)',
          ok,
          detail: Array.isArray(screenRgb) ? `on screen RGB ${JSON.stringify(screenRgb)}, in the recording ${JSON.stringify(f.rgb)} (difference ${colorDistance(f.rgb, screenRgb.map(Number))})` : `the driver could not read the color on screen: ${JSON.stringify(screenRgb)}`,
        });
      }
    }
    if (rc?.exported) {
      const x = rc.exported;
      const notMeasured = 'found' in x && !x.found && !!x.measureError;
      checks.push({
        name: 'Real screen recording exported (WebM 1080p): the known square is still square (aspect 1 ± 2%)',
        ok: 'ratio' in x && x.ratio !== null && Math.abs(x.ratio - 1) < 0.02,
        // Only the test failing to read a frame of the export is not a release stop.
        ...(notMeasured ? { known: 'not measured: the test could not read a frame of the exported video' } : {}),
        detail: 'error' in x ? `export: ${x.error}` : x.found ? `aspect ${x.ratio}, in the video x ${x.found.fx.toFixed(3)} y ${x.found.fy.toFixed(3)} w ${x.found.fw.toFixed(3)} h ${x.found.fh.toFixed(3)}, ${x.seconds} s` : `square not found in the exported video: ${x.misses.join(' · ')}`,
      });
    }
    if (rc?.screen && rc.display) {
      // A display recording must keep the display's shape (zoom targets and clicks are fractions of it).
      const { screen, display } = rc;
      checks.push({
        name: 'Real screen recording: the video has the display\'s aspect ratio, or the source stores the display\'s real ratio (not cropped)',
        ok: (Math.abs(screen.width / screen.height - display.w / display.h) < 0.02 || Math.abs((rc.source?.displayAspect ?? 0) - display.w / display.h) < 0.02)
          && !!screen.bars && screen.bars.left + screen.bars.right + screen.bars.top + screen.bars.bottom === 0,
        detail: `${rc.source?.displayAspect ? `frames ${screen.width}×${screen.height}, stored ratio ${rc.source.displayAspect.toFixed(4)} · ` : ''}display ${display.w}×${display.h} (scale ${display.scale}), requested (ideal) ${display.w * display.scale}×${display.h * display.scale}, source track (getSettings) ${rc.source?.width}×${rc.source?.height}, video ${screen.width}×${screen.height}, edge bands ${screen.bars ? `left ${screen.bars.left} right ${screen.bars.right} top ${screen.bars.top} bottom ${screen.bars.bottom} px` : 'not measured'}`,
      });
    }
  }

  return { suite: 'ui', ok: passed(checks), knownIssues: checks.filter((c) => !c.ok && c.known).length, checks, shots, dist: DIST, ...(env.only ? { only: env.only } : {}), ...(exportFacts ? { exportFacts } : {}), ...(mp4Unavailable ? { mp4Unavailable } : {}), ...(realCapture ? { realCapture } : {}) };
}

interface AvCheck {
  ok: boolean;
  skipped?: boolean;
  /** AVFoundation (macOS) or Media Foundation (Windows). */
  engine?: string;
  problems: string[];
  duration: number;
  video: { codec: string; decodedFrames: number; width?: number; height?: number; spread?: number } | null;
  audio: { codec: string; decodedSeconds?: number; peak?: number } | null;
}

/** One second of VP9 + Opus in MP4, as the published build wrote "MP4" before 2026-11-13. */
async function oldStyleMp4(): Promise<Uint8Array> {
  const width = 640;
  const height = 360;
  const parts: { d: Uint8Array; p: number | null }[] = [];
  const audio: { codec: 'opus'; sampleRate: number; channels: number; description?: Uint8Array } = { codec: 'opus', sampleRate: 48_000, channels: 2 };
  const w = new Mp4Writer({ video: { codec: 'vp09', width, height, codecString: 'vp09.00.41.08' }, audio, sink: async (d, p) => { parts.push({ d: d.slice(), p }); } });
  let chain = Promise.resolve();
  const venc = new VideoEncoder({
    output: (c) => { const d = new Uint8Array(c.byteLength); c.copyTo(d); const ts = c.timestamp; const key = c.type === 'key'; chain = chain.then(() => w.addVideo(d, ts, 33_333, key)); },
    error: (e) => { throw e; },
  });
  venc.configure({ codec: 'vp09.00.41.08', width, height, bitrate: 2e6, framerate: 30 });
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d')!;
  for (let i = 0; i < 30; i++) {
    g.fillStyle = '#204060'; g.fillRect(0, 0, width, height);
    g.fillStyle = '#f0c040'; g.fillRect(40 + i * 10, 120, 120, 120);
    const f = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / 30), duration: 33_333 });
    venc.encode(f, { keyFrame: i === 0 });
    f.close();
  }
  await venc.flush();
  venc.close();
  const aenc = new AudioEncoder({
    output: (c, meta) => {
      const d = new Uint8Array(c.byteLength); c.copyTo(d);
      if (meta?.decoderConfig?.description) audio.description = new Uint8Array(meta.decoderConfig.description as ArrayBuffer);
      const ts = c.timestamp; const dur = c.duration ?? 20_000;
      chain = chain.then(() => w.addAudio(d, ts, dur));
    },
    error: (e) => { throw e; },
  });
  aenc.configure({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 2, bitrate: 96_000 });
  const n = 48_000;
  const pcm = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) pcm[i] = pcm[n + i] = Math.sin((2 * Math.PI * 440 * i) / 48_000) * 0.3;
  aenc.encode(new AudioData({ format: 'f32-planar', sampleRate: 48_000, numberOfFrames: n, numberOfChannels: 2, timestamp: 0, data: pcm }));
  await aenc.flush();
  aenc.close();
  await chain;
  await w.finish();
  let size = 0;
  let pos = 0;
  for (const x of parts) { const at = x.p ?? pos; size = Math.max(size, at + x.d.length); if (x.p === null) pos += x.d.length; }
  const out = new Uint8Array(size);
  pos = 0;
  for (const x of parts) { const at = x.p ?? pos; out.set(x.d, at); if (x.p === null) pos += x.d.length; }
  return out;
}

interface RealCapture {
  summary: string;
  backend: string | null;
  clicksCapability: boolean;
  seconds: number;
  screen: { width: number; height: number; duration: number; frames: number; spread: number; black: boolean; bars: ReturnType<typeof darkBands> | null } | null;
  /** What the recording says about its screen video, and the display it recorded. */
  source: { width?: number; height?: number; fps?: number; seconds: number; displayAspect?: number } | null;
  display: { w: number; h: number; scale: number } | null;
  mic: { duration: number; peak: number } | { skipped: string } | null;
  cursor: { moves: number; downs: number; buttons: string };
  driver: { clicks: number; matched: number; worstOffset: number } | null;
  /** The driver's 240 px magenta square: where it was on screen and where/how it shows in the video. */
  /** ratio: in the file's frames; drawn: as the editor and the export draw it (displayAspect applied). */
  shape: { expected: { fx: number; fy: number; fw: number; fh: number }; found: SquareFound | null; ratio: number | null; drawn: number | null; driver: unknown; samples: unknown[]; scales: unknown } | null;
  /** Why the driver's square could not be measured at all (no driver log, no screen file). */
  shapeMissing?: string;
  /**
   * The recording exported (WebM 1080p, 16:9 frame): the same square's proportions there.
   * measureError: the test could not read a frame of the export (a fault of the measurement, not of
   * the export), with the browser's reason.
   */
  exported: { seconds: number; ratio: number | null; found: SquareFound | null; misses: string[]; measureError?: string } | { error: string } | null;
  /**
   * What the recorder found about the screen track, when the app records it (asked of the capture
   * code: capabilities, settings, the first frame's size, which attempt gave the right shape).
   */
  frameCheck: unknown;
  /**
   * Small JPEGs (320 px wide) to look at by eye in the CI log (tests/windows-env/ci-summary.mjs writes
   * them, log-images.mjs gets them back): the screen as the driver saw it, the recorded frame as it is
   * in the file, the same moment as the app draws it, and the exported WebM's frame.
   */
  images: { name: string; note: string; jpeg?: string; error?: string }[];
}

/**
 * Records the main display for about six seconds through the Chromium path (backend "web"), as
 * the recording screen does, without camera or microphone: this run has no fake devices (they would
 * replace the screen with Chromium's test pattern, main.ts) and a CI machine has no real ones; the
 * microphone path is the smoke test's. An outside driver
 * (tests/real-capture-web/windows-clicks.ps1) clicks while the "recording" marker exists; its
 * clicks must come back in the cursor log at the same place. A black or empty picture fails.
 */
async function recordScreen(shots: string[]): Promise<RealCapture> {
  const expect = (cond: unknown, message: string): void => { if (!cond) throw new Error(message); };
  const backends = await api.backends();
  const web = backends.find((b) => b.id === 'web');
  const display = (await api.sources()).find((s) => s.kind === 'display');
  expect(display, 'no display to record in the list');
  const devices = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).map((d) => d.kind);
  await api.startCapture({
    projectName: 'Real recording', target: { kind: 'display', sourceId: display!.id, displayId: display!.displayId, label: display!.name },
    cameraDeviceId: null, cameraLabel: null, micDeviceId: null, micLabel: null,
    systemAudio: false, fps: 30, quality: 'standard', countdown: 0, backend: 'web',
  });
  const recording = await untilAsync(async () => (await api.captureState()).phase === 'recording', 30_000);
  const state = await api.captureState();
  expect(recording, `recording did not start: ${state.phase}${state.message ? ` (${state.message})` : ''}`);
  await invoke('smoke:realRecording', { op: 'signal', name: 'recording' });
  const seconds = 6;
  await sleep(seconds * 1000);
  await invoke('smoke:realRecording', { op: 'signal', name: 'stopped' });
  const result = await api.stopCapture();
  expect(result, 'no result after stopping the recording');
  const opened = await api.openProject(result!.projectId);
  const project = parseProject(opened.json);
  const rec = project.recordings[result!.recordingId];
  expect(rec, 'recording not in the project');
  const url = (rel: string) => mediaUrl(opened.mediaBase, rel);

  let screen: RealCapture['screen'] = null;
  const src = rec!.sources.screen;
  if (src) {
    const kept = await invoke<string>('smoke:realRecording', { op: 'keep', projectId: project.id, path: src.file, as: `real-recording-screen.${src.file.split('.').pop()}` });
    shots.push(kept);
    const v = await probeVideo(url(src.file), 2.5);
    // MediaRecorder's WebM has no duration in its header: Chromium reports Infinity until it has
    // looked at the end of the file.
    const duration = Number.isFinite(v.duration) ? v.duration : await durationBySeeking(url(src.file));
    screen = { width: v.width, height: v.height, duration, frames: await countFrames(url(src.file)), spread: v.spread, black: !(v.spread > 0.01), bars: await grabFrame(url(src.file), 2.5).then((g) => darkBands(g.px), () => null) };
  }
  let micInfo: RealCapture['mic'] = { skipped: `microphone not requested (no fake devices; devices: ${devices.filter((k) => k === 'audioinput').length} microphones, ${devices.filter((k) => k === 'videoinput').length} cameras)` };
  if (rec!.sources.mic) {
    const sound = await decodeSound(url(rec!.sources.mic.file)).catch(() => null);
    micInfo = sound ? { duration: sound.duration, peak: peak(sound) } : { duration: 0, peak: 0 };
  }
  const log = rec!.cursorFile ? await fetch(url(rec!.cursorFile)).then((r) => r.text()) : '';
  const events = log.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { e: string; x: number; y: number; b?: string });
  const downs = events.filter((e) => e.e === 'd');
  const cursor = { moves: events.filter((e) => e.e === 'm').length, downs: downs.length, buttons: downs.map((d) => d.b).join('') };
  // The driver's own log: where it clicked, as fractions of the primary display.
  const driverLog = await untilAsync(() => invoke<string | null>('smoke:realRecording', { op: 'readSignal', name: 'clicks.json' }), 8000);
  let driver: RealCapture['driver'] = null;
  let shape: RealCapture['shape'] = null;
  let exported: RealCapture['exported'] = null;
  let exportedUrl: string | null = null;
  let shapeMissing: string | undefined;
  if (driverLog) {
    const log = JSON.parse(driverLog) as { screen?: { width: number; height: number }; clicks: { fx: number; fy: number; button: string }[]; shape?: { x?: number; y?: number; size?: number; fx: number; fy: number; fw: number; fh: number; screenColor?: unknown; formVisible?: unknown } };
    const clicks = log.clicks;
    if (log.shape && src) {
      // MediaRecorder's WebM has no index, so a seek may not reach the time asked for: look at
      // several moments and use the first that shows the square.
      let found: SquareFound | null = null;
      const samples: unknown[] = [];
      const cx = log.shape.fx + log.shape.fw / 2;
      const cy = log.shape.fy + log.shape.fh / 2;
      for (const at of [3, 2, 4, 5, 1.5]) {
        try {
          const g = await grabFrame(url(src.file), at);
          const f = findSquare(g.px, { cx, cy, fw: log.shape.fw, fh: log.shape.fh });
          samples.push({ wanted: at, reached: g.reached, rgb: meanColor(g.px, cx, cy), ...(isFound(f) ? {} : { miss: f.reason }) });
          if (isFound(f)) { found = f; break; }
        } catch (e) {
          samples.push({ wanted: at, error: (e as Error).message });
        }
      }
      // Square on screen → square in the picture: width / height of its box in video pixels.
      const ratio = found && screen ? (found.fw * screen.width) / (found.fh * screen.height) : null;
      // A source that kept the wrong frame shape carries the display's shape (displayAspect): the
      // picture is drawn stretched back to it.
      const drawn = ratio === null || !screen ? ratio : src.displayAspect ? ratio * (src.displayAspect / (screen.width / screen.height)) : ratio;
      const r3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
      // Every scale between the driver's square and the video, so a factor of 2 has to show here:
      // the driver works in physical pixels (SetProcessDPIAware, GetSystemMetrics), Electron's display
      // bounds are DIP (× scaleFactor = physical), the video has its own frame size; the comparison
      // itself uses fractions of the screen and of the frame, so none of them enters it directly.
      const b = display!.bounds;
      const scales = {
        driverScreenPx: log.screen ?? null, driverSquarePx: log.shape.size !== undefined ? { x: log.shape.x, y: log.shape.y, size: log.shape.size } : null,
        electronDisplayDip: b ? { w: b.w, h: b.h } : null, electronScaleFactor: display!.scaleFactor ?? 1,
        electronDisplayPx: b ? { w: Math.round(b.w * (display!.scaleFactor ?? 1)), h: Math.round(b.h * (display!.scaleFactor ?? 1)) } : null,
        sourceSettings: { w: src.width, h: src.height }, videoFrame: screen ? { w: screen.width, h: screen.height } : null,
        displayAspect: src.displayAspect ?? null,
        screenToFrame: screen && log.screen ? { x: r3(screen.width / log.screen.width), y: r3(screen.height / log.screen.height) } : null,
        searchWindow: { cx, cy, halfW: log.shape.fw, halfH: log.shape.fh },
      };
      shape = { expected: { fx: log.shape.fx, fy: log.shape.fy, fw: log.shape.fw, fh: log.shape.fh }, found, ratio: r3(ratio), drawn: r3(drawn), driver: { screenColor: log.shape.screenColor, formVisible: log.shape.formVisible }, samples, scales };
      // And in what the user gets: the recording exported as WebM 1080p (Chromium decodes it in
      // every build). A 4:3 screen sits in the 16:9 frame; the square must still be a square.
      const t0 = performance.now();
      const r = await routedExport(project, {}, opened.mediaBase, { variantId: 'v_16x9', format: 'webm', resolution: '1080', fps: 30, quality: 'standard', includeAudio: false }, () => undefined, new AbortController().signal);
      if (r.phase === 'done' && r.path) {
        const exportedSrc = await exportedFrameSource(r.path, opened.mediaBase);
        exportedUrl = exportedSrc.url; // kept until the pictures are made (lookImages), then let go with the page
        let box: SquareFound | null = null;
        const misses: string[] = [];
        let measureError: string | undefined;
        // The 4:3 screen sits centered in the 16:9 frame: the square's middle keeps its place in the
        // screen's height and moves in its width by the pillar.
        const screenShare = (src.displayAspect ?? (screen ? screen.width / screen.height : 16 / 9)) / (16 / 9);
        const near = { cx: 0.5 + (cx - 0.5) * screenShare, cy, fw: log.shape.fw * screenShare, fh: log.shape.fh };
        for (const at of [3, 2, 4]) {
          try {
            const f = findSquare((await grabFrame(exportedSrc.url, at)).px, near);
            if (isFound(f)) { box = f; break; }
            misses.push(`${at} s: ${f.reason}`);
          } catch (e) {
            measureError = (e as Error).message;
            misses.push(`${at} s: ${measureError}`);
          }
        }
        exported = { seconds: Math.round((performance.now() - t0) / 100) / 10, found: box, misses, ratio: box ? Math.round(((box.fw * 1920) / (box.fh * 1080)) * 1000) / 1000 : null, ...(!box && measureError ? { measureError } : {}) };
      } else {
        exported = { error: r.message ?? r.phase };
      }
    }
    if (!log.shape) shapeMissing = 'no square in the driver log';
    else if (!src) shapeMissing = 'no screen file';
    let matched = 0;
    let worst = 0;
    for (const c of clicks) {
      const best = downs.filter((d) => d.b === c.button).map((d) => Math.hypot(d.x - c.fx, d.y - c.fy)).sort((a, b) => a - b)[0];
      if (best !== undefined && best < 0.01) matched++;
      worst = Math.max(worst, best ?? 1);
    }
    driver = { clicks: clicks.length, matched, worstOffset: Math.round(worst * 1e4) / 1e4 };
  } else {
    shapeMissing = 'the click driver\'s log (clicks.json) did not arrive';
  }
  const images = await lookImages(project, opened.mediaBase, src ? url(src.file) : null, exportedUrl, src?.displayAspect);
  const shot = await screenshot('after-real-recording', 500);
  if (shot) shots.push(shot);
  const summary = [
    `backend ${rec!.capture.backend}, click helper ${web?.capabilities.clicks ? 'yes' : 'no'}`,
    screen ? `screen ${screen.width}×${screen.height}, ${screen.duration.toFixed(2)} s, ${screen.frames} frames, spread ${screen.spread.toFixed(3)}${screen.black ? ' (BLACK/BLANK)' : ''}` : 'no screen file',
    `source track ${src?.width}×${src?.height} @${src?.fps} fps, display ${display!.bounds?.w}×${display!.bounds?.h} scale ${display!.scaleFactor ?? 1}`,
    !micInfo ? 'no microphone' : 'skipped' in micInfo ? micInfo.skipped : `microphone ${micInfo.duration.toFixed(2)} s, peak ${micInfo.peak.toFixed(3)}`,
    `cursor ${cursor.moves} positions, ${cursor.downs} clicks (${cursor.buttons || '-'})`,
    driver ? `driver ${driver.clicks} clicks, ${driver.matched} matched (largest offset ${driver.worstOffset})` : 'no click driver log',
  ].join(' · ');
  const source = src ? { width: src.width, height: src.height, fps: src.fps, seconds: src.duration / TICKS_PER_SECOND, ...(src.displayAspect ? { displayAspect: src.displayAspect } : {}) } : null;
  const b = display!.bounds;
  const out: RealCapture = {
    summary, backend: rec!.capture.backend, clicksCapability: !!web?.capabilities.clicks, seconds, screen, source, shape, ...(shapeMissing ? { shapeMissing } : {}), exported,
    frameCheck: (rec!.capture as unknown as { frameCheck?: unknown }).frameCheck ?? null, images,
    display: b ? { w: b.w, h: b.h, scale: display!.scaleFactor ?? 1 } : null, mic: micInfo, cursor, driver,
  };
  expect(screen, `no screen file · ${summary}`);
  expect(Math.abs(screen!.duration - seconds) < 1.5, `screen video ${screen!.duration.toFixed(2)} s, expected ~${seconds} s · ${summary}`);
  expect(screen!.frames >= seconds * 5, `${screen!.frames} frames in the screen video · ${summary}`);
  expect(!screen!.black, `screen recording is black or one color · ${summary}`);
  expect(cursor.moves > 0, `cursor log is empty · ${summary}`);
  if (driver && web?.capabilities.clicks) expect(driver.matched === driver.clicks, `clicks missing from the cursor log or in the wrong place · ${summary}`);
  return out;
}

/** Moment of the recording the pictures show (seconds); the driver's screen shot is taken ~0.5 s in. */
const LOOK_AT = 3;
const LOOK_WIDTH = 320;

/**
 * Four small JPEGs of the real recording for the CI log (RealCapture.images). Never throws: a picture
 * that cannot be made carries its error instead.
 */
async function lookImages(project: Project, mediaBase: string, recorded: string | null, exported: string | null, displayAspect: number | undefined): Promise<RealCapture['images']> {
  const images: RealCapture['images'] = [];
  const add = async (name: string, note: string, make: () => Promise<string | null>): Promise<void> => {
    try {
      const jpeg = await make();
      images.push(jpeg ? { name, note, jpeg } : { name, note, error: 'none' });
    } catch (e) {
      images.push({ name, note, error: e instanceof Error ? e.message : String(e) });
    }
  };
  await add('1-screen', 'full screen taken by the driver with CopyFromScreen (when the square shows, ~0.5 s into the recording)', async () => {
    const raw = await invoke<string | null>('smoke:realRecording', { op: 'readSignal', name: 'screen-shot.json' });
    if (!raw) return null;
    const j = JSON.parse(raw) as { jpeg?: string; error?: string };
    if (j.error) throw new Error(`driver: ${j.error}`);
    return j.jpeg ? `data:image/jpeg;base64,${j.jpeg}` : null;
  });
  await add('2-raw-recording', `the recorded video's frame at ${LOOK_AT} s, as in the file (the file's aspect)`, async () => (recorded ? frameJpeg(recorded, LOOK_AT) : null));
  await add('3-drawn-recording', `the same moment as the app draws it (renderStill, 16:9 scene${displayAspect ? `, displayAspect ${displayAspect.toFixed(4)}` : ''})`, async () => {
    const big = await renderStill(project, {}, mediaBase, secondsToTicks(LOOK_AT), 'v_16x9', { width: LOOK_WIDTH, height: Math.round((LOOK_WIDTH * 9) / 16) });
    return reencode(big);
  });
  await add('4-exported', `the exported WebM's frame at ${LOOK_AT} s`, async () => (exported ? frameJpeg(exported, LOOK_AT) : null));
  return images;
}

/**
 * A URL the page can decode an exported file from: the media protocol serves the project's own
 * exports/; a file in a folder the user picked ("Cambiar…") is read through the test channel
 * (readExport, limited to the test's temporary folders) into a Blob URL.
 */
async function exportedFrameSource(fullPath: string, mediaBase: string): Promise<{ url: string; how: string; release: () => void }> {
  const p = fullPath.replace(/\\/g, '/');
  if (p.includes('/exports/')) return { url: mediaUrl(mediaBase, exportsRel(fullPath)), how: 'media protocol (exports/)', release: () => undefined };
  const bytes = await invoke<Uint8Array>('smoke:realRecording', { op: 'readExport', path: fullPath });
  const type = p.endsWith('.webm') ? 'video/webm' : 'video/mp4';
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  return { url, how: `test channel + Blob URL (${Math.round(bytes.byteLength / 1024)} KB)`, release: () => URL.revokeObjectURL(url) };
}

/** How long a video may take to show its first frame (the CI machine decodes in software). */
const LOAD_MS = 20_000;

/**
 * One decoded frame of a video at `at` seconds (the seek may land near it: MediaRecorder's WebM has
 * no index), as pixels in the video's own size. Throws with the browser's reason (media error,
 * ready and network state, time waited), so a measurement that could not read a frame says why.
 */
async function grabFrame(src: string, at: number): Promise<{ px: Pixels; reached: number; canvas: HTMLCanvasElement }> {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous'; // the media protocol answers with CORS; without it the canvas is tainted
  const t0 = performance.now();
  const release = () => { v.removeAttribute('src'); v.load(); };
  const state = () => `readyState ${v.readyState}, networkState ${v.networkState}, ${Math.round(performance.now() - t0)} ms · …${decodeURIComponent(src).slice(-60)}`;
  v.src = src;
  const failed = await new Promise<string | null>((res) => {
    v.onloadeddata = () => res(null);
    v.onerror = () => res(`could not open: error ${v.error?.code ?? '?'} ${v.error?.message ?? ''}`.trim());
    setTimeout(() => res(`no first frame within ${LOAD_MS / 1000} s`), LOAD_MS);
  });
  if (failed) { const why = `${failed} (${state()})`; release(); throw new Error(why); }
  v.currentTime = at;
  const seek = await new Promise<string | null>((res) => { v.onseeked = () => res(null); v.onerror = () => res(`error while seeking ${v.error?.code ?? '?'}`); setTimeout(() => res(null), 5000); });
  if (seek) { const why = `${seek} (${state()})`; release(); throw new Error(why); }
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  if (!c.width || !c.height) { const why = `frame size 0 (${state()})`; release(); throw new Error(why); }
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(v, 0, 0);
  const reached = Math.round(v.currentTime * 100) / 100;
  const data = g.getImageData(0, 0, c.width, c.height).data;
  release();
  return { px: { data, width: c.width, height: c.height }, reached, canvas: c };
}

/** A frame of a video at `at` seconds, LOOK_WIDTH wide in the video's shape, JPEG q 0.6. */
async function frameJpeg(src: string, at: number): Promise<string> {
  const { canvas } = await grabFrame(src, at);
  const c = document.createElement('canvas');
  c.width = LOOK_WIDTH;
  c.height = Math.max(1, Math.round((LOOK_WIDTH * canvas.height) / canvas.width));
  c.getContext('2d')!.drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.6);
}

/** A JPEG data URL again at quality 0.6 (renderStill writes 0.8). */
async function reencode(dataUrl: string): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return c.toDataURL('image/jpeg', 0.6);
}

/** Duration of a video whose header has none: seek far past the end, then read it. */
async function durationBySeeking(src: string): Promise<number> {
  const v = document.createElement('video');
  v.muted = true;
  v.src = src;
  await new Promise<void>((res) => { v.onloadedmetadata = () => res(); v.onerror = () => res(); setTimeout(res, 8000); });
  v.currentTime = 1e7;
  await new Promise<void>((res) => { v.ondurationchange = () => { if (Number.isFinite(v.duration)) res(); }; v.onseeked = () => res(); setTimeout(res, 8000); });
  const d = v.duration;
  v.removeAttribute('src');
  v.load();
  return d;
}

/** `until` for a check that has to ask the main process. */
async function untilAsync<T>(fn: () => Promise<T | null | undefined | false>, ms: number): Promise<T | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return null;
}

/** Frames a video shows when played through once (requestVideoFrameCallback). */
async function countFrames(src: string): Promise<number> {
  const v = document.createElement('video');
  v.muted = true;
  v.src = src;
  let frames = 0;
  const tick = (_n: number, m: VideoFrameCallbackMetadata) => { frames = Math.max(frames, m.presentedFrames); if (!v.ended) v.requestVideoFrameCallback(tick); };
  v.requestVideoFrameCallback(tick);
  await v.play().catch(() => undefined);
  await new Promise<void>((res) => { v.onended = () => res(); v.onerror = () => res(); setTimeout(res, 20_000); });
  v.removeAttribute('src');
  v.load();
  return frames;
}

/**
 * How close a decoded frame of an export is to the picture the editor draws for that moment
 * (renderStill, the export's own compositor): PSNR and mean colour difference (a wrong RGB → YUV
 * conversion shows as a colour shift), and how much fine detail (text edges) it keeps. Both at
 * 960×540; the reference is a JPEG at quality 0.8, so a perfect export does not reach 99 dB.
 */
async function pictureQuality(store: EditorStore, url: string, at: number): Promise<{ psnr: number; meanDiff: [number, number, number]; sharpnessRatio: number; at: number }> {
  const W = 960;
  const H = 540;
  const pixels = async (src: CanvasImageSource): Promise<Uint8ClampedArray> => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(src, 0, 0, W, H);
    return g.getImageData(0, 0, W, H).data;
  };
  const v = document.createElement('video');
  v.muted = true;
  v.crossOrigin = 'anonymous';
  v.src = url;
  await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error('video did not open')); setTimeout(() => rej(new Error('timeout')), 8000); });
  v.currentTime = at;
  await new Promise<void>((res) => { v.onseeked = () => res(); setTimeout(res, 5000); });
  // The frame on screen starts at a multiple of 1/30 s; the reference is drawn for that moment.
  const shown = Math.floor(v.currentTime * 30 + 1e-6) / 30;
  const decoded = await pixels(v);
  v.removeAttribute('src');
  v.load();
  // A Chromium without a decoder for this file (the package's, without a graphics card) hands out a
  // black frame: that is no measurement of the file.
  let sum = 0;
  for (let i = 0; i < decoded.length; i += 4) sum += decoded[i]! + decoded[i + 1]! + decoded[i + 2]!;
  if (sum / (decoded.length / 4) / 3 < 4 && sharpness(decoded, W, H) === 0) throw new Error('Chromium could not decode a frame of this file (black frame); the file was checked with the system probe');
  const s = store.getState();
  const jpeg = await renderStill(store.project, s.cursors, s.mediaBase, secondsToTicks(shown), 'v_16x9', { width: W, height: H });
  const img = new Image();
  img.src = jpeg;
  await img.decode();
  const reference = await pixels(img);
  const { psnr, meanDiff } = compareFrames(decoded, reference);
  const ref = sharpness(reference, W, H);
  return { psnr: Math.round(psnr * 10) / 10, meanDiff: meanDiff.map((x) => Math.round(x * 10) / 10) as [number, number, number], sharpnessRatio: ref ? Math.round((sharpness(decoded, W, H) / ref) * 100) / 100 : 0, at: Math.round(shown * 1000) / 1000 };
}

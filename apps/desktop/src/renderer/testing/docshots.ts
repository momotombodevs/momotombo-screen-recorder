/**
 * README pictures (`pnpm docshots`). Opens the sample project (a made-up settings screen,
 * "Example App" / "Alex Example" in English, "App de ejemplo" / "Daniela Ejemplo" in Spanish, an
 * abstract camera picture) in the real editor and takes a picture of each main screen, then
 * renders a short demo GIF with the export compositor. scripts/run-suite.mjs copies `shots`
 * to docs/screenshots/.
 *
 * English interface first (the README is English first); the same set in Spanish gets a
 * "-es" suffix. The run uses the temporary projects folder of the test mode, so the project
 * list holds the sample only, and a stand-in home folder, so the export window's "Save to"
 * line reads "~/Movies/Momotombo". Before each picture the visible text is checked for anything
 * that would give away the machine or its user (a home folder, the projects folder, a
 * temporary folder).
 */
import { Compositor } from '@momotombo/compositor';
import { addMagnifier, addPrivacy, evaluate, layoutSegments, sequenceDuration, timelineToSource, type Project } from '@momotombo/project-model';
import { secondsToTicks, TICKS_PER_SECOND } from '@momotombo/timing';
import { DIST } from '../../shared/distribution';
import { api } from '../api';
import { ExportMedia } from '../export/exporter';
import { t } from '../i18n';
import { synthesizeRecording, type FixtureLang } from '../smoke-fixtures';
import { GifWriter, medianCutPalette } from './gif';
import { all, button, click, createSampleProject, currentEditor, invoke, option, q, sleep, text, until, type Check, type OpenEditor, type SampleProject } from './harness';

/** File names are fixed: the README links to them. The Spanish set adds "-es". */
export const DOC_SHOTS = ['hero', 'project-list', 'editor', 'zoom-selected', 'privacy-area', 'vertical-9x16', 'export'] as const;
type ShotName = (typeof DOC_SHOTS)[number];
export const DEMO_GIF = 'demo';

/** Width of the saved pictures in pixels (the window is 1440 points wide). */
const SHOT_WIDTH = 1600;
/** The demo: timeline seconds [start, end) at this size and frame rate. */
const DEMO = { start: 0.3, end: 7.6, fps: 10, width: 720, height: 405, dither: 8 };

const PROJECT_NAME: Record<FixtureLang, string> = { en: 'Account settings tour', es: 'Recorrido por la configuración de la cuenta' };

export async function runDocShots(): Promise<unknown> {
  const checks: Check[] = [];
  const shots: string[] = [];
  const info = await api.appInfo();
  // Text that must never be on a published picture.
  const forbidden = [info.projectsRoot, '/Users/', '/home/', '/private/', '/var/folders/', '/tmp/', 'momotombo-smoke', 'momotombo-docs', 'C:\\Users\\', 'AppData'].filter(Boolean);
  const expect = (cond: unknown, message: string): void => { if (!cond) throw new Error(message); };
  const step = async (name: string, fn: () => Promise<string | void>): Promise<boolean> => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
      return true;
    } catch (e) {
      checks.push({ name, ok: false, detail: (e as Error).message });
      return false;
    }
  };
  const done = () => ({ suite: 'docs', ok: checks.every((c) => c.ok) && shots.length === DOC_SHOTS.length * 2 + 1, checks, shots, dist: DIST });

  expect(info.suite === 'docs' && info.smoke, 'documentation screenshots run only in --docshots mode');
  await step('Test mode uses the temporary projects folder', async () => {
    expect(/momotombo-smoke-/.test(info.projectsRoot), 'the projects folder is not a temporary folder');
  });
  const folder = await invoke<string | null>('smoke:docsExportFolder');
  await step('Export folder is a neutral sample folder', async () => {
    expect(folder === '~/Movies/Momotombo', `save location "${folder ?? 'could not be set'}"`);
    return folder!;
  });

  for (const lang of ['en', 'es'] as const) {
    const suffix = lang === 'en' ? '' : '-es';
    const sample = await set(lang, suffix);
    if (!sample) return done();
    if (lang === 'en') {
      const ed = currentEditor(sample.id);
      const ok = ed && await step('Demo recording (GIF): from the compositor, automatic zoom moves in on the click', () => demoGif(ed));
      if (!ok) return done();
    }
    // The next language starts from an empty list again.
    click(button(t("Volver a proyectos")), 'Back to projects');
    await until(() => q('.project-card'), 8000);
    await api.trashProject(sample.id);
  }
  return done();

  /** One full set of pictures with the interface and the sample's content in `lang`. */
  async function set(lang: FixtureLang, suffix: string): Promise<SampleProject | null> {
    const L = lang === 'en' ? 'English' : 'Spanish';
    await api.setLanguage(lang);
    await until(() => document.documentElement.lang === lang, 3000);

    const shoot = async (name: ShotName): Promise<string> => {
      // "Saving…" in the top bar would date the picture: wait for the save to finish.
      const open = currentEditor();
      if (open) expect(await until(() => open.store.getState().save === 'saved', 8000), 'project not saved');
      await sleep(900); // transitions, thumbnails and the preview settle
      const visible = document.body.innerText;
      const leak = forbidden.find((f) => visible.includes(f));
      expect(!leak, `the picture has possibly personal text: ${leak}`);
      expect(document.documentElement.lang === lang, `interface language ${document.documentElement.lang}`);
      const r = await invoke<{ file: string; width: number; height: number } | null>('smoke:shot', { name: `${name}${suffix}`, width: SHOT_WIDTH });
      expect(r, 'screenshot failed');
      shots.push(r!.file);
      return `${name}${suffix}.png ${r!.width}×${r!.height}`;
    };

    const sample = await createSampleProject(8, PROJECT_NAME[lang], (s) => synthesizeRecording(s, lang, 'character'));
    const name = PROJECT_NAME[lang];

    // The list shows a thumbnail once the editor has saved one, so the project is opened first.
    const ready = await step(`${L}: sample project opened, automatic zoom suggestions created`, async () => {
      click(button(t("Actualizar")), 'Refresh button');
      const card = await until(() => all('.project-card').find((c) => text(q('.project-meta strong', c)) === name), 8000);
      expect(card, 'sample project not in the list');
      click(q('.project-thumb', card!), 'project card');
      const ed = await until(() => (q('.editor') ? currentEditor(sample.id) : null), 10_000);
      expect(ed, 'editor did not open');
      expect(await until(() => ed!.store.project.zooms.length > 0, 12_000), 'no suggestions created');
      expect(await until(() => ed!.store.getState().save === 'saved', 8000), 'project not saved');
      return `${ed!.store.project.zooms.length} suggestions`;
    });
    if (!ready) return null;

    await step(`${L}: project list, only the sample project, with its thumbnail`, async () => {
      click(button(t("Volver a proyectos")), 'Back to projects');
      const card = await until(() => all('.project-card').find((c) => text(q('.project-meta strong', c)) === name && q('.project-thumb img', c)), 10_000);
      expect(card, 'sample project with thumbnail not in the list');
      const names = all('.project-card').map((c) => text(q('.project-meta strong', c)));
      expect(names.length === 1, `the list has ${names.length} projects: ${names.join(', ')}`);
      return shoot('project-list');
    });

    const ed = await (async () => {
      const card = all('.project-card').find((c) => text(q('.project-meta strong', c)) === name);
      if (card) click(q('.project-thumb', card), 'project card');
      return until(() => (q('.editor') ? currentEditor(sample.id) : null), 10_000);
    })();
    if (!ed) { checks.push({ name: `${L}: editor reopened`, ok: false }); return null; }
    const { store } = ed;
    const zooms = () => [...store.project.zooms].sort((a, b) => a.start - b.start);
    const middle = (z: { start: number; end: number }) => z.start + Math.round((z.end - z.start) / 2);

    await step(`${L}: editor, zoom suggestions on the timeline`, async () => {
      store.select(null);
      store.setPlayhead(middle(zooms()[0]!));
      expect(await until(() => all('.tl-item.tl-zoom').length === store.project.zooms.length, 3000), 'zooms not shown on the timeline');
      return shoot('editor');
    });

    await step(`${L}: zoom selected, its settings in the right panel`, async () => {
      click(all('.tl-item.tl-zoom')[0] ?? null, 'first zoom on the timeline');
      expect(await until(() => store.getState().selection?.kind === 'zoom', 3000), 'zoom not selected');
      store.setPlayhead(middle(zooms()[0]!));
      return shoot('zoom-selected');
    });

    await step(`${L}: privacy area, phone number covered with frosted glass`, async () => {
      const id = addSampleEdits(ed, sample);
      store.select({ kind: 'privacy', id });
      store.setPlayhead(secondsToTicks(3.8));
      expect(await until(() => q('.tl-item.tl-privacy') && q('.tl-item.tl-magnifier') && store.getState().selection?.kind === 'privacy', 3000), 'privacy area or magnifier missing from the timeline');
      return shoot('privacy-area');
    });

    // The hero picture: the whole editor at a moment where a zoom is on, the privacy area
    // covers the phone number and the camera bubble sits in its corner; every track has items.
    await step(`${L}: hero picture, zoom active, privacy area and magnifier on the timeline`, async () => {
      store.select(null);
      const at = secondsToTicks(3.9);
      const z = store.project.zooms.find((x) => x.start <= at && at < x.end);
      expect(z, 'no active zoom at 3.9 s');
      store.setPlayhead(at);
      await sleep(400);
      return shoot('hero');
    });

    await step(`${L}: vertical format (9:16)`, async () => {
      store.select(null);
      click(option(t("Formato de video"), '9:16'), '9:16 format');
      expect(await until(() => store.project.activeVariantId === 'v_9x16', 3000), '9:16 not selected');
      store.setPlayhead(secondsToTicks(1.2));
      const detail = await shoot('vertical-9x16');
      click(option(t("Formato de video"), '16:9'), '16:9 format');
      expect(await until(() => store.project.activeVariantId === 'v_16x9', 3000), 'did not return to 16:9');
      return detail;
    });

    await step(`${L}: export window, save location and encoder visible`, async () => {
      store.setPlayhead(middle(zooms()[0]!));
      click(button(t("Exportar"), q('.topbar-right')!), 'Export in the top bar');
      const dialog = await until(() => q('.export-modal'), 3000);
      expect(dialog, 'export window did not open');
      // The privacy check pictures are drawn in the background; encoder and target arrive by IPC.
      expect(await until(() => all('.privacy-check figure').length > 0 && all('.privacy-check .thumb-wait').length === 0, 10_000), 'privacy check frames not drawn');
      expect(await until(() => q('.export-encoder', dialog!), 10_000), 'encoder line not shown');
      expect(await until(() => text(q('.export-target', dialog!)).includes('~/Movies/Momotombo'), 5000), `save location: "${text(q('.export-target', dialog!))}"`);
      const detail = await shoot('export');
      const encoder = text(q('.export-encoder', dialog!));
      click(button(t("Cerrar"), dialog!), 'close the window');
      expect(await until(() => !q('.export-modal'), 3000), 'window did not close');
      return `${detail} · ${encoder}`;
    });
    return sample;
  }

  /** The privacy area over the made-up phone number and a magnifier range; returns the privacy id. */
  function addSampleEdits(ed: OpenEditor, sample: SampleProject): string {
    const { store } = ed;
    const rec = sample.recording!;
    const at = secondsToTicks(3);
    const pos = timelineToSource(store.project, at, layoutSegments(store.project));
    expect(pos, 'the timeline has no second 3');
    let id = '';
    store.apply((p) => {
      const r = addPrivacy(p, {
        recordingId: pos!.recordingId, start: at, end: secondsToTicks(5.5), origin: 'manual',
        region: rec.secretRegion, keyframes: [], effect: { kind: 'frosted' }, cornerRadius: 0.12, padFrames: 2,
      });
      id = r.id;
      // The magnifier over the pointer resting on the sidebar after its last click (6.6–7.6 s).
      return addMagnifier(r.project, { recordingId: pos!.recordingId, start: secondsToTicks(6.6), end: secondsToTicks(7.6), origin: 'manual', size: 280, zoom: 2 }).project;
    });
    return id;
  }

  /**
   * The demo: timeline frames drawn by the export compositor (the same path as an exported
   * file), written as a looping GIF with our own encoder, then read back with the browser's
   * own GIF decoder to check frame count and picture.
   */
  async function demoGif(ed: OpenEditor): Promise<string> {
    const { store } = ed;
    const project: Project = store.project;
    const { cursors, mediaBase } = store.getState();
    expect(sequenceDuration(project) / TICKS_PER_SECOND >= DEMO.end, 'sample project too short for the demo');
    const zoomsInDemo = project.zooms.filter((z) => z.start < secondsToTicks(DEMO.end) && z.end > secondsToTicks(DEMO.start));
    expect(zoomsInDemo.length >= 2, `${zoomsInDemo.length} zooms in the demo range`);

    const gl = document.createElement('canvas');
    const comp = new Compositor(gl, { preserveDrawingBuffer: true });
    const media = new ExportMedia(mediaBase);
    const flat = document.createElement('canvas');
    flat.width = DEMO.width;
    flat.height = DEMO.height;
    const g = flat.getContext('2d', { willReadFrequently: true })!;
    const frames: Uint8ClampedArray[] = [];
    const t0 = performance.now();
    try {
      const n = Math.round((DEMO.end - DEMO.start) * DEMO.fps);
      for (let i = 0; i < n; i++) {
        const at = secondsToTicks(DEMO.start + i / DEMO.fps);
        const plan = evaluate(project, at, { variantId: 'v_16x9', cursors, size: { width: DEMO.width, height: DEMO.height } });
        const rec = plan.recordingId ? project.recordings[plan.recordingId] : undefined;
        const screen = rec?.sources.screen && plan.screen ? await media.frameAt(rec.sources.screen.file, plan.screen.mediaTime / TICKS_PER_SECOND) : null;
        const camera = rec?.sources.camera && plan.camera ? await media.frameAt(rec.sources.camera.file, plan.camera.mediaTime / TICKS_PER_SECOND) : null;
        comp.render(plan, {
          screen, screenSize: screen ? { width: screen.videoWidth, height: screen.videoHeight } : undefined,
          camera, cameraSize: camera ? { width: camera.videoWidth, height: camera.videoHeight } : undefined,
        });
        expect(!comp.lost, 'WebGL context lost');
        g.drawImage(gl, 0, 0, DEMO.width, DEMO.height);
        frames.push(g.getImageData(0, 0, DEMO.width, DEMO.height).data);
      }
    } finally {
      comp.dispose();
      media.dispose();
    }
    const renderMs = performance.now() - t0;

    const palette = medianCutPalette(frames, 255, 5);
    // Ordered dithering against banding in the backdrop's soft gradient (gif.ts).
    const gif = new GifWriter({ width: DEMO.width, height: DEMO.height, palette, loop: 0, dither: DEMO.dither });
    const delay = Math.round(100 / DEMO.fps);
    frames.forEach((f, i) => gif.addFrame(f, i === frames.length - 1 ? 150 : delay));
    const bytes = gif.finish();
    expect(bytes.length < 1024 * 1024, `GIF ${(bytes.length / 1024 / 1024).toFixed(2)} MB (limit 1 MB)`);

    // Read back with Chromium's decoder (WebCodecs ImageDecoder): frame count and pictures.
    const dec = new ImageDecoder({ data: bytes, type: 'image/gif' });
    await dec.tracks.ready;
    const count = dec.tracks.selectedTrack?.frameCount ?? 0;
    expect(count === frames.length, `the browser read ${count} frames, ${frames.length} written`);
    let worst = 0;
    for (const i of [0, Math.floor(frames.length / 3), Math.floor(frames.length / 2), frames.length - 1]) {
      const { image } = await dec.decode({ frameIndex: i });
      g.drawImage(image, 0, 0);
      image.close();
      const back = g.getImageData(0, 0, DEMO.width, DEMO.height).data;
      const src = frames[i]!;
      let sum = 0;
      // Compared in 4×4 blocks: the dither pattern averages out there, as it does for the eye.
      let blocks = 0;
      for (let by = 0; by + 4 <= DEMO.height; by += 4) {
        for (let bx = 0; bx + 4 <= DEMO.width; bx += 4) {
          for (let c = 0; c < 3; c++) {
            let a = 0;
            let b = 0;
            for (let y = by; y < by + 4; y++) for (let x = bx; x < bx + 4; x++) { const k = (y * DEMO.width + x) * 4 + c; a += src[k]!; b += back[k]!; }
            sum += Math.abs(a - b) / 16;
          }
          blocks++;
        }
      }
      worst = Math.max(worst, sum / blocks / 3);
    }
    dec.close();
    // A 255-colour palette without dithering stays within a few levels on average.
    expect(worst < 4, `the frame read back differs by ${worst.toFixed(1)} levels on average per 4×4 block`);

    const r = await invoke<{ file: string; bytes: number }>('smoke:saveShot', { name: DEMO_GIF, ext: 'gif', data: bytes });
    shots.push(r.file);
    return `${DEMO_GIF}.gif ${DEMO.width}×${DEMO.height}, ${frames.length} frames, ${DEMO.fps} fps, ${(bytes.length / 1024 / 1024).toFixed(2)} MB, ${palette.length} colors, dither ${DEMO.dither}, ${zoomsInDemo.length} zooms; rendering ${(renderMs / 1000).toFixed(1)} s; browser read-back difference ${worst.toFixed(2)}`;
  }
}

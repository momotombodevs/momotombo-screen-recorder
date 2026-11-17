/**
 * Performance test (`pnpm perftest`). Runs the real editor on sample recordings and measures
 * what a user feels: how long automatic zoom takes, how evenly the preview plays through zooms,
 * how fast the playhead answers when it is moved, and how long an export takes. Each number
 * comes with CPU use and totals, so two runs (before / after a change) can be compared.
 *
 * Two sample recordings with the same made-up content:
 *   - "browser recording": recorded in real time with MediaRecorder (WebM without duration or seek
 *     index, few frames while the picture stands still), like the Chromium recording path;
 *   - "regular file": 30 fps files written by our own muxer, like the macOS recorder's.
 */
import { parseCursorLog, presetTransition, sequenceDuration, type CursorTrack } from '@momotombo/project-model';
import { TICKS_PER_SECOND, secondsToTicks } from '@momotombo/timing';
import { suggestZooms } from '@momotombo/zoom-engine';
import { PROFILE, DIST } from '../../shared/distribution';
import type { ExportOptions } from '../export/exporter';
import { probe } from '../perf-probe';
import { regenerateZoomSuggestions } from '../screens/editor/zoom-actions';
import { recordLikeBrowser, synthesizeRecording } from '../smoke-fixtures';
import { api } from '../api';
import { cpuNow, cpuPercent, createSampleProject, exportsRel, frame, invoke, openInEditor, routedExport, sleep, stats, until, type Check, type OpenEditor, type SampleProject } from './harness';

/** One measured number. `better` says which direction is an improvement, for comparisons. */
export interface Metric { name: string; value: number; unit: string; better?: 'lower' | 'higher' }
export interface Scenario { name: string; metrics: Metric[]; note?: string }

const m = (name: string, value: number, unit: string, better?: 'lower' | 'higher'): Metric => ({ name, value: Math.round(value * 100) / 100, unit, ...(better ? { better } : {}) });

// ─── Automatic zoom ───────────────────────────────────────────────────────────

/** One hour of pointer samples with a click every 4 s: the zoom engine alone. */
async function zoomEngineScenario(): Promise<Scenario> {
  const track: CursorTrack = { samples: [], clicks: [], scrolls: [] };
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let x = 0.5;
  let y = 0.5;
  for (let i = 0; i < 3600 * 60; i++) {
    const s = i / 60;
    if (i % 240 === 0) {
      x = 0.05 + rnd() * 0.9;
      y = 0.05 + rnd() * 0.9;
      track.clicks.push({ t: secondsToTicks(s), x, y, button: 'left', kind: 'down' });
      track.clicks.push({ t: secondsToTicks(s + 0.09), x, y, button: 'left', kind: 'up' });
    }
    track.samples.push({ t: secondsToTicks(s), x, y });
  }
  const times: number[] = [];
  let count = 0;
  const c0 = await cpuNow();
  const all0 = performance.now();
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    count = suggestZooms({ recordingId: 'r', duration: secondsToTicks(3600), track, hasClicks: true, sensitivity: 'medium', defaults: { scale: 1.8, enter: presetTransition('smooth'), exit: presetTransition('smooth') } }).length;
    times.push(performance.now() - t0);
  }
  const total = performance.now() - all0;
  const c1 = await cpuNow();
  const st = stats(times);
  return {
    name: 'Automatic zoom · engine (1-hour cursor log, 900 clicks)',
    note: '5 runs',
    metrics: [
      m('suggestion time (median)', st.p50, 'ms', 'lower'), m('suggestion time (max)', st.max, 'ms', 'lower'), m('suggestions', count, 'count'),
      m('total time (5 runs)', total, 'ms', 'lower'), m('CPU', cpuPercent(c0, c1), '% core', 'lower'),
    ],
  };
}

/** "Zoom automático" in the open editor: read the log, run the engine, apply, redraw. */
async function zoomInEditorScenario(ed: OpenEditor, label: string): Promise<Scenario> {
  const times: number[] = [];
  let count = 0;
  // Frame intervals while it runs: a long one is a stall the user sees in the editor.
  const intervals: number[] = [];
  let last = 0;
  let running = true;
  const tick = (ts: number) => {
    if (!running) return;
    if (last) intervals.push(ts - last);
    last = ts;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  await frame();
  const c0 = await cpuNow();
  const all0 = performance.now();
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    count = await regenerateZoomSuggestions(ed.store);
    await frame();
    await frame();
    times.push(performance.now() - t0);
  }
  const total = performance.now() - all0;
  const c1 = await cpuNow();
  running = false;
  const st = stats(times);
  const iv = stats(intervals);
  return {
    name: `Automatic zoom · in the editor (${label})`,
    note: '5 runs',
    metrics: [
      m('re-suggest + draw (median)', st.p50, 'ms', 'lower'), m('re-suggest + draw (max)', st.max, 'ms', 'lower'), m('suggestions', count, 'count'),
      m('frame time (median)', iv.p50, 'ms', 'lower'), m('frame time (max)', iv.max, 'ms', 'lower'),
      m('total time (5 runs)', total, 'ms', 'lower'), m('CPU', cpuPercent(c0, c1), '% core', 'lower'),
    ],
  };
}

// ─── Playback through zooms ───────────────────────────────────────────────────

async function playbackScenario(ed: OpenEditor, sample: SampleProject, label: string, checks: Check[]): Promise<Scenario> {
  const { store, player } = ed;
  const media = player.elementsFor(sample.recordingId);
  const screen = media?.screen;
  store.setPlayhead(0);
  await sleep(800);
  const seeks: Record<string, number> = { screen: 0, camera: 0, mic: 0 };
  let stalls = 0;
  const onStall = () => { stalls++; };
  const watched = (['screen', 'camera', 'mic'] as const).flatMap((kind) => {
    const el = media?.[kind];
    if (!el) return [];
    const onSeek = () => { seeks[kind]!++; };
    el.addEventListener('seeking', onSeek);
    el.addEventListener('waiting', onStall);
    return [{ el, onSeek }];
  });
  const intervals: number[] = [];
  const drift: number[] = [];
  let last = 0;
  let running = true;
  const tick = (ts: number) => {
    if (!running) return;
    if (last) intervals.push(ts - last);
    last = ts;
    // The sample is one uncut recording starting at 0, so media time equals timeline time.
    if (screen && store.getState().playing) drift.push(Math.abs(screen.currentTime - store.getState().playhead / TICKS_PER_SECOND) * 1000);
    requestAnimationFrame(tick);
  };
  const q0 = screen?.getVideoPlaybackQuality();
  probe.start();
  const c0 = await cpuNow();
  const t0 = performance.now();
  player.play();
  requestAnimationFrame(tick);
  const ended = await until(() => !store.getState().playing, 60_000, 50);
  const wall = performance.now() - t0;
  const length = sequenceDuration(store.project) / TICKS_PER_SECOND;
  checks.push({ name: `Preview played to the end (${label})`, ok: !!ended && wall / 1000 > length * 0.9, detail: `${length.toFixed(2)} s timeline played in ${(wall / 1000).toFixed(2)} s` });
  running = false;
  const c1 = await cpuNow();
  const pr = probe.stop();
  const q1 = screen?.getVideoPlaybackQuality();
  for (const w of watched) {
    w.el.removeEventListener('seeking', w.onSeek);
    w.el.removeEventListener('waiting', onStall);
  }
  const iv = stats(intervals);
  const refresh = iv.p50 || 16.67;
  const long = intervals.filter((v) => v > refresh * 1.5).length;
  const draw = stats(pr.series['preview-draw'] ?? []);
  const dr = stats(drift);
  return {
    name: `Preview playback · with zooms (${label})`,
    note: `display refresh interval ≈ ${refresh.toFixed(1)} ms`,
    metrics: [
      m('playback time', wall / 1000, 's'),
      m('frame interval (median)', iv.p50, 'ms', 'lower'),
      m('frame interval (p95)', iv.p95, 'ms', 'lower'),
      m('frame interval (max)', iv.max, 'ms', 'lower'),
      m('late frames (>1.5× interval)', long, 'count', 'lower'),
      m('preview draw (median)', draw.p50, 'ms', 'lower'),
      m('preview draw (p95)', draw.p95, 'ms', 'lower'),
      m('seeks: screen', seeks.screen!, 'count', 'lower'),
      m('seeks: camera', seeks.camera!, 'count', 'lower'),
      m('seeks: audio', seeks.mic!, 'count', 'lower'),
      m('playback stalls', stalls, 'count', 'lower'),
      m('picture–clock drift (median)', dr.p50, 'ms', 'lower'),
      m('picture–clock drift (p95)', dr.p95, 'ms', 'lower'),
      m('dropped video frames', (q1?.droppedVideoFrames ?? 0) - (q0?.droppedVideoFrames ?? 0), 'count', 'lower'),
      m('React renders: Editor', pr.counts['react:Editor'] ?? 0, 'count', 'lower'),
      m('React renders: Timeline', pr.counts['react:Timeline'] ?? 0, 'count', 'lower'),
      m('React renders: Inspector', pr.counts['react:Inspector'] ?? 0, 'count', 'lower'),
      m('CPU', cpuPercent(c0, c1), '% core', 'lower'),
    ],
  };
}

/** Moving the playhead (paused): time until the picture of the new moment is on screen. */
async function scrubScenario(ed: OpenEditor, sample: SampleProject, label: string): Promise<Scenario> {
  const { store, player } = ed;
  const screen = player.elementsFor(sample.recordingId)?.screen;
  const duration = sequenceDuration(store.project) / TICKS_PER_SECOND;
  const times: number[] = [];
  let missed = 0;
  const c0 = await cpuNow();
  for (let i = 0; i < 24; i++) {
    // Forward steps, then jumps back and forth, like dragging and clicking on the timeline.
    const sec = i < 12 ? 0.3 + (i * (duration - 0.6)) / 12 : (i % 2 ? 0.15 : 0.85) * duration - (i - 12) * 0.05;
    const t0 = performance.now();
    store.setPlayhead(secondsToTicks(sec));
    const ok = await until(() => !!screen && !screen.seeking && Math.abs(screen.currentTime - sec) < 0.05, 5000, 4);
    await frame();
    if (ok) times.push(performance.now() - t0);
    else missed++;
  }
  const c1 = await cpuNow();
  const st = stats(times);
  return {
    name: `Moving the playhead (${label})`,
    metrics: [
      m('new moment on screen (median)', st.p50, 'ms', 'lower'), m('new moment on screen (p95)', st.p95, 'ms', 'lower'), m('new moment on screen (max)', st.max, 'ms', 'lower'),
      m('not shown within 5 s', missed, 'count', 'lower'), m('CPU', cpuPercent(c0, c1), '% core', 'lower'),
    ],
  };
}

// ─── Export ───────────────────────────────────────────────────────────────────

async function exportScenario(ed: OpenEditor, label: string, o: Pick<ExportOptions, 'format' | 'resolution' | 'fps'>, checks: Check[]): Promise<Scenario> {
  const { store } = ed;
  const seconds = sequenceDuration(store.project) / TICKS_PER_SECOND;
  const name = `Export · ${o.format.toUpperCase()} ${o.resolution === '2160' ? '4K' : '1080p'}${o.fps} (${label})`;
  probe.start();
  const c0 = await cpuNow();
  const t0 = performance.now();
  const result = await routedExport(store.project, store.getState().cursors, store.getState().mediaBase, {
    variantId: 'v_16x9', quality: 'high', includeAudio: true, ...o,
  }, () => undefined, new AbortController().signal);
  const wall = (performance.now() - t0) / 1000;
  const c1 = await cpuNow();
  const pr = probe.stop();
  // The written file must open and have the timeline's length.
  let played = Number.NaN;
  if (result.phase === 'done' && result.path) {
    const rel = exportsRel(result.path);
    const v = document.createElement('video');
    v.muted = true;
    v.src = store.getState().mediaBase + rel.split('/').map(encodeURIComponent).join('/');
    await new Promise<void>((res) => { v.onloadedmetadata = () => res(); v.onerror = () => res(); setTimeout(res, 8000); });
    played = v.duration;
    v.removeAttribute('src');
    v.load();
  }
  const ok = result.phase === 'done' && Math.abs(played - seconds) < 0.25;
  checks.push({ name, ok, detail: ok ? `${result.encoder}, ${played.toFixed(2)} s` : `${result.phase}: ${result.message ?? `file duration ${played} s, expected ${seconds.toFixed(2)} s`}` });
  const per = stats(pr.series['export-frame'] ?? []);
  const src = stats(pr.series['export-source'] ?? []);
  const draw = stats(pr.series['export-draw'] ?? []);
  const enc = stats(pr.series['export-encode-wait'] ?? []);
  return {
    name,
    note: result.encoder,
    metrics: [
      m('total time', wall, 's', 'lower'),
      m('speed', result.total / wall, 'fps', 'higher'),
      m('ratio to real time', seconds / wall, '×', 'higher'),
      m('frame time (median)', per.p50, 'ms', 'lower'),
      m('frame time (p95)', per.p95, 'ms', 'lower'),
      m('frame time (max)', per.max, 'ms', 'lower'),
      m('fetching the source frame (mean)', src.mean, 'ms', 'lower'),
      m('drawing (mean)', draw.mean, 'ms', 'lower'),
      m('waiting for the encoder (mean)', enc.mean, 'ms', 'lower'),
      m('CPU', cpuPercent(c0, c1), '% core', 'lower'),
      m('CPU time', c1.seconds - c0.seconds, 's', 'lower'),
      m('file size', (result.bytes ?? 0) / 1024 / 1024, 'MB'),
    ],
  };
}

async function realSample(): Promise<SampleProject | null> {
  const { id } = await api.createProject('Performance test (real recording)');
  const r = await invoke<{ recordingId: string } | null>('smoke:realRecording', { projectId: id });
  return r ? { id, recordingId: r.recordingId, screenFile: '', recording: null } : null;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

export async function runPerfTests(): Promise<unknown> {
  const checks: Check[] = [];
  const scenarios: Scenario[] = [];
  const started = performance.now();
  const gl = document.createElement('canvas').getContext('webgl2');
  const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
  const gpu = gl && dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';

  try {
    scenarios.push(await zoomEngineScenario());
    const samples: [string, (s: number) => Promise<Awaited<ReturnType<typeof synthesizeRecording>>>][] = [
      ['browser recording', recordLikeBrowser],
      ['regular file', synthesizeRecording],
    ];
    // Optional, for looking into one's own recording: MOMOTOMBO_REAL_RECORDING_DIR=<folder with the
    // recording's files and recording.json>. It is copied into the temporary project.
    const real = await realSample();
    for (const [label, make] of [...samples, ...(real ? [['real recording', null] as const] : [])]) {
      const sample = make ? await createSampleProject(8, `Performance test (${label})`, make) : real!;
      const ed = await openInEditor(sample.id);
      if (!ed) { checks.push({ name: `Editor opened (${label})`, ok: false }); continue; }
      const zooms = await until(() => ed.store.project.zooms.length > 0 && ed.store.project.zooms.length, 12_000);
      const clicks = parseCursorLog(sample.recording?.cursorLog ?? '').clicks.filter((c) => c.kind === 'down').length;
      checks.push({ name: `Automatic zoom suggestions created (${label})`, ok: !!zooms, detail: `${zooms ?? 0} suggestions from ${clicks} clicks` });
      await until(() => ed.store.getState().save === 'saved', 5000);
      scenarios.push(await zoomInEditorScenario(ed, label));
      scenarios.push(await playbackScenario(ed, sample, label, checks));
      scenarios.push(await scrubScenario(ed, sample, label));
      const format = PROFILE.defaultExport;
      scenarios.push(await exportScenario(ed, label, { format, resolution: '1080', fps: 30 }, checks));
      scenarios.push(await exportScenario(ed, label, { format, resolution: '1080', fps: 60 }, checks));
    }
  } catch (e) {
    checks.push({ name: 'Performance test', ok: false, detail: (e as Error).stack ?? String(e) });
  }
  return {
    suite: 'perf', ok: checks.every((c) => c.ok), checks, scenarios, gpu, dist: DIST,
    totalSeconds: Math.round((performance.now() - started) / 100) / 10, userAgent: navigator.userAgent,
  };
}

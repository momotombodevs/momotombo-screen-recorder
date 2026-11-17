#!/usr/bin/env node
// Prints what a Windows CI run found, from the files the test steps left in <out>: every suite's
// result (failed checks with their details, GPU, WebCodecs capabilities, the real recording, MP4
// availability), the terms flow and the environment dump. Also appended to the job summary
// (GITHUB_STEP_SUMMARY), so the results stay readable when the artifact cannot be uploaded.
//
//   node tests/windows-env/ci-summary.mjs <out>
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { imageLines } from './log-images.mjs';

const out = process.argv[2];
if (!out || !existsSync(out)) { console.log(`ci-summary: no folder (${out})`); process.exit(0); }
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
walk(out);
const read = (f) => { try { return JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const lines = [];
const say = (s = '') => lines.push(s);

// First: the real recording's shape (the capture code's report). On a real display the first frame
// should have the display's shape, so no correction runs (held "initial") and no displayAspect is
// stored; otherwise which step held.
{
  const shapes = files.filter((x) => x.endsWith('ui-report.json')).map((f) => [f, read(f)]).filter(([, r]) => r?.realCapture || r?.captureShape?.length);
  if (shapes.length) {
    say('## Recording shape (real screen recording)');
    for (const [f, r] of shapes) {
      for (const c of r.captureShape ?? []) {
        const d = c.display ?? {};
        const ff = c.firstFrame ?? {};
        const right = d.width && ff.width ? Math.abs(ff.width / ff.height - d.width / d.height) < 0.02 : null;
        const tried = (c.attempts ?? []).map((a) => `${a.name}${a.ok ? ' HELD' : ''}${a.frame ? ` ${a.frame.width}×${a.frame.height}` : ''}${a.accepted === false ? ' (rejected)' : ''}`).join(', ');
        say(`${relative(out, f)}: display ${d.width}×${d.height}, first frame ${ff.width}×${ff.height} ${ff.format ?? ''} → ${right === true ? 'RIGHT SHAPE' : right === false ? 'WRONG SHAPE' : '?'}; held by: ${c.held}${tried ? `; tried: ${tried}` : '; correction chain did not run'}`);
      }
      const src = r.realCapture?.source;
      if (src) say(`${relative(out, f)}: source ${src.width}×${src.height}, displayAspect ${src.displayAspect ? `STORED ${src.displayAspect.toFixed(4)}` : 'not stored'}`);
    }
    say();
  }
}

for (const f of files.filter((x) => x.endsWith('-report.json'))) {
  const r = read(f);
  const run = read(f.replace(/-report\.json$/, '-run.json'));
  if (!r) continue;
  const checks = r.checks ?? [];
  say(`## ${relative(out, f)}: ${r.ok ? 'ok' : 'PROBLEMS'} · ${checks.filter((c) => c.ok).length}/${checks.length} · ${r.gpu ?? ''}`);
  if (run) say(`duration ${run.seconds} s, exit ${run.exitCode}${run.timedOut ? ' (timed out)' : ''}, OpenH264 lines ${run.openH264Lines}`);
  if (r.error) say(`error: ${r.error}`);
  if (r.mp4Missing) say(`MP4 cannot be written: ${r.mp4Missing}`);
  if (r.mp4Unavailable) say(`MP4 cannot be written (interface): ${r.mp4Unavailable}`);
  for (const c of checks) say(`${c.ok ? '✓' : c.known ? '⚠ KNOWN ISSUE' : '✗'} ${c.name}${c.detail ? ` — ${String(c.detail).slice(0, 600)}` : ''}${!c.ok && c.known ? ` [${c.known}]` : ''}`);
  if (r.capabilities) { say('Capabilities:'); for (const [k, v] of Object.entries(r.capabilities)) say(`  ${k}: ${v}`); }
  if (r.realCapture) {
    const { images, shape, ...rest } = r.realCapture;
    const { scales, ...shapeRest } = shape ?? {};
    say(`Real recording: ${JSON.stringify({ ...rest, shape: shape ? shapeRest : null })}`);
    if (scales) say(`Frame measurement scales: ${JSON.stringify(scales)}`);
    for (const im of images ?? []) say(`Image ${im.name}: ${im.note}${im.error ? ` — MISSING: ${im.error}` : im.jpeg ? ` (${Math.round((im.jpeg.length * 3) / 4 / 1024)} KB)` : ''}`);
  }
  for (const c of r.captureShape ?? []) say(`Recording window shape report: ${JSON.stringify(c)}`);
  if (r.gpuLog?.length) { say('Chromium GPU/WebGL lines:'); for (const l of r.gpuLog) say(`  ${l}`); }
  if (r.exportFacts) say(`Export measurements: ${JSON.stringify(r.exportFacts)}`);
  if (r.mp4Route || r.webCodecsH264 !== undefined) say(`MP4 route: ${r.mp4Route ?? '?'}, WebCodecs hardware H.264: ${r.webCodecsH264}`);
  if (r.userAgent) say(`userAgent: ${r.userAgent}`);
  say();
}
for (const f of files.filter((x) => x.endsWith('terms-flow.json'))) {
  const t = read(f);
  if (!t) continue;
  say(`## ${relative(out, f)}`);
  say(`DLL in package ${JSON.stringify(t.dllInPackage)}, in System32 ${t.systemHasD3dcompiler47}, terms text ${t.termsFileInPackage}`);
  for (const s of [].concat(t.scenarios ?? [])) say(`${s.ok ? '✓' : '✗'} ${s.scenario}: ${JSON.stringify(s)}`);
  say();
}
for (const f of files.filter((x) => /platform-packages-.*\.json$/.test(x))) say(`## ${relative(out, f)} (for docs/licenses/platform-packages.json)\n${readFileSync(f, 'utf8')}\n`);
for (const f of files.filter((x) => /dll-watch-.*\.json$|removed-dll\.json$/.test(x))) say(`## ${relative(out, f)}\n${readFileSync(f, 'utf8')}\n`);
// The package with and without its d3dcompiler_47.dll: which smoke checks differ.
{
  const a = files.find((x) => /packaged[\\/]smoke-report\.json$/.test(x));
  const b = files.find((x) => /packaged-nodll[\\/]smoke-report\.json$/.test(x));
  const ra = a && read(a);
  const rb = b && read(b);
  if (ra && rb) {
    const ok = (r) => new Map((r.checks ?? []).map((c) => [c.name, c.ok]));
    const ma = ok(ra);
    const mb = ok(rb);
    const names = [...new Set([...ma.keys(), ...mb.keys()])];
    const diff = names.filter((n) => ma.get(n) !== mb.get(n));
    say(`## Package with and without the DLL: ${[...ma.values()].filter(Boolean).length}/${ma.size} and ${[...mb.values()].filter(Boolean).length}/${mb.size} checks passed`);
    say(`renderer: "${ra.gpu}" / "${rb.gpu}"`);
    for (const n of diff) say(`  difference: ${n} — with DLL ${ma.get(n) ?? 'none'}, without DLL ${mb.get(n) ?? 'none'}`);
    if (!diff.length) say('  no difference');
    say();
  }
}
for (const f of files.filter((x) => x.endsWith('codec-audit-release-win32-x64.json'))) {
  const r = read(f);
  if (r) say(`## ${relative(out, f)}: ${r.ok ? 'ok' : 'PROBLEMS'}\nfailures: ${JSON.stringify(r.fails ?? [])}\nrelease blockers: ${JSON.stringify(r.blockers ?? [])}\nwarnings/notes: ${JSON.stringify(r.warnings ?? r.notes ?? [])}\n`);
}
for (const f of files.filter((x) => x.endsWith('helper-encode-probe.json'))) say(`## ${relative(out, f)}\n${readFileSync(f, 'utf8')}\n`);
for (const f of files.filter((x) => x.endsWith('uitest-clicks.json'))) say(`## ${relative(out, f)}\n${readFileSync(f, 'utf8')}\n`);

const text = lines.join('\n');
console.log(text || 'ci-summary: no report found');
if (process.env.GITHUB_STEP_SUMMARY && text) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);

// The real recording's pictures, from one run (the packaged one, else the development one), into the
// log only (not the job summary): node tests/windows-env/log-images.mjs gets them back.
{
  const reports = files.filter((x) => /[\\/]ui-report\.json$/.test(x));
  const pick = reports.find((x) => /packaged[\\/]ui-report\.json$/.test(x)) ?? reports.find((x) => read(x)?.realCapture?.images?.length);
  const images = (pick && read(pick)?.realCapture?.images) ?? [];
  if (images.length) {
    console.log(`\n## Images (${relative(out, pick)}): node tests/windows-env/log-images.mjs <log> <folder>`);
    for (const im of images) {
      if (!im.jpeg) { console.log(`image ${im.name} missing: ${im.error ?? '?'}`); continue; }
      try { for (const l of imageLines(im.name, im.jpeg)) console.log(l); } catch (e) { console.log(`image ${im.name} could not be written: ${e.message}`); }
    }
  }
  // And the development run's raw recorded frame, as one more picture.
  const dev = reports.find((x) => /dev[\\/]ui-report\.json$/.test(x));
  const raw = dev && dev !== pick ? (read(dev)?.realCapture?.images ?? []).find((im) => im.name === '2-raw-recording') : null;
  if (raw?.jpeg) { try { for (const l of imageLines('dev-2-raw-recording', raw.jpeg)) console.log(l); } catch (e) { console.log(`image dev-2-raw-recording could not be written: ${e.message}`); } }
}

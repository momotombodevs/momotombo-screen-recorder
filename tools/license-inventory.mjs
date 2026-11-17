// Lists every installed npm package with its declared license and whether a LICENSE file
// ships with it, classifies them against the project policy, and writes
// docs/licenses/inventory.md. Exit code 1 if anything is blocked or unknown.
//
// Platform-specific binaries (packages with "os"/"cpu" in package.json: esbuild, rolldown,
// TypeScript and lightningcss per system, fsevents) are only installed on their own system. Each
// one is recorded, on the system where it is installed, from its own package.json and license
// file into docs/licenses/platform-packages.json; the inventory lists those of every system.
//   node tools/license-inventory.mjs                    writes inventory.md (and records this system's)
//   node tools/license-inventory.mjs --print-platform   prints this system's records only (CI), writes nothing
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shippedPackages } from './third-party-notices.mjs';

const ROOT = process.cwd();
const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Zlib', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense', 'Python-2.0', 'CC-BY-4.0']);
const CONDITIONAL = new Set(['MPL-2.0', 'LGPL-2.1', 'LGPL-3.0', 'LGPL-2.1-or-later', 'LGPL-3.0-or-later']);
const store = join(ROOT, 'node_modules', '.pnpm');
const rows = new Map();

function classify(lic) {
  if (!lic) return 'unknown';
  const parts = lic.replace(/[()]/g, '').split(/\s+(?:OR)\s+/);
  if (parts.some((p) => ALLOWED.has(p.trim()))) return 'allowed';
  if (/\bAND\b/.test(lic) && lic.split(/\s+AND\s+/).every((p) => ALLOWED.has(p.trim()))) return 'allowed';
  if (parts.some((p) => CONDITIONAL.has(p.trim()))) return 'conditional';
  return 'blocked';
}

const direct = new Map();
for (const pkgJson of ['package.json', 'apps/desktop/package.json', ...readdirSync('packages').map((p) => `packages/${p}/package.json`)]) {
  const j = JSON.parse(readFileSync(pkgJson, 'utf8'));
  for (const [n] of Object.entries(j.dependencies ?? {})) if (!n.startsWith('@momotombo/')) direct.set(n, 'runtime');
  for (const [n] of Object.entries(j.devDependencies ?? {})) if (!direct.has(n)) direct.set(n, 'development');
}

for (const entry of existsSync(store) ? readdirSync(store) : []) {
  const nm = join(store, entry, 'node_modules');
  if (!existsSync(nm)) continue;

  for (const scopeOrName of readdirSync(nm)) {
    const dirs = scopeOrName.startsWith('@') ? readdirSync(join(nm, scopeOrName)).map((n) => join(scopeOrName, n)) : [scopeOrName];

    for (const d of dirs) {
      const pj = join(nm, d, 'package.json');
      if (!existsSync(pj)) continue;
      let j;
      try { j = JSON.parse(readFileSync(pj, 'utf8')); } catch { continue; }
      if (!j.name || !j.version) continue;
      const key = `${j.name}@${j.version}`;
      if (rows.has(key)) continue;

      const lic = typeof j.license === 'string' ? j.license : Array.isArray(j.licenses) ? j.licenses.map((l) => l.type).join(' OR ') : j.license?.type;
      const licenseFile = readdirSync(join(nm, d)).find((f) => /^(licen[cs]e|copying)/i.test(f)) ?? null;
      const platform = j.os || j.cpu ? [j.os, j.cpu].filter(Boolean).map((x) => [].concat(x).join(',')).join('/') : null;
      const row = { name: j.name, version: j.version, license: lic ?? '', hasFile: !!licenseFile, cls: classify(lic), use: direct.get(j.name) ?? 'transitive', platform };

      if (platform) {
        const text = licenseFile ? readFileSync(join(nm, d, licenseFile), 'utf8') : '';
        row.record = {
          name: j.name, version: j.version, platform, license: row.license, licenseFile,
          licenseSha256: licenseFile ? createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex') : null,
          licenseFirstLine: text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null,
          recordedOn: `${process.platform}-${process.arch}`,
        };
      }
      rows.set(key, row);
    }
  }
}

// This system's platform packages, as read above; then those recorded on other systems.
const PLATFORM_FILE = join(ROOT, 'docs', 'licenses', 'platform-packages.json');
const here = Object.fromEntries([...rows.values()].filter((r) => r.record).map((r) => [`${r.name}@${r.version}`, r.record]));

if (process.argv.includes('--print-platform')) {
  console.log(JSON.stringify(here, null, 1));
  process.exit(0);
}

const recorded = existsSync(PLATFORM_FILE) ? JSON.parse(readFileSync(PLATFORM_FILE, 'utf8')) : {};
const platformRecords = Object.fromEntries(Object.entries({ ...recorded, ...here }).sort(([a], [b]) => a.localeCompare(b)));

for (const [key, r] of Object.entries(platformRecords)) {
  if (rows.has(key)) continue;
  rows.set(key, { name: r.name, version: r.version, license: r.license, hasFile: !!r.licenseFile, cls: classify(r.license), use: 'transitive', platform: r.platform });
}
writeFileSync(PLATFORM_FILE, `${JSON.stringify(platformRecords, null, 1)}\n`);

const list = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
const count = (c) => list.filter((r) => r.cls === c).length;
// A conditional license matters for what is distributed: the app's packages (third-party-notices.mjs),
// never node_modules. MPL-2.0, for example, creates obligations only on distribution (MPL 2.0 FAQ, Q5).
const shipped = new Set(shippedPackages(ROOT).map((p) => `${p.name}@${p.version}`));
const conditional = list.filter((r) => r.cls === 'conditional').map((r) => {
  const ships = shipped.has(`${r.name}@${r.version}`);
  return `- ${r.name}@${r.version} (${r.license}): ${ships ? '**shipped with the app**; the license\'s distribution obligations must be met' : 'not shipped with the app (development/build tool only); with no distribution, the license\'s obligations do not arise'}`;
});

const lines = [
  '# License inventory (generated)',
  '',
  `Generated: ${new Date().toISOString()} · \`node tools/license-inventory.mjs\``,
  '',
  `Total ${list.length} packages · allowed ${count('allowed')} · conditional ${count('conditional')} · blocked ${count('blocked')} · unknown ${count('unknown')}`,
  '',
  'This table is based on package metadata. Before a release, the license of every component that ships is also checked against the LICENSE file of the version in use.',
  '',
  ...(conditional.length ? ['Packages under conditional licenses and whether they ship (shipped packages: `tools/third-party-notices.mjs`):', '', ...conditional, ''] : []),
  'Rows with a Platform value are build tools installed only on that system (esbuild, rolldown, TypeScript and lightningcss binaries; fsevents); they do not go into the app package. Each was recorded on its own system from the installed package\'s package.json and license file: `docs/licenses/platform-packages.json` (license file name, SHA-256, first line, system it was recorded on).',
  '',
  '| Package | Version | License | LICENSE file | Use | Class | Platform |',
  '|---|---|---|---|---|---|---|',
  ...list.map((r) => `| ${r.name} | ${r.version} | ${r.license || '—'} | ${r.hasFile ? 'yes' : 'no'} | ${r.use} | ${r.cls} | ${r.platform ?? '—'} |`),
  '',
  '## Components added by hand',
  '',
  '| Component | License | Source | Note |',
  '|---|---|---|---|',
  '| Electron binary (Chromium, Node; OpenH264, libvpx, libaom, dav1d, Opus compiled in) | MIT + LICENSES.chromium.html | electron/electron, official release zip (SHA-256 verified) | Every package carries that platform\'s LICENSE and LICENSES.chromium.html (checked by tools/codec-audit.mjs) |',
  '| FFmpeg (libffmpeg.dylib / ffmpeg.dll) | LGPL-2.1+ (LICENSES.chromium.html, “ffmpeg”) | Electron\'s official ffmpeg-v<version>-<platform>-<arch>.zip build | Packages use the build without proprietary codecs (no H.264/AAC decoders). Dynamically linked; source offer: FFMPEG-LGPL.md. node_modules/electron in development still has the build with proprietary codecs |',
  '| macOS system frameworks (VideoToolbox, AudioToolbox, AVFoundation, ScreenCaptureKit) | Apple macOS license | macOS | Not shipped with the app; H.264/AAC are encoded only with them (in the released A distribution the macOS recorder helper and MP4 export; since 2026-11-13 MP4 export in B too). AVC notice: macOS SLA §14 D |',
  '| Mantle, ReactiveObjC (macOS; Electron Framework links them) | MIT (Mantle: Proton parts BSD) | Mantle/Mantle, ReactiveCocoa/ReactiveObjC 3.1.0 | Missing from Electron\'s Chromium notices; the texts go into the package from tools/notices-supplement/ |',
  '| d3dcompiler_47.dll (Windows) | Microsoft, Windows SDK Distributable Code | Electron Windows zip | While it ships, end users accept the user terms on first start (MICROSOFT-D3DCOMPILER-TERMS.txt); the legal review of that text and the duty to indemnify Microsoft need the distributor\'s decision (tools/windows-terms.json; a release blocker while empty). The option of shipping without the DLL is to be tried on real Windows with tools/windows-test |',
  '| dxil.dll, dxcompiler.dll (Windows) | Microsoft DXC license / NCSA | Electron Windows zip | Removed from the packages (only for WebGPU; Momotombo uses WebGL2) |',
  '| Icons, cursor, tray icon, backgrounds | Original work in this project | — | Generated in code; no external images |',
  '| Momotombo helpers: momotombo-recorder (macOS, A only), momotombo-input, momotombo-audio (macOS), momotombo-win.exe (Windows) | Momotombo\'s own license (LICENSE) | native/recorder-macos, native/input-macos, native/audio-macos, native/helper-windows | Linked only to operating-system frameworks / system DLLs; tools/codec-audit.mjs checks the links |',
  '| Zig 0.17.0 (build tool only, not in the package) | MIT | ziglang.org official archive (SHA-256 verified), tools/.cache/zig | Cross-compiles momotombo-win.exe. No C runtime, compiler-rt, MinGW-w64 header or import library is linked (linker inputs verified: only our own object file and the libraries generated from imports/*.def) |',
  '| Windows and Media Foundation API declarations (native/helper-windows/win-api.h) | Original work in this project | Microsoft Learn; microsoft/windows-rs 0.62.2 (MIT or Apache-2.0) as reference only | Interface names, values, struct layouts and COM method order; no code copied |',
  '| Windows system DLLs (KERNEL32, USER32, SHELL32, ole32, dwmapi, MFPlat, MFReadWrite) and Media Foundation decoders / encoders | Microsoft Windows license | Windows | Not shipped with the app; the H.264 and AAC of MP4 exports are written through Chromium with the Media Foundation encoders (experimental Windows package; not tested on Windows). AAC audio is decoded with Windows\' own decoder (not tested on Windows) |',
  '| macOS AVFoundation / AVFAudio / CoreMedia (audio helper) | Apple macOS license | macOS | Not shipped with the app; the AAC audio of imported videos is decoded with macOS\' decoder and written as Opus |',
  '| Fonts | System fonts (not packaged) | — | Candidate OFL fonts not added yet |',
  '',
];
writeFileSync(join(ROOT, 'docs', 'licenses', 'inventory.md'), lines.join('\n'));
const bad = list.filter((r) => r.cls === 'blocked' || r.cls === 'unknown');
console.log(`${list.length} packages · allowed ${count('allowed')} · conditional ${count('conditional')} · blocked ${count('blocked')} · unknown ${count('unknown')}`);
for (const r of list.filter((x) => x.cls !== 'allowed')) console.log(`  ${r.cls.padEnd(11)} ${r.name}@${r.version} (${r.license || 'no license field'}) [${r.use}]`);
process.exit(bad.length ? 1 : 0);

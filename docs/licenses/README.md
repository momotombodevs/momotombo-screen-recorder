# License records and notices

| File | What | How it is updated |
|---|---|---|
| `inventory.md` | Every installed npm package: version, license, class | `node tools/license-inventory.mjs` |
| `../THIRD_PARTY_NOTICES.md` | Full license texts of the components **distributed** with the app; Electron/Chromium; codec table | `node tools/third-party-notices.mjs --write` |
| `../../tools/codec-notes.json` | Open-source license and patent status of the codec components (separately, ES/EN) | By hand |

## How distributed components are found
- The list is not kept by hand. It is taken from the production dependency tree of the `apps/desktop` package. Workspace packages (`@momotombo/*`) are our own code and are not listed, but their dependencies are scanned too.
- The Electron runtime is added separately.
- Source maps are also scanned during the build. Every npm package that goes into the package must be in the notices; otherwise the build stops.
- License texts are read from the installed packages. pnpm verifies each package with the integrity hash in `pnpm-lock.yaml`, so the texts are the files the authors published for that version.
- On 2026-10-17 the license type and copyright lines for react, zod and Electron were compared with the LICENSE file of the same version in the official repositories, and they matched.

## How it gets into the package
The last step of `pnpm --filter @momotombo/desktop build`, `scripts/build-licenses.mjs`, writes these to `apps/desktop/dist/licenses/`:
- `THIRD_PARTY_NOTICES.md`
- `third-party.json` (data for the Settings → Licenses screen)
- `electron-LICENSE.txt`
- `LICENSES.chromium.html`

The packager (`apps/desktop/scripts/package.mjs`) copies this folder into the packaged app and regenerates it for the package's platform (see "Distribution packages" below).

## Automated checks
`apps/desktop/src/shared/licenses.test.ts` runs with `pnpm test`. It fails when:
- the list of distributed packages changes;
- a LICENSE text is missing or the license is not in the policy (only MIT, ISC, BSD-2/3, Apache-2.0, Zlib, 0BSD);
- `THIRD_PARTY_NOTICES.md` is out of date;
- an installed package is missing from the inventory (new dependency);
- the FFmpeg, OpenH264, libvpx and Opus entries cannot be found in the Chromium notice;
- a codec's patent status is shown as "resolved" or similar.

The build step also scans the source maps. The smoke test also checks that the in-app data arrives and the screen is shown.

## When adding a new dependency
1. Verify the license from the LICENSE file of the version to be used and from the official source.
2. Run `node tools/license-inventory.mjs` and `node tools/third-party-notices.mjs --write`; review the diff.
3. Run `pnpm test` and `pnpm smoke`.

## Distribution packages (2026-10-17)
`pnpm package -- --profile mp4|webm [--platform darwin|win32] [--arch arm64|x64]` produces a temporary local package (`apps/desktop/out/`, outside git). The packager adds no dependencies; it uses Electron's official zips with SHA-256 verification (`tools/electron-artifacts.mjs`).
- **In every package:** under `Resources/licenses/`: `THIRD_PARTY_NOTICES.md`, `third-party.json`, `electron-LICENSE.txt`, **that platform's** `LICENSES.chromium.html` (the macOS and Windows files differ), `FFMPEG-LGPL.md`, `DISTRIBUTION.json`; at the package root, Electron's `LICENSE` and `LICENSES.chromium.html`; `app/dist/licenses/` for the Licenses screen.
- **FFmpeg:** in both distributions, Electron's official `ffmpeg-v<version>` build without proprietary codecs (no H.264/AAC decoder). A separate, dynamically linked file; the LGPL-2.1 text is in the "ffmpeg" entry of the Chromium notice.
- **Codec table** (`tools/codec-notes.json`) is filtered by distribution (the `profiles` field); `docs/THIRD_PARTY_NOTICES.md` shows all rows.
- **Audit:** `pnpm codec-audit -- <package> --profile mp4|webm [--probe] [--release]` (`tools/codec-audit.mjs`). A missing license file, the wrong platform's Chromium notice, a codec library found in a binary but not in the notice, FFmpeg with codecs, H.264/AAC code in the VP8 distribution, a recording helper outside A, or a missing AAC path for MP4 in A and B, or `third-party.json` not matching the distributed packages → FAILED. `--release` also stops if Momotombo's own license is missing.

## Components not in Electron's Chromium notice (2026-10-17)
Every binary in the package (Mach-O / PE) is matched to a notice (`tools/codec-audit.mjs`, `BINARY_NOTICES`); a binary with no match, or whose notice is not in the package, stops the audit. This scan found components that are not in Electron's `LICENSES.chromium.html`:
- **macOS:** Mantle and ReactiveObjC (Electron Framework depends on them; they cannot be removed). Their MIT texts are in `tools/notices-supplement/`, taken unchanged from the official repositories; they appear in section 2b of `THIRD_PARTY_NOTICES.md` and on the Licenses screen.
- **Windows:** a notice was added for `d3dcompiler_47.dll` (Microsoft, Windows SDK distributable code; needed for WebGL, not a system component according to Microsoft); the license text is in the Windows SDK and needs legal verification. `dxil.dll` (Microsoft DXC license: end-user terms that protect Microsoft and an indemnity obligation) and `dxcompiler.dll` are only for WebGPU; Momotombo uses WebGL2, so the packager removes them (not tested on Windows).
The scan is run again for each new Electron version; if a new binary shows up, its notice is added first.

## FFmpeg source package
`node tools/ffmpeg-source.mjs` → `apps/desktop/out/release-sources/momotombo-ffmpeg-lgpl-source-electron-<version>.tar.gz` and the record `docs/licenses/ffmpeg-source.json`. Contents: an archive of the `chromium/third_party/ffmpeg` revision pinned by Chromium (the version headers carry the same identity as the binary in the package), Electron's patch and the build settings. The server regenerates the archive on every download; the git tree ID identifies its contents and SHA-256 identifies the file to publish. The `FFMPEG-LGPL.md` in the packages names this file by SHA-256; `codec-audit --release` stops if the file is missing or different. **This file must be added to every GitHub release.**

## Source code and notice obligations
| Component | Obligation | Status |
|---|---|---|
| MIT/ISC/BSD/Apache npm packages | License text and copyright line with the distribution | In place (THIRD_PARTY_NOTICES, Licenses screen) |
| Electron (MIT) and Chromium components | `LICENSE` and `LICENSES.chromium.html` in every package | In place, audited |
| FFmpeg (LGPL-2.1+) | Prominent notice + license text (§6); corresponding source of the library from the same place as the distribution (§4, §6 d); reverse engineering for modification and debugging cannot be prohibited (§6); FFmpeg's recommendation: credit on the download page and in the "about" window | Notice, license text and source package ready (revision 2b68d2babae7); adding it to the release page and the download page credit are release steps |
| Mantle, ReactiveObjC (MIT, macOS) | License text | Added (section 2b) |
| d3dcompiler_47.dll (Microsoft, Windows) | Windows SDK distributable code terms | Notice added; the text of the terms and their effect on Momotombo await legal verification |
| OpenH264, libvpx, libaom, dav1d, Opus (BSD) | Notice | In the Chromium notice, audited |
| macOS system frameworks | Not distributed | — |

## Not resolved yet
- Codec patents (H.264, AAC, OpenH264) need a legal opinion. 2026-11-13: the user chose, without a legal opinion and accepting the risk, that MP4 is H.264 + AAC (with the operating system's encoder) and that the published distribution is A (`MOMOTOMBO_DIST=mp4`, with the macOS recording helper).
- The Windows SDK distributable code terms (d3dcompiler_47.dll) have not been verified against the official text.

## Native macOS recording helper (2026-10-17)
Sound is written as Opus, not AAC (macOS's encoder); the AAC sound of imported videos is decoded on macOS with `--extract-audio` and converted to Opus. `native/recorder-macos` uses only the Swift standard library and Apple system frameworks that ship with macOS (ScreenCaptureKit, AVFoundation, Core Media, Core Video, Core Graphics, AppKit). There are no third-party packages, source code or binaries; there is nothing to add to the inventory. The system frameworks are not distributed with the app; they are already on the user's macOS. H.264 and AAC encoding is done by macOS's own encoders. The patent and license status of these encoders depends on Apple's macOS license terms and has not been legally verified.

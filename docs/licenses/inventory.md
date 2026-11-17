# License inventory (generated)

Generated: 2026-11-17T21:41:12.846Z · `node tools/license-inventory.mjs`

Total 66 packages · allowed 63 · conditional 3 · blocked 0 · unknown 0

This table is based on package metadata. Before a release, the license of every component that ships is also checked against the LICENSE file of the version in use.

Packages under conditional licenses and whether they ship (shipped packages: `tools/third-party-notices.mjs`):

- lightningcss@1.33.0 (MPL-2.0): not shipped with the app (development/build tool only); with no distribution, the license's obligations do not arise
- lightningcss-darwin-arm64@1.33.0 (MPL-2.0): not shipped with the app (development/build tool only); with no distribution, the license's obligations do not arise
- lightningcss-win32-x64-msvc@1.33.0 (MPL-2.0): not shipped with the app (development/build tool only); with no distribution, the license's obligations do not arise

Rows with a Platform value are build tools installed only on that system (esbuild, rolldown, TypeScript and lightningcss binaries; fsevents); they do not go into the app package. Each was recorded on its own system from the installed package's package.json and license file: `docs/licenses/platform-packages.json` (license file name, SHA-256, first line, system it was recorded on).

| Package | Version | License | LICENSE file | Use | Class | Platform |
|---|---|---|---|---|---|---|
| @electron-internal/extract-zip | 1.0.5 | BSD-2-Clause | no | transitive | allowed | — |
| @electron/get | 5.1.0 | MIT | yes | transitive | allowed | — |
| @esbuild/darwin-arm64 | 0.28.2 | MIT | no | transitive | allowed | darwin/arm64 |
| @esbuild/win32-x64 | 0.28.2 | MIT | no | transitive | allowed | win32/x64 |
| @jridgewell/resolve-uri | 3.1.2 | MIT | yes | transitive | allowed | — |
| @jridgewell/sourcemap-codec | 1.6.0 | MIT | yes | transitive | allowed | — |
| @jridgewell/trace-mapping | 0.3.31 | MIT | yes | transitive | allowed | — |
| @oxc-project/types | 0.154.0 | MIT | yes | transitive | allowed | — |
| @rolldown/binding-darwin-arm64 | 1.2.14 | MIT | no | transitive | allowed | darwin/arm64 |
| @rolldown/binding-win32-x64-msvc | 1.2.14 | MIT | no | transitive | allowed | win32/x64 |
| @rolldown/pluginutils | 1.0.1 | MIT | yes | transitive | allowed | — |
| @types/chai | 5.2.3 | MIT | yes | transitive | allowed | — |
| @types/deep-eql | 4.0.2 | MIT | yes | transitive | allowed | — |
| @types/estree | 1.0.9 | MIT | yes | transitive | allowed | — |
| @types/node | 24.19.2 | MIT | yes | development | allowed | — |
| @types/node | 26.6.5 | MIT | yes | development | allowed | — |
| @types/react | 19.3.0 | MIT | yes | development | allowed | — |
| @types/react-dom | 19.3.0 | MIT | yes | development | allowed | — |
| @typescript/typescript-darwin-arm64 | 7.0.2 | Apache-2.0 | yes | transitive | allowed | darwin/arm64 |
| @typescript/typescript-win32-x64 | 7.0.2 | Apache-2.0 | yes | transitive | allowed | win32/x64 |
| @vitest/mocker | 5.0.5 | MIT | yes | transitive | allowed | — |
| @vitest/spy | 5.0.5 | MIT | yes | transitive | allowed | — |
| assertion-error | 2.0.1 | MIT | yes | transitive | allowed | — |
| chai | 6.3.0 | MIT | yes | transitive | allowed | — |
| csstype | 3.2.3 | MIT | yes | transitive | allowed | — |
| debug | 4.4.3 | MIT | yes | transitive | allowed | — |
| detect-libc | 2.1.2 | Apache-2.0 | yes | transitive | allowed | — |
| electron | 44.8.0 | MIT | yes | development | allowed | — |
| env-paths | 3.0.0 | MIT | yes | transitive | allowed | — |
| es-module-lexer | 2.3.2 | MIT | yes | transitive | allowed | — |
| esbuild | 0.28.2 | MIT | yes | development | allowed | — |
| estree-walker | 3.0.3 | MIT | yes | transitive | allowed | — |
| expect-type | 1.4.0 | Apache-2.0 | yes | transitive | allowed | — |
| fdir | 6.5.0 | MIT | yes | transitive | allowed | — |
| fsevents | 2.3.3 | MIT | yes | transitive | allowed | darwin |
| graceful-fs | 4.2.11 | ISC | yes | transitive | allowed | — |
| lightningcss | 1.33.0 | MPL-2.0 | yes | transitive | conditional | — |
| lightningcss-darwin-arm64 | 1.33.0 | MPL-2.0 | yes | transitive | conditional | darwin/arm64 |
| lightningcss-win32-x64-msvc | 1.33.0 | MPL-2.0 | yes | transitive | conditional | win32/x64 |
| magic-string | 1.4.3 | MIT | yes | transitive | allowed | — |
| ms | 2.1.3 | MIT | yes | transitive | allowed | — |
| nanoid | 3.3.20 | MIT | yes | transitive | allowed | — |
| obug | 3.0.0 | MIT | yes | transitive | allowed | — |
| picocolors | 1.1.1 | ISC | yes | transitive | allowed | — |
| picomatch | 4.0.7 | MIT | yes | transitive | allowed | — |
| postcss | 8.5.30 | MIT | yes | transitive | allowed | — |
| progress | 2.0.3 | MIT | yes | transitive | allowed | — |
| react | 19.3.1 | MIT | yes | runtime | allowed | — |
| react-dom | 19.3.1 | MIT | yes | runtime | allowed | — |
| rolldown | 1.2.14 | MIT | yes | transitive | allowed | — |
| scheduler | 0.28.0 | MIT | yes | transitive | allowed | — |
| semver | 7.8.5 | ISC | yes | transitive | allowed | — |
| source-map-js | 1.2.2 | BSD-3-Clause | yes | transitive | allowed | — |
| std-env | 4.3.0 | MIT | yes | transitive | allowed | — |
| sumchecker | 3.0.1 | Apache-2.0 | yes | transitive | allowed | — |
| tinybench | 6.2.2 | MIT | yes | transitive | allowed | — |
| tinyexec | 1.3.1 | MIT | yes | transitive | allowed | — |
| tinyglobby | 0.2.17 | MIT | yes | transitive | allowed | — |
| typescript | 7.0.2 | Apache-2.0 | yes | development | allowed | — |
| undici | 7.30.1 | MIT | yes | transitive | allowed | — |
| undici-types | 7.24.6 | MIT | yes | transitive | allowed | — |
| undici-types | 8.9.0 | MIT | yes | transitive | allowed | — |
| vite | 8.3.4 | MIT | yes | development | allowed | — |
| vitest | 5.0.5 | MIT | yes | development | allowed | — |
| why-is-node-running | 3.2.1 | MIT | yes | transitive | allowed | — |
| zod | 4.6.7 | MIT | yes | runtime | allowed | — |

## Components added by hand

| Component | License | Source | Note |
|---|---|---|---|
| Electron binary (Chromium, Node; OpenH264, libvpx, libaom, dav1d, Opus compiled in) | MIT + LICENSES.chromium.html | electron/electron, official release zip (SHA-256 verified) | Every package carries that platform's LICENSE and LICENSES.chromium.html (checked by tools/codec-audit.mjs) |
| FFmpeg (libffmpeg.dylib / ffmpeg.dll) | LGPL-2.1+ (LICENSES.chromium.html, “ffmpeg”) | Electron's official ffmpeg-v<version>-<platform>-<arch>.zip build | Packages use the build without proprietary codecs (no H.264/AAC decoders). Dynamically linked; source offer: FFMPEG-LGPL.md. node_modules/electron in development still has the build with proprietary codecs |
| macOS system frameworks (VideoToolbox, AudioToolbox, AVFoundation, ScreenCaptureKit) | Apple macOS license | macOS | Not shipped with the app; H.264/AAC are encoded only with them (in the released A distribution the macOS recorder helper and MP4 export; since 2026-11-13 MP4 export in B too). AVC notice: macOS SLA §14 D |
| Mantle, ReactiveObjC (macOS; Electron Framework links them) | MIT (Mantle: Proton parts BSD) | Mantle/Mantle, ReactiveCocoa/ReactiveObjC 3.1.0 | Missing from Electron's Chromium notices; the texts go into the package from tools/notices-supplement/ |
| d3dcompiler_47.dll (Windows) | Microsoft, Windows SDK Distributable Code | Electron Windows zip | While it ships, end users accept the user terms on first start (MICROSOFT-D3DCOMPILER-TERMS.txt); the legal review of that text and the duty to indemnify Microsoft need the distributor's decision (tools/windows-terms.json; a release blocker while empty). The option of shipping without the DLL is to be tried on real Windows with tools/windows-test |
| dxil.dll, dxcompiler.dll (Windows) | Microsoft DXC license / NCSA | Electron Windows zip | Removed from the packages (only for WebGPU; Momotombo uses WebGL2) |
| Icons, cursor, tray icon, backgrounds | Original work in this project | — | Generated in code; no external images |
| Momotombo helpers: momotombo-recorder (macOS, A only), momotombo-input, momotombo-audio (macOS), momotombo-win.exe (Windows) | Momotombo's own license (LICENSE) | native/recorder-macos, native/input-macos, native/audio-macos, native/helper-windows | Linked only to operating-system frameworks / system DLLs; tools/codec-audit.mjs checks the links |
| Zig 0.17.0 (build tool only, not in the package) | MIT | ziglang.org official archive (SHA-256 verified), tools/.cache/zig | Cross-compiles momotombo-win.exe. No C runtime, compiler-rt, MinGW-w64 header or import library is linked (linker inputs verified: only our own object file and the libraries generated from imports/*.def) |
| Windows and Media Foundation API declarations (native/helper-windows/win-api.h) | Original work in this project | Microsoft Learn; microsoft/windows-rs 0.62.2 (MIT or Apache-2.0) as reference only | Interface names, values, struct layouts and COM method order; no code copied |
| Windows system DLLs (KERNEL32, USER32, SHELL32, ole32, dwmapi, MFPlat, MFReadWrite) and Media Foundation decoders / encoders | Microsoft Windows license | Windows | Not shipped with the app; the H.264 and AAC of MP4 exports are written through Chromium with the Media Foundation encoders (experimental Windows package; not tested on Windows). AAC audio is decoded with Windows' own decoder (not tested on Windows) |
| macOS AVFoundation / AVFAudio / CoreMedia (audio helper) | Apple macOS license | macOS | Not shipped with the app; the AAC audio of imported videos is decoded with macOS' decoder and written as Opus |
| Fonts | System fonts (not packaged) | — | Candidate OFL fonts not added yet |

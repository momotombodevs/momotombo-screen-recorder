# Momotombo macOS recording helper (`momotombo-recorder`)

A small helper program with no window that records the screen, camera, microphone, system audio and pointer/click events of the Momotombo app on macOS into **separate files**. It uses only Apple's system frameworks (ScreenCaptureKit, AVFoundation, Core Media, Core Video, AppKit); there is no third-party code or package.

## Build

```bash
pnpm native:mac
```

- Command Line Tools are enough (Xcode is not needed). `swiftc` is called directly; SwiftPM is not used. In the Command Line Tools on this machine, SwiftPM's manifest library did not match the compiler, so `Package.swift` could not be linked; `Package.swift` is kept only for those who want to open it with Xcode.
- Output: `bin/momotombo-recorder`, an arm64 + x86_64 universal binary, minimum macOS 13.
- Signature: ad hoc, with the hardened runtime. `entitlements.plist` declares only the camera and microphone entitlements (without them the hardened runtime blocks the camera and microphone). Developer ID signing and notarization for distribution have not been done yet.
- `Info.plist` is embedded in the binary (`__TEXT,__info_plist`): the identifier `dev.momotombo.recorder.recorder` and the usage descriptions.

Self-test (does not capture, does not ask for permissions; tests the session log and file measurement in its own temporary folder):

```bash
native/recorder-macos/bin/momotombo-recorder --self-test
```

The playable length of the files in a recording folder (for crash recovery; does not capture, does not ask for permissions):

```bash
native/recorder-macos/bin/momotombo-recorder --probe-files <recording folder>
```

## Permissions

macOS ties permissions to the **responsible app**, that is, the Momotombo app that starts the helper. This is why permission windows show the name "Momotombo"; if the helper is run from a terminal, the permissions are attributed to the terminal. For this reason the real recording tests run from inside the Momotombo development bundle (`tests/real-capture`).

- Screen and system audio: ScreenCaptureKit. On first use macOS shows its own window, the user allows it under System Settings › Privacy & Security › Screen & System Audio Recording, and then Momotombo is restarted.
- Camera and microphone: `AVCaptureDevice.requestAccess`, that is, macOS's normal permission window.
- Pointer and clicks: `NSEvent.mouseLocation`, `NSEvent.pressedMouseButtons` and a listen-only global event monitor (mouse buttons and scrolling). **The keyboard is never read.** No extra permission is needed.
- The `request-access` command only opens these system windows, without capturing anything.

## Protocol

The helper reads one JSON command per line from stdin and writes one JSON message per line to stdout. TypeScript side: `apps/desktop/src/main/capture/helper-client.ts`.

| App → helper | Meaning |
|---|---|
| `prepare {outDir, display \| window, region?, bounds?, fps, quality, camera?, mic?, systemAudio, excludeOwnAudio?, excludePid, meta?}` | Opens and warms up the sources (during the countdown). Recording does not start. `meta` is the app's description of the recording (recording ID, backend, target); the helper writes it unchanged to `session.jsonl`. |
| `go` | Starts the shared clock; each source starts writing to its own file. |
| `start` | `prepare` + `go`. |
| `pause` / `resume` / `mark` | Pause (time is cut), resume, marker. |
| `stop` | Closes the files, sends `stopped`. |
| `cancel` | Closes without keeping anything. |
| `request-access {screen?, camera?, mic?}` | System permission windows only. |

What the helper sends: `hello`, `ready`, `started`, `status` (every 0.5 s; microphone level, dropped frames), `interrupted` (macOS stopped the stream), `stopped`, `cancelled`, `access`, `error {code, message, fatal}`.

If the app closes (stdin closes), the running recording is finished and the files are closed, then the helper exits.

## Files

| File | Contents |
|---|---|
| `screen.mp4` | The screen, **without** the pointer drawn (H.264, variable frame rate). Momotombo's own windows are not captured. |
| `camera.mp4` | The camera, separate from the screen (H.264; 720p for "standard", 1080p for "high/highest" if the camera supports it). |
| `mic.m4a` | Microphone, mono 48 kHz **Opus** (in an MP4 container, with macOS's own encoder). 16-bit PCM on a macOS that cannot write Opus. |
| `system.m4a` | System audio, stereo 48 kHz **Opus** (same rule). Momotombo's own sound is left out by default. |
| `cursor.jsonl` | Pointer position (120 Hz polling; unchanged positions at 2 Hz), button press/release, scrolling, markers. Coordinates are 0..1 relative to the recorded area. |
| `session.jsonl` | Session log for crash recovery (below). |

The first sample of each file is stamped against the shared session clock (`startOffsetMs`); this is how the sources line up in the project and **can be edited separately**. Sound is Opus, not AAC: the Electron build without an AAC decoder can decode these files too. MP4/M4A files are written in 2-second fragments; if the helper closes suddenly, everything up to the last fragment stays readable.

## Recovery after a crash

During recording the helper writes `session.jsonl` to the recording folder. One JSON object per line; **each line is synced to disk right after it is written** (`FileHandle.synchronize()`), so lines reach the disk before the call returns.

| Line | When |
|---|---|
| `{"e":"session","v":1,"startedAtMs","pid","helper","version","platform","fps","cursor","meta"}` | At `go`, before the clock starts |
| `{"e":"track","kind","name","mime","startOffsetMs", width/height/fps \| sampleRate/channels}` | When a file gets its first sample and is opened (before the first 2 s fragment reaches the disk) |
| `{"e":"pause","t","atMs"}` / `{"e":"resume","t","atMs"}` | Pause / resume (`t`: tick on the recording clock) |
| `{"e":"mark","t"}` | Marker |
| `{"e":"end","durationMs"}` | The files closed properly (`stop`, or the app closed) |
| `{"e":"cancelled"}` | Cancelled: nothing is kept |

The app (`apps/desktop/src/main/capture/recovery.ts`):

- If the helper closes unexpectedly during recording (or while closing the files), it recovers that recording right away and opens it in the editor.
- On launch, it finds `media/rec_…` folders that have a `session.jsonl` but no recording in the project (if the app itself closed during recording, the helper has finished the files and written `end`). It does not touch cancelled sessions, a helper that is still writing, or folders already examined and found empty (`recovery.json`).
- It reads the playable length of each file with `--probe-files`: AVFoundation reads the track samples as stored (without decoding); a last fragment left half-written by the crash is not counted. The sources are placed on the shared clock with the `startOffsetMs` in the log, and the recording ends where the screen video ends. The recording is added to the project with `appendRecording`; the user sees the notice "The recording was interrupted; X s recovered".
- Files are never deleted or changed.

A recording helper for another platform must use the same log format and the same `--probe-files` output.

## Known limits

- macOS may not start capturing while the display is off or while a system prompt is waiting for an answer; the helper gives a `screen-start-timeout` error after 20 seconds.
- The helper's signature (cdhash) changes each time it is rebuilt. Whether macOS counts this as a reason for a new approval has not been verified.
- This helper has no Windows counterpart; the Windows version uses the browser recording path.

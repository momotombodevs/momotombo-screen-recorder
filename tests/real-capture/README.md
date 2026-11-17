# Real recording test (macOS)

Records on this Mac with the real Swift recording helper and measures the results. Unlike the unit tests, it uses the real screen, camera, microphone and system audio.

```bash
node tests/real-capture/run-real-capture.mjs --permissions        # macOS permission windows only
node tests/real-capture/run-real-capture.mjs                      # all scenarios
node tests/real-capture/run-real-capture.mjs --only window-30fps --results results.json
```

## How it works

1. `harness/` is started inside the Momotombo development bundle (`open -n -W`). This way macOS attributes permissions to Momotombo, not to the app that started it (for example the terminal).
2. The harness opens a synthetic **test pattern** window (`pattern/index.html`): a constantly moving square, a sync square that flashes white every 2 seconds together with a 1 kHz beep, and numbered click targets. The pattern contains no personal data.
3. The helper is driven by the app's own `HelperClient` class (`apps/desktop/src/main/capture/helper-client.ts`).
4. `media-probe.swift` (AVFoundation) measures the files: frame count and intervals, the moments the flashes appear, the moments the tone starts. The tool was verified with known files produced by `make-fixture.swift`: the flashes and tones at 1.000 s and 3.000 s were found at exactly those moments.
5. `analyze.ts` compares the measurements with the cursor log and the pattern log, and runs the automatic zoom engine on the real clicks.
6. `chromium-probe.mjs` measures the same markers the way the app sees them: in Chromium, with the codec-free FFmpeg from the distribution packages (`decodeAudioData` and `<video>`). Calibration: the `make-fixture` output (`fixture-opus.m4a` is written in the same format as the recording helper).

```bash
node tests/real-capture/chromium-probe.mjs results.json <folder>/mic.m4a <folder>/system.m4a "<folder>/screen.mp4:0.89,0.05,0.08,0.12"
```

Several regions in one video are separated by `;` (`screen.webm:x,y,w,h;x,y,w,h`); in the result, the moments of the first region are under `rises` and those of all regions under `regions`. For browser-path recordings the regions are produced by `tests/real-capture-web/analyze.mjs --probe-args`: the sync square and six click targets.

## Scenarios

| Name | What it measures |
|---|---|
| `region-60fps-all-sources` | Screen region at 60 fps, camera, microphone, system audio, pause, markers, clicks (6 targets) |
| `system-audio-without-momotombo` | That with default settings Momotombo's own sound does not get into the system audio |
| `window-30fps` | Single window recording |
| `long-recording` | 3 minutes: time drift, CPU and memory |
| `sync-opus` | Window recording (60 fps) + system audio + microphone, no camera, 90 s (`--sync-seconds`): picture-sound sync with Opus audio files. For the microphone measurement the beep must be heard from the speaker |
| `crash-sigkill` | What is left on disk when the helper is killed during recording (after a marker and a pause), and that the app's recovery code adds the recording to a real project: loss, source alignment, markers, not added again on the second launch |
| `app-closed` | That when the app closes during recording, the helper finishes the files itself and the recording is added to the project on the next launch |

The recovery scenarios record into a project folder in the temporary folder (`recordings/projects/…`) and run exactly the code the app runs on launch (`ProjectStore` + `recoverAbandoned`). The result is under `recovery.checks`. A `recording.json` is also written in the recovered folder; `MOMOTOMBO_REAL_RECORDING_DIR=<that folder> pnpm smoke` opens the recovered recording in the editor and exports it.

The click scenario waits for you to click the target with the yellow frame in the pattern, in order (at most 10 minutes).

## Privacy

- Recordings are written to the system's temporary folder and are **not copied into the repository**. The camera and microphone may contain real picture and sound. Only the measured numbers go into the repository.
- **Region recording** records whatever is on screen in that area. If the computer is used during the test, content outside the pattern may get into the recording. This is why the long and crash scenarios use **window recording** (only the test window is recorded). Run the region scenario while the computer is idle.
- The analysis does not open frames as images; it only measures the brightness of certain regions.

## Giving the smoke test a real recording

```bash
MOMOTOMBO_REAL_RECORDING_DIR=<scenario folder> pnpm smoke
```

The `recording.json` and the files in the folder are copied into a temporary project. The editor opens, zoom suggestions from the real clicks are checked, dynamic camera movement and a privacy area are added, and it is exported as MP4. No screenshot is taken in this step.

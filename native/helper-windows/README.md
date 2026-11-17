# Momotombo Windows helper

A small program Momotombo uses on Windows. It has three jobs:

- **`--input`:** Reports mouse buttons and the wheel during a screen recording (for automatic zoom). It uses Windows' low-level mouse hook (`WH_MOUSE_LL`); it does not swallow events, they pass to other apps unchanged. It does not read the keyboard, write to disk or connect to the network.
  - **`--input --window <HWND>`:** In window recording it also reads the visible frame of the recorded window (`DwmGetWindowAttribute`, `DWMWA_EXTENDED_FRAME_BOUNDS`; `GetWindowRect` as a fallback) about 30 times a second and reports it when it changes. The app writes the pointer and clicks relative to the window. Nothing else is read from the window.
- **`--extract-audio <video> <audio.wav>`:** Decodes the sound of an added video (for example AAC) with Windows' own Media Foundation decoder and writes 16-bit PCM WAV. It returns an error for sound it cannot decode; the app warns the user.
- **`--encode-mp4 <output.mp4> <width> <height> <fps> <bitrate> <audio 0|1>`:** When the graphics card has no H.264 encoder, writes the MP4 export with Windows' own Media Foundation encoders (software H.264 and AAC; Sink Writer). The app sends NV12 frames and 16-bit stereo PCM over stdin. `--encode-probe <file.mp4>` tests the same setup with a small trial. Electron's OpenH264 encoder is not used.

Output format: the comment at the top of `momotombo-win.c`.

## Build

```bash
pnpm native:win   # → native/helper-windows/bin/momotombo-win.exe (x64, unsigned)
```

It is cross-compiled on macOS or Linux with Zig's C compiler (MIT). Nothing from third parties goes into the program:

- No C runtime is linked (`-nostdlib`; the `mainCRTStartup` entry point is ours).
- No third-party header files are used (`-nostdinc`); the Windows declarations it needs are in `win-api.h`, written for this project from Microsoft's documentation and Microsoft's windows-rs bindings.
- Import libraries are generated during the build from `imports/*.def` files; these files list only the system DLL functions that are called (KERNEL32, USER32, SHELL32, ole32, dwmapi, MFPlat, MFReadWrite). The Sink Writer declarations and GUIDs are the same values that `tests/media-check/mf-check.ps1` uses on a real Windows machine.

`tools/codec-audit.mjs` checks that `resources/bin/momotombo-win.exe` in the package links only these DLLs and imports no encoder, keyboard or network functions other than `MFCreateSinkWriterFromURL` as the encoder.

**Status:** Not tested on real Windows yet.

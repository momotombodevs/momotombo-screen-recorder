# Momotombo click helper (macOS)

A small program that reports mouse clicks and scrolling to Momotombo during a screen recording. The editor uses this to suggest automatic zooms.

- **What it does:** Writes mouse button and scroll events to standard output as JSON lines (format: `Sources/main.swift`).
- **In window recording (`--window <CGWindowID>`):** Reads the bounds of the recorded window (`CGWindowListCopyWindowInfo`, `kCGWindowBounds`) about 30 times a second and reports them when they change; the app writes the pointer and clicks relative to the window. The window's title and contents are not read.
- **What it does not do:** It does not record video or sound, read the keyboard, write to disk or connect to the network.
- **Dependencies:** Only AppKit and Foundation. It contains no codecs and does not link capture or media frameworks.
- **Permission:** Watching mouse events and reading window bounds needs no extra macOS permission.

```bash
pnpm native:input   # → native/input-macos/bin/momotombo-input
```

In the app package it is `Contents/Resources/bin/momotombo-input`. `tools/codec-audit.mjs` checks that this file links only the allowed frameworks and contains no codecs.

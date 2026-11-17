# Changelog

This file lists notable changes in each Momotombo release.

## 0.1.0 — 2026-11-13

First release. macOS (Apple silicon and Intel) and Windows 10/11 x64. On Windows, the automated tests passed on GitHub's Windows machine, and the app was installed and used for recording on a real Windows PC; it has not been tried on every kind of hardware.

### Features
- Screen, camera, microphone and system audio recording on separate tracks (macOS recording helper, ScreenCaptureKit).
- Automatic zoom suggestions from clicks and pointer movement, editable by hand.
- Timeline: trim, split, insert video (MP4, MOV, WebM).
- Privacy masks: frosted glass, blur or pixelate; every exported frame goes through them.
- Magnifier: a lens that follows the pointer in selected ranges.
- Themes, backgrounds, camera layout; 16:9, 9:16, 1:1 and 4:5 formats.
- Export: MP4 (H.264 + AAC through the operating system's encoders; opens in QuickTime and Windows' player) and WebM (VP9 + Opus), 1080p or 4K, 30 or 60 fps.
- Choose the export's folder and name in the system save dialog; the last folder is remembered. Cancelling or a failure leaves no partial file.
- The computer stays awake during an export; closing the window or the app cancels it.
- Spanish and English interface (Spanish is the main language).

### Fixes
- Earlier development builds wrote VP9 + Opus as "MP4", which QuickTime and Windows' player opened as sound only. MP4 is now H.264 + AAC.

### Known limits
- With the "Fallback" (browser) recording method, system audio is not recorded and the cursor is part of the video.
- If the graphics card has no H.264 encoder: on Windows, Windows' software encoder is used (slower); otherwise the video is saved as WebM and the app says so.

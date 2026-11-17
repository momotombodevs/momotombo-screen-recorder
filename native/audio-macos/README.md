# Momotombo audio helper (macOS)

A small program that decodes the sound of a video added from the computer (for example the AAC in phone and camera videos) with macOS's own decoder (AVFoundation) and rewrites it as Opus. It is needed because the app's media library (Electron's FFmpeg build without codecs) cannot decode AAC.

- **What it does:** `momotombo-audio --extract-audio <video> <audio.m4a>`; it replies with a single line of JSON. It leaves Opus, MP3, FLAC and PCM sound untouched (the app plays these itself).
- **What it does not do:** It does not decode or encode video, record the screen or connect to the network.
- **Dependencies:** Only Foundation, AVFoundation, AVFAudio and CoreMedia. The audio extraction code is shared with the recording helper (`../recorder-macos/Sources/MomotomboRecorder/AudioExtract.swift`).

```bash
pnpm native:audio   # → native/audio-macos/bin/momotombo-audio
```

In the app package it is `Contents/Resources/bin/momotombo-audio`; `tools/codec-audit.mjs` checks its linked frameworks and traces of video codecs.

#!/bin/sh
# Builds the Momotombo audio helper as a universal binary (arm64 + x86_64). Foundation, AVFoundation
# and CoreMedia only; the AAC → Opus extraction code is shared with the recording helper.
# Output: bin/momotombo-audio (ad-hoc signed).
set -eu
cd "$(dirname "$0")"
MIN=13.0
OUT=bin
WORK=.build/swiftc
mkdir -p "$OUT" "$WORK"
SDK=$(xcrun --show-sdk-path)
SOURCES="Sources/main.swift Sources/Support.swift ../recorder-macos/Sources/MomotomboRecorder/AudioExtract.swift"
for ARCH in arm64 x86_64; do
  # shellcheck disable=SC2086
  swiftc -O -whole-module-optimization -swift-version 5 \
    -sdk "$SDK" -target "$ARCH-apple-macos$MIN" \
    -module-name MomotomboAudio \
    -framework AVFoundation -framework CoreMedia \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist \
    $SOURCES -o "$WORK/momotombo-audio-$ARCH"
done
lipo -create "$WORK/momotombo-audio-arm64" "$WORK/momotombo-audio-x86_64" -output "$OUT/momotombo-audio"
codesign --force --sign - --identifier dev.momotombo.recorder.audio --options runtime "$OUT/momotombo-audio"
lipo -info "$OUT/momotombo-audio"

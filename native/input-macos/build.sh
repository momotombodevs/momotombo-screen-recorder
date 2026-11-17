#!/bin/sh
# Builds the Momotombo pointer helper as a universal binary (arm64 + x86_64): mouse buttons and
# scroll only, AppKit and Foundation only (no capture or media frameworks, no codecs).
# Only the Command Line Tools are needed. Output: bin/momotombo-input (ad-hoc signed).
set -eu
cd "$(dirname "$0")"
MIN=13.0
OUT=bin
WORK=.build/swiftc
mkdir -p "$OUT" "$WORK"
SDK=$(xcrun --show-sdk-path)

for ARCH in arm64 x86_64; do
  swiftc -O -whole-module-optimization -swift-version 5 \
    -sdk "$SDK" -target "$ARCH-apple-macos$MIN" \
    -module-name MomotomboInput \
    -framework AppKit \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist \
    Sources/main.swift -o "$WORK/momotombo-input-$ARCH"
done

lipo -create "$WORK/momotombo-input-arm64" "$WORK/momotombo-input-x86_64" -output "$OUT/momotombo-input"
codesign --force --sign - --identifier dev.momotombo.recorder.input --options runtime "$OUT/momotombo-input"
lipo -info "$OUT/momotombo-input"

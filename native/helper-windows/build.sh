#!/bin/sh
# Builds the Momotombo Windows helper (x64) on macOS or Linux with Zig's C compiler (MIT).
# Nothing third-party goes into the program: no C runtime (no mingw-w64 CRT), no third-party
# headers (win-api.h holds our own declarations; -nostdinc keeps every other header out) and no
# prebuilt import libraries (they are generated here from imports/*.def, which list only the
# system DLL functions the helper calls). Output: bin/momotombo-win.exe (unsigned).
set -eu
cd "$(dirname "$0")"
# zig: $ZIG, else tools/.cache/zig/zig, else the one on PATH.
if [ -z "${ZIG:-}" ]; then
  if [ -x ../../tools/.cache/zig/zig ]; then ZIG=../../tools/.cache/zig/zig; else ZIG=zig; fi
fi
mkdir -p bin .build
LIBS=""
for def in imports/*.def; do
  lib=".build/$(basename "$def" .def).lib"
  "$ZIG" dlltool -m i386:x86-64 -d "$def" -l "$lib"
  LIBS="$LIBS $lib"
done
# shellcheck disable=SC2086
"$ZIG" cc -target x86_64-windows-gnu -O2 -Wall -Wextra -Wno-unused-parameter \
  -nostdinc -nostdlib -fno-stack-protector -mno-stack-arg-probe -fno-builtin \
  -s -Wl,--entry=mainCRTStartup -Wl,--subsystem,console \
  momotombo-win.c momotombo-win.rc -o bin/momotombo-win.exe $LIBS
rm -f bin/momotombo-win.lib bin/momotombo-win.pdb  # the linker's import library and debug file; not shipped
ls -l bin/momotombo-win.exe

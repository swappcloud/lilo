#!/bin/sh
# Rebuild the macOS wake-word helper bundle.
#
# The Tauri build does not compile Swift, so the bundle is built here and left
# in src-tauri/binaries/LiloWake.app. Generated binaries stay outside version
# control. `npm run dev` runs this when
# the bundle is missing or older than the source.
#
# It must stay a real .app: wake.rs launches it through LaunchServices so the
# helper is its own TCC "responsible process" and its own Info.plist usage
# strings apply. A bare binary gets killed by TCC instead of prompting.
#
# Always sign ad hoc. Never search the keychain or embed a personal identity.
set -eu

cd "$(dirname "$0")/.."

SRC="src-tauri/wake/lilo-wake.swift"
PLIST="src-tauri/wake/Info.plist"
APP="src-tauri/binaries/LiloWake.app"
BIN="$APP/Contents/MacOS/lilo-wake"

command -v swiftc >/dev/null || { echo "swiftc not found — install Xcode command line tools"; exit 1; }

echo "==> compiling $SRC"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$PLIST" "$APP/Contents/Info.plist"
swiftc -O -file-prefix-map "$(pwd)=/lilo-build/project" \
  -debug-prefix-map "$(pwd)=/lilo-build/project" \
  -target "${LILO_WAKE_TARGET:-arm64-apple-macos12}" -o "$BIN" "$SRC"

echo "==> signing ad-hoc"
codesign --force --sign - --identifier com.lilo.app.wake "$APP"

codesign --verify --strict "$APP" || { echo "==> the helper signature does not verify"; exit 1; }

codesign -dv "$APP" 2>&1 | sed -n '/^Signature=/p; /^TeamIdentifier=/p'
echo "==> done: $APP"

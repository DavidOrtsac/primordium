#!/usr/bin/env bash
# Prepares the Capacitor app for Android Studio:
# builds the web bundle, syncs the native projects, points Gradle at the
# Android SDK via local.properties and verifies everything compiles.
# Usage: bash mobile-build.sh [--open]
#   --open   also launch Android Studio on android/ afterwards
set -euo pipefail
cd "$(dirname "$0")"

echo "[mobile-build] building web assets into www/"
npm run build:app

echo "[mobile-build] syncing native projects"
npx cap sync

# Locate the Android SDK: env vars first, then common install paths.
SDK_DIR="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$SDK_DIR" ]; then
  for cand in "$HOME/AndroidSDK" "$HOME/Android/Sdk" "/usr/lib/android-sdk"; do
    if [ -d "$cand/platform-tools" ]; then
      SDK_DIR="$cand"
      break
    fi
  done
fi
if [ -z "$SDK_DIR" ] || [ ! -d "$SDK_DIR/platform-tools" ]; then
  echo "[mobile-build] ERROR: no Android SDK found. Set ANDROID_HOME and retry." >&2
  exit 1
fi
echo "[mobile-build] Android SDK: $SDK_DIR"
printf 'sdk.dir=%s\n' "$SDK_DIR" > android/local.properties

echo "[mobile-build] verifying Gradle build (assembleDebug)"
(cd android && ANDROID_HOME="$SDK_DIR" ANDROID_SDK_ROOT="$SDK_DIR" bash gradlew assembleDebug --console=plain)

echo "[mobile-build] done — open the project in Android Studio:"
echo "  android-studio $PWD/android"

if [ "${1:-}" = "--open" ]; then
  if command -v android-studio >/dev/null 2>&1; then
    nohup android-studio android >/dev/null 2>&1 &
    disown
    echo "[mobile-build] Android Studio starting"
  else
    echo "[mobile-build] android-studio not on PATH — open android/ manually" >&2
  fi
fi

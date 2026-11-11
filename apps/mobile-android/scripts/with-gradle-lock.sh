#!/bin/bash
# Runs one Gradle invocation under a machine-wide lock, so several agents working in the
# same project directory never run two builds at once (Gradle refuses a second build on
# the same project root while one holds its locks). An atomic mkdir is the lock; a stale
# lock older than 40 minutes is taken over. Usage, from apps/mobile-android:
#   bash scripts/with-gradle-lock.sh ./gradlew :core:contract:test
set -uo pipefail
LOCK=${CLAVE_GRADLE_LOCK:-/private/tmp/clave-native-b/gradle.lock.d}
mkdir -p "$(dirname "$LOCK")"
waited=0
while ! mkdir "$LOCK" 2>/dev/null; do
  if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +40 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null; continue; fi
  sleep 5; waited=$((waited + 5))
  if [ $waited -ge 2400 ]; then echo "with-gradle-lock: gave up after 40 min waiting for $LOCK" >&2; exit 75; fi
done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}
T=/Users/valentindosimont/.local/share/clave-native-20261109/android-toolchain
export ANDROID_HOME=${ANDROID_HOME:-$T/sdk} ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-$T/sdk} GRADLE_USER_HOME=${GRADLE_USER_HOME:-$T/gradle}
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
"$@"

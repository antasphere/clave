#!/usr/bin/env bash
# The Android companion's gate on a Linux runner, called by the mobile CI job from the
# repository root (`bash apps/mobile-android/ci.sh`); the exit code is the verdict.
#
# What it needs from the runner: a JDK 21 as JAVA_HOME (temurin on ubuntu-latest), an
# ANDROID_HOME holding the SDK command-line tools (the hosted runners do), and the
# network. It installs exactly what the project pins (the platform and the build tools
# named below, the same numbers as app/build.gradle.kts) through sdkmanager into the
# runner's own ANDROID_HOME, then runs every JVM test and assembles the debug APK. The
# instrumented tests and the fixture check need an emulator and run on a Mac by hand
# (README.md); nothing here claims them.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$HERE"

COMPILE_SDK=36
BUILD_TOOLS=36.0.0

: "${ANDROID_HOME:?ANDROID_HOME must point at an SDK root with cmdline-tools}"
SDKMANAGER=$(ls -d "$ANDROID_HOME"/cmdline-tools/*/bin/sdkmanager 2>/dev/null | sort -V | tail -1 || true)
if [ -z "$SDKMANAGER" ]; then echo "ci.sh: no sdkmanager under $ANDROID_HOME/cmdline-tools" >&2; exit 2; fi
echo "ci.sh: JAVA_HOME=${JAVA_HOME:-unset}"; java -version 2>&1 | head -1
yes | "$SDKMANAGER" --licenses > /dev/null 2>&1 || true
"$SDKMANAGER" --install "platforms;android-${COMPILE_SDK}" "build-tools;${BUILD_TOOLS}" "platform-tools" > /dev/null
echo "ci.sh: installed platforms;android-${COMPILE_SDK} build-tools;${BUILD_TOOLS}"

# The SDK root for Gradle: the runner's, through the environment (no local.properties on CI).
export ANDROID_SDK_ROOT="$ANDROID_HOME"
chmod +x ./gradlew

echo "ci.sh: JVM unit tests of every module, then the debug APK"
./gradlew --no-daemon --console=plain test assembleDebug

# The figures, from the JUnit XML, so the log carries the counts and not only a verdict.
python3 - <<'PY'
import glob, xml.etree.ElementTree as ET
tests = failures = errors = skipped = 0
for f in glob.glob('**/build/test-results/**/*.xml', recursive=True):
    r = ET.parse(f).getroot()
    tests += int(r.get('tests', 0)); failures += int(r.get('failures', 0))
    errors += int(r.get('errors', 0)); skipped += int(r.get('skipped', 0))
print(f"ci.sh: JVM tests: {tests} tests, {failures} failures, {errors} errors, {skipped} skipped")
PY
ls -la app/build/outputs/apk/debug/*.apk
echo "ci.sh: done"

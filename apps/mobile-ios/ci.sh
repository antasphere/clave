#!/usr/bin/env bash
# The native iPhone app's continuous-integration gate, run from the repository
# root by the mobile CI job on a macOS runner with Xcode 26.0.1
# (DEVELOPER_DIR set by the job). Its exit code is the verdict.
#
# Three steps: the core package's tests on the Mac (fast, no simulator), the
# app built for a simulator, and the app's host tests plus the launch smoke
# test on that simulator. The simulator is the first available iPhone of the
# newest iOS runtime the runner has; CLAVE_IOS_SIMULATOR_UDID overrides it.
# The fixture check (scripts/fixture-check.mjs) needs the repository's Bun
# and a booted simulator for minutes and stays a gate run by hand on a Mac.
set -euo pipefail

cd "$(dirname "$0")"
echo "ci: Xcode $(xcodebuild -version | tr '\n' ' ')"

echo "ci: swift test (ClaveCore)"
(cd ClaveCore && swift test 2>&1 | grep -E "error:|warning:|Executed [0-9]+ tests|failed" | tail -5; exit "${PIPESTATUS[0]}")

UDID="${CLAVE_IOS_SIMULATOR_UDID:-}"
if [ -z "$UDID" ]; then
  UDID="$(xcrun simctl list devices available -j | python3 -c '
import json, re, sys
data = json.load(sys.stdin)["devices"]
best = None
for runtime, devices in data.items():
    match = re.search(r"iOS-(\d+)-(\d+)", runtime)
    if not match:
        continue
    version = (int(match.group(1)), int(match.group(2)))
    for device in devices:
        if device.get("isAvailable") and device["name"].startswith("iPhone"):
            if best is None or version > best[0]:
                best = (version, device["udid"], device["name"], runtime)
if best is None:
    sys.exit("no available iPhone simulator")
print(best[1])
')"
fi
echo "ci: simulator $UDID"
DERIVED="${CLAVE_IOS_DERIVED_DATA:-$PWD/DerivedData}"

run_xcodebuild() {
  xcodebuild -project Clave.xcodeproj -scheme Clave \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath "$DERIVED" "$@" 2>&1 \
    | grep -E "Test Case|Test Suite|error:|\*\* (TEST|BUILD)" || true
  return "${PIPESTATUS[0]}"
}

echo "ci: xcodebuild build"
run_xcodebuild build
echo "ci: xcodebuild test (ClaveTests, ClaveUITests smoke)"
run_xcodebuild test -only-testing:ClaveTests -only-testing:ClaveUITests/ClaveUITests
echo "ci: green"

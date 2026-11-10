#!/usr/bin/env bash
# The native iPhone app's continuous-integration gate, run from the repository
# root by the mobile CI job on a macOS runner with Xcode 26.0.1
# (DEVELOPER_DIR set by the job). Its exit code is the verdict.
#
# Four steps: the core package's tests on the Mac (fast, no simulator), the
# app built for a simulator, the app's host tests plus the launch smoke test
# and the shell's flow on that simulator, and the release-binary check (a
# Release build that must carry none of the development-only code). The simulator is the first available iPhone of the
# newest iOS runtime the runner has; CLAVE_IOS_SIMULATOR_UDID overrides it.
# The fixture check (scripts/fixture-check.mjs) needs the repository's Bun
# and a booted simulator for minutes and stays a gate run by hand on a Mac.
set -euo pipefail

cd "$(dirname "$0")"
echo "ci: Xcode $(xcodebuild -version | tr '\n' ' ')"

# Each tool's own exit code is the step's verdict. The output goes to a log file
# and the lines worth reading are shown from it afterwards: a pipe into grep
# would leave the verdict to the filter, and under pipefail a `|| true` after
# the pipe resets PIPESTATUS, so a failing build used to read as a success.
step_log() { mktemp "${TMPDIR:-/tmp}/clave-ios-ci.XXXXXX"; }

echo "ci: swift test (ClaveCore)"
log="$(step_log)"
status=0
(cd ClaveCore && swift test) >"$log" 2>&1 || status=$?
grep -E "error:|warning:|Executed [0-9]+ tests|failed" "$log" | tail -5 || true
if [ "$status" -ne 0 ]; then
  echo "ci: swift test exited $status (log: $log)"
  exit "$status"
fi
rm -f "$log"

UDID="${CLAVE_IOS_SIMULATOR_UDID:-}"
if [ -z "$UDID" ]; then
  # The newest iOS runtime this Xcode's simulator SDK can run (a newer runtime a
  # later Xcode installed beside it would fail the build), its first iPhone.
  SDK="$(xcrun --sdk iphonesimulator --show-sdk-version)"
  UDID="$(xcrun simctl list devices available -j | python3 -c '
import json, re, sys
sdk = tuple(int(part) for part in sys.argv[1].split(".")[:2])
data = json.load(sys.stdin)["devices"]
best = None
for runtime, devices in data.items():
    match = re.search(r"iOS-(\d+)-(\d+)", runtime)
    if not match:
        continue
    version = (int(match.group(1)), int(match.group(2)))
    if version > sdk:
        continue
    for device in devices:
        if device.get("isAvailable") and device["name"].startswith("iPhone"):
            if best is None or version > best[0]:
                best = (version, device["udid"], device["name"], runtime)
if best is None:
    sys.exit("no available iPhone simulator on a runtime this Xcode can run")
print(best[1])
' "$SDK")"
fi
echo "ci: simulator $UDID"
DERIVED="${CLAVE_IOS_DERIVED_DATA:-$PWD/DerivedData}"

run_xcodebuild() {
  local log status=0
  log="$(step_log)"
  xcodebuild -project Clave.xcodeproj -scheme Clave \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath "$DERIVED" "$@" >"$log" 2>&1 || status=$?
  grep -E "Test Case|Test Suite|error:|\*\* (TEST|BUILD)" "$log" || true
  if [ "$status" -ne 0 ]; then
    echo "ci: xcodebuild exited $status (log: $log)"
  else
    rm -f "$log"
  fi
  return "$status"
}

echo "ci: xcodebuild build"
run_xcodebuild build
echo "ci: xcodebuild test (ClaveTests, ClaveUITests smoke)"
run_xcodebuild test -only-testing:ClaveTests -only-testing:ClaveUITests/ClaveUITests -only-testing:ClaveUITests/ShellFlowTests
echo "ci: release-binary check"
CLAVE_IOS_SIMULATOR_UDID="$UDID" CLAVE_IOS_DERIVED_DATA="$DERIVED-release-check" bash scripts/check-release-binary.sh
echo "ci: green"

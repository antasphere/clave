#!/usr/bin/env bash
# The native iPhone app's continuous-integration gate, run from the repository
# root by the mobile CI job on a macOS runner with Xcode 26.0.1
# (DEVELOPER_DIR set by the job). Its exit code is the verdict.
#
# Five steps: the core package's tests on the Mac (fast, no simulator); the app
# and both test targets built for any simulator with the job's own Xcode, which
# needs no simulator runtime; the app built for a simulator; the app's host
# tests plus the launch smoke test and the shell's flow on that simulator; and
# the release-binary check (a Release build that must carry none of the
# development-only code). The simulator is the first iPhone on the newest iOS
# that `xcodebuild -showdestinations` lists for the scheme, so the runner's own
# runtimes decide and no version is written here; CLAVE_IOS_SIMULATOR_UDID
# overrides it. A runner whose own Xcode can run no simulator (the hosted
# macos-26 image's Xcode 26.0.1 lists none of its iOS 26.2, 26.4 and 26.5
# runtimes) names an installed Xcode that can in CLAVE_IOS_SIMULATOR_DEVELOPER_DIR:
# the last three steps then run under it, its folder checked first and its
# version printed; unset, every step runs under the job's own Xcode. Nothing
# else is tried.
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
# The job's own Xcode, kept for the tools that resolve through it (python3 is one): the
# simulator steps may run under another one below.
JOB_DEVELOPER_DIR="${DEVELOPER_DIR:-}"
with_job_xcode() {
  if [ -n "$JOB_DEVELOPER_DIR" ]; then DEVELOPER_DIR="$JOB_DEVELOPER_DIR" "$@"; else env -u DEVELOPER_DIR "$@"; fi
}

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
DERIVED="${CLAVE_IOS_DERIVED_DATA:-$PWD/DerivedData}"

echo "ci: xcodebuild build-for-testing (any iOS Simulator, $(xcodebuild -version | head -n 1))"
log="$(step_log)"
status=0
xcodebuild -project Clave.xcodeproj -scheme Clave -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$DERIVED-generic" build-for-testing >"$log" 2>&1 || status=$?
grep -E "error:|\*\* (TEST BUILD|BUILD) " "$log" || true
if [ "$status" -ne 0 ]; then
  echo "ci: xcodebuild build-for-testing exited $status (log: $log)"
  exit "$status"
fi
rm -f "$log"

if [ -n "${CLAVE_IOS_SIMULATOR_DEVELOPER_DIR:-}" ]; then
  if [ ! -x "$CLAVE_IOS_SIMULATOR_DEVELOPER_DIR/usr/bin/xcodebuild" ]; then
    echo "ci: CLAVE_IOS_SIMULATOR_DEVELOPER_DIR holds no Xcode: $CLAVE_IOS_SIMULATOR_DEVELOPER_DIR"
    exit 1
  fi
  export DEVELOPER_DIR="$CLAVE_IOS_SIMULATOR_DEVELOPER_DIR"
  echo "ci: the simulator steps run under $(xcodebuild -version | head -n 1) (CLAVE_IOS_SIMULATOR_DEVELOPER_DIR)"
fi

UDID="${CLAVE_IOS_SIMULATOR_UDID:-}"
if [ -z "$UDID" ]; then
  # Xcode names the destinations it can build and test the scheme on; a runtime
  # it cannot use is listed under "Ineligible destinations", or not at all. The
  # pick reads only the available ones: the first iPhone on the newest iOS, never
  # a placeholder such as "Any iOS Simulator Device".
  # The listing and the runtimes simctl knows are kept under build/reports, which
  # the mobile CI job uploads, and printed when no simulator is picked: a pick
  # that finds none must leave the runner's own answer to read.
  reports="$PWD/build/reports"
  mkdir -p "$reports"
  log="$(step_log)"
  status=0
  xcodebuild -project Clave.xcodeproj -scheme Clave -showdestinations >"$log" 2>&1 || status=$?
  cp "$log" "$reports/showdestinations.txt"
  xcrun simctl list runtimes >"$reports/simctl-runtimes.txt" 2>&1 || true
  if [ "$status" -ne 0 ]; then
    tail -5 "$log"
    echo "ci: xcodebuild -showdestinations exited $status (kept in build/reports/showdestinations.txt)"
    exit "$status"
  fi
  status=0
  UDID="$(with_job_xcode python3 -c '
import re, sys
best = None
available = False
with open(sys.argv[1], encoding="utf-8", errors="replace") as listing:
    for line in listing:
        if "Available destinations for" in line:
            available = True
            continue
        if "Ineligible destinations for" in line:
            available = False
            continue
        if not available or "platform:iOS Simulator," not in line:
            continue
        ident = re.search(r"\bid:([^,}\s]+)", line)
        system = re.search(r"\bOS:(\d+(?:\.\d+)*)", line)
        name = re.search(r"\bname:(.*?)\s*\}\s*$", line)
        if not (ident and system and name) or "placeholder" in ident.group(1):
            continue
        if not name.group(1).startswith("iPhone"):
            continue
        version = tuple(int(part) for part in system.group(1).split("."))
        if best is None or version > best[0]:
            best = (version, ident.group(1), name.group(1), system.group(1))
if best is None:
    sys.exit("ci: no iPhone simulator among the destinations xcodebuild lists for the Clave scheme")
sys.stderr.write("ci: picked %s, iOS %s\n" % (best[2], best[3]))
print(best[1])
' "$log")" || status=$?
  if [ "$status" -ne 0 ]; then
    echo "ci: what xcodebuild listed for the scheme (kept in build/reports/showdestinations.txt):"
    grep -E "destinations for|platform:iOS Simulator" "$log" | head -n 60 | sed -E 's/^[[:space:]]+//; s/^/ci: listed: /' || true
    echo "ci: the simulator runtimes simctl lists (kept in build/reports/simctl-runtimes.txt):"
    head -n 20 "$reports/simctl-runtimes.txt" | sed -E 's/^/ci: runtime: /' || true
    exit "$status"
  fi
  rm -f "$log"
fi
echo "ci: simulator $UDID"

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

#!/usr/bin/env bash
# The native iPhone app's continuous-integration gate, run from the repository
# root by the mobile CI job on a macOS runner with Xcode 26.0.1
# (DEVELOPER_DIR set by the job). Its exit code is the verdict.
#
# Four steps: the core package's tests on the Mac (fast, no simulator); the app
# built for a simulator; the app's host tests plus the launch smoke test and the
# shell's flow on that simulator; and the release-binary check (a Release build that must carry none of the
# development-only code). The simulator is the first iPhone on the newest iOS
# that `xcodebuild -showdestinations` lists for the scheme, so the runner's own
# runtimes decide and no version is written here; when it lists none, the gate
# makes one for the run on the installed runtime of the simulator SDK and
# deletes it on exit; CLAVE_IOS_SIMULATOR_UDID overrides both. A runner whose
# own Xcode has no simulator runtime of its SDK
# (the hosted macos-26 image's Xcode 26.0.1 beside the iOS 26.2, 26.4 and 26.5
# runtimes: it lists no simulator, and its asset catalog compiler refuses to
# build the app for any platform without that runtime) names an installed Xcode
# that has one in CLAVE_IOS_SIMULATOR_DEVELOPER_DIR: every xcodebuild step then
# runs under it, its folder checked first and its version printed, and the job's
# own Xcode keeps the core package's tests; unset, every step runs under the
# job's own Xcode. Nothing else is tried.
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

if [ -n "${CLAVE_IOS_SIMULATOR_DEVELOPER_DIR:-}" ]; then
  if [ ! -x "$CLAVE_IOS_SIMULATOR_DEVELOPER_DIR/usr/bin/xcodebuild" ]; then
    echo "ci: CLAVE_IOS_SIMULATOR_DEVELOPER_DIR holds no Xcode: $CLAVE_IOS_SIMULATOR_DEVELOPER_DIR"
    exit 1
  fi
  export DEVELOPER_DIR="$CLAVE_IOS_SIMULATOR_DEVELOPER_DIR"
  echo "ci: the simulator steps run under $(xcodebuild -version | sed -n 1p) (CLAVE_IOS_SIMULATOR_DEVELOPER_DIR)"
fi

UDID="${CLAVE_IOS_SIMULATOR_UDID:-}"
if [ -z "$UDID" ]; then
  # Xcode names the destinations it can build and test the scheme on; a runtime
  # it cannot use is listed under "Ineligible destinations", or not at all. The
  # pick reads only the available ones: the first iPhone on the newest iOS, never
  # a placeholder such as "Any iOS Simulator Device".
  # The runner's inventory (the devices, device types and runtimes simctl knows,
  # the Xcode and its SDKs) and the listing are kept under build/reports, which
  # the mobile CI job uploads, and printed when no simulator is picked: a pick
  # that finds none must leave the runner's own answer to read.
  # An installed runtime is not a created device. When the listing offers no
  # iPhone, the gate makes one of its own on the installed iOS runtime of the
  # simulator SDK, checks that the scheme lists it, runs on it and deletes it on
  # every exit: one at most, and no other device is ever deleted.
  reports="$PWD/build/reports"
  mkdir -p "$reports"
  xcrun simctl list devices --json >"$reports/simctl-devices.json" || true
  xcrun simctl list devicetypes --json >"$reports/simctl-devicetypes.json" || true
  xcrun simctl list runtimes --json >"$reports/simctl-runtimes.json" || true
  xcrun simctl list runtimes >"$reports/simctl-runtimes.txt" 2>&1 || true
  xcodebuild -version >"$reports/xcode.txt" 2>&1 || true
  xcodebuild -showsdks >>"$reports/xcode.txt" 2>&1 || true

  # Prints the UDID of the first iPhone on the newest iOS among a listing's available
  # destinations, or fails with a sentence.
  pick_iphone() {
    with_job_xcode python3 -c '
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
' "$1"
  }
  # Succeeds when a listing's available destinations hold an iOS Simulator line with that id.
  lists_simulator() {
    with_job_xcode python3 -c '
import re, sys
available = False
with open(sys.argv[1], encoding="utf-8", errors="replace") as listing:
    for line in listing:
        if "Available destinations for" in line:
            available = True
        elif "Ineligible destinations for" in line:
            available = False
        elif available and "platform:iOS Simulator," in line:
            ident = re.search(r"\bid:([^,}\s]+)", line)
            if ident and ident.group(1) == sys.argv[2]:
                sys.exit(0)
sys.exit(1)
' "$1" "$2"
  }
  print_listing() {  # the listing, the name it is kept under in build/reports
    echo "ci: what xcodebuild listed for the scheme (kept in build/reports/$2):"
    grep -E "destinations for|platform:iOS Simulator" "$1" | head -n 60 | sed -E 's/^[[:space:]]+//; s/^/ci: listed: /' || true
  }
  # What the runner holds, printed when no simulator was picked and none was made.
  print_inventory() {
    print_listing "$log" showdestinations.txt
    echo "ci: the simulator runtimes simctl lists (kept in build/reports/simctl-runtimes.txt):"
    head -n 20 "$reports/simctl-runtimes.txt" | sed -E 's/^/ci: runtime: /' || true
    echo "ci: the iOS simulators simctl lists (kept in build/reports/simctl-devices.json):"
    with_job_xcode python3 -c '
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as kept:
        devices = json.load(kept)["devices"]
except (OSError, ValueError, KeyError, TypeError):
    sys.exit("ci: device: none read from build/reports/simctl-devices.json")
lines = ["ci: device: %s %s %s" % (device.get("name"), device.get("udid"), device.get("state"))
         for runtime, listed in devices.items() if ".SimRuntime.iOS-" in runtime for device in listed]
for line in lines[:20]:
    print(line)
' "$reports/simctl-devices.json" || true
  }

  log="$(step_log)"
  status=0
  xcodebuild -project Clave.xcodeproj -scheme Clave -showdestinations >"$log" 2>&1 || status=$?
  cp "$log" "$reports/showdestinations.txt"
  if [ "$status" -ne 0 ]; then
    tail -5 "$log"
    echo "ci: xcodebuild -showdestinations exited $status (kept in build/reports/showdestinations.txt)"
    exit "$status"
  fi
  status=0
  UDID="$(pick_iphone "$log")" || status=$?
  if [ "$status" -ne 0 ]; then
    # The runtime: installed, available, iOS, its version the simulator SDK's own or
    # a patch of it (26.2 or 26.2.x for the SDK 26.2); the device type: its first
    # iPhone. Nothing is made when there is none.
    sdk="$(xcrun --sdk iphonesimulator --show-sdk-version)" || sdk=""
    status=0
    choice="$(with_job_xcode python3 -c '
import json, sys
sdk = sys.argv[2]
if not sdk:
    sys.exit("ci: xcrun names no simulator SDK version, so no simulator was made")
try:
    with open(sys.argv[1], encoding="utf-8") as kept:
        runtimes = json.load(kept)["runtimes"]
except (OSError, ValueError, KeyError, TypeError):
    runtimes = []
for runtime in runtimes:
    version = str(runtime.get("version", ""))
    ios = runtime.get("platform") == "iOS" or ".SimRuntime.iOS-" in str(runtime.get("identifier", ""))
    if not (ios and runtime.get("isAvailable") is True and (version == sdk or version.startswith(sdk + "."))):
        continue
    types = runtime.get("supportedDeviceTypes") or []
    iphones = [kind for kind in types if kind.get("productFamily") == "iPhone"]
    iphones = iphones or [kind for kind in types if str(kind.get("name", "")).startswith("iPhone")]
    if iphones:
        print("\t".join((runtime["identifier"], version, iphones[0]["identifier"], iphones[0]["name"])))
        sys.exit(0)
sys.exit("ci: no installed iOS runtime matches the simulator SDK %s, so no simulator was made" % sdk)
' "$reports/simctl-runtimes.json" "$sdk")" || status=$?
    if [ "$status" -ne 0 ]; then
      print_inventory
      exit "$status"
    fi
    IFS=$'\t' read -r made_runtime made_version made_type made_type_name <<<"$choice"
    made_name="clave-ci-$(date +%s)-$$"
    status=0
    OWNED_UDID="$(xcrun simctl create "$made_name" "$made_type" "$made_runtime")" || status=$?
    if [ "$status" -ne 0 ] || [ -z "$OWNED_UDID" ]; then
      print_inventory
      echo "ci: xcrun simctl create exited $status and named no simulator, so none was made"
      exit 1
    fi
    # From here every exit deletes the simulator this run made, and that one alone. The
    # verdict stays the gate's: a delete that fails is said, not turned into a failure.
    delete_owned() {
      if xcrun simctl delete "$OWNED_UDID"; then
        echo "ci: deleted simulator $OWNED_UDID, made for this run"
      else
        echo "ci: the simulator made for this run, $OWNED_UDID, could not be deleted"
      fi
    }
    trap delete_owned EXIT
    echo "ci: made simulator $made_name $OWNED_UDID ($made_type_name, iOS $made_version) for this run"
    # The scheme must offer it before anything is built for it.
    made_log="$reports/showdestinations-made.txt"
    status=0
    xcodebuild -project Clave.xcodeproj -scheme Clave -showdestinations >"$made_log" 2>&1 || status=$?
    if [ "$status" -ne 0 ]; then
      tail -5 "$made_log"
      echo "ci: xcodebuild -showdestinations exited $status (kept in build/reports/showdestinations-made.txt)"
      exit "$status"
    fi
    if ! lists_simulator "$made_log" "$OWNED_UDID"; then
      print_listing "$made_log" showdestinations-made.txt
      echo "ci: the simulator made for this run, $OWNED_UDID, is not among the scheme's destinations"
      exit 1
    fi
    UDID="$OWNED_UDID"
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

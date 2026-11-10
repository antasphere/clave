#!/usr/bin/env bash
# Proves that ci.sh's verdict follows its steps: it must exit non-zero, and
# never print "ci: green", when the core's tests, the simulator build, the
# simulator tests or the release-binary check fail, and exit 0 when all pass.
#
# ci.sh is copied into a scratch folder and run there with stand-ins for
# swift, xcodebuild and xcrun first on the PATH; no build runs, no simulator is
# touched, nothing is left behind. Three kinds of scenario:
#   - each step made to fail in turn, with a stand-in for the release check;
#   - the REAL release check (scripts/check-release-binary.sh) reading the
#     binaries the xcodebuild stand-in writes: a clean Release output (green), a
#     Release output carrying a development-only marker (red), no Release
#     output at all (red), a Release carrying the Debug build's identifier (red);
#   - the simulator pick a runner makes when CLAVE_IOS_SIMULATOR_UDID is unset,
#     read from the destinations the xcodebuild stand-in lists in the shape of
#     the hosted macos-26 runner as reported on 10 November 2026 (Xcode 26.0.1,
#     whose simulator SDK is 26.0, beside the iOS 26.2, 26.4 and 26.5 runtimes
#     only): no iPhone among them
#     (red); the first iPhone on the newest iOS picked, past an ineligible one
#     (green, that device named); the listing itself failing (red).
#
#   bash scripts/prove-ci-gate.sh                          # proves ./ci.sh and ./scripts/check-release-binary.sh
#   bash scripts/prove-ci-gate.sh --against <ci copy>      # the scenarios on another copy of ci.sh
#   bash scripts/prove-ci-gate.sh --release-check <copy>   # the real-check scenarios on another copy of the check
#
# Run from apps/mobile-ios. Exits 0 when every scenario gives the expected
# verdict, 1 otherwise.
set -uo pipefail

cd "$(dirname "$0")/.."
target="ci.sh"
check="scripts/check-release-binary.sh"
while [ $# -gt 0 ]; do
  case "$1" in
    --against) target="${2:?--against needs a file}"; shift 2 ;;
    --release-check) check="${2:?--release-check needs a file}"; shift 2 ;;
    *) echo "FAIL unknown argument $1"; exit 1 ;;
  esac
done
[ -f "$target" ] || { echo "FAIL no ci script at $target"; exit 1; }
[ -f "$check" ] || { echo "FAIL no release check at $check"; exit 1; }

sandbox="$(mktemp -d "${TMPDIR:-/tmp}/clave-ios-ci-proof.XXXXXX")"
trap 'rm -rf "$sandbox"' EXIT
mkdir -p "$sandbox/run/ClaveCore" "$sandbox/run/scripts" "$sandbox/bin" "$sandbox/tmp"
cp "$target" "$sandbox/run/ci.sh"

# Every file here is written with printf: a heredoc over 512 bytes can hang bash 5.2 on a Mac
# whose pipes are at their minimum size (seen on 9 November 2026), since bash fills the pipe
# before the reader starts.
printf '%s\n' '#!/bin/bash' \
  'if [ "$CI_PROOF_FAIL" = swift ]; then echo "error: a stand-in failure"; exit 1; fi' \
  'echo "Executed 312 tests, with 0 failures (0 unexpected)"' >"$sandbox/bin/swift"

# The xcodebuild stand-in fails the step it is told to, and, for the real release check,
# writes the binaries a build would: Debug with every development-only marker in its debug
# dylib, Release clean, carrying a marker, or absent, as CI_PROOF_RELEASE says.
printf '%s\n' '#!/bin/bash' \
  'if [ "$1" = "-version" ]; then' \
  '  if [ -n "$CI_PROOF_SIM_DEVDIR" ] && [ "$DEVELOPER_DIR" = "$CI_PROOF_SIM_DEVDIR" ]; then printf "Xcode 26.2\nBuild version 17C52\n"' \
  '  else printf "Xcode 26.0.1\nBuild version 17A400\n"; fi' \
  '  exit 0' \
  'fi' \
  'conf=Debug; derived=""; action=""' \
  'while [ $# -gt 0 ]; do' \
  '  case "$1" in' \
  '    -configuration) conf="$2"; shift 2; continue ;;' \
  '    -derivedDataPath) derived="$2"; shift 2; continue ;;' \
  '    build-for-testing) action=build-for-testing ;;' \
  '    build|test) action="$1" ;;' \
  '    -showdestinations) action=showdestinations ;;' \
  '  esac' \
  '  shift' \
  'done' \
  'if [ -n "$CI_PROOF_TRACE" ]; then echo "$action ${DEVELOPER_DIR:-unset}" >>"$CI_PROOF_TRACE"; fi' \
  'case "$action" in' \
  '  showdestinations)' \
  '    if [ "$CI_PROOF_LISTING" = fail ]; then echo "xcodebuild: error: a stand-in failure"; exit 70; fi' \
  '    if [ -n "$CI_PROOF_JOB_DESTINATIONS" ] && [ "$DEVELOPER_DIR" != "$CI_PROOF_SIM_DEVDIR" ]; then cat "$CI_PROOF_JOB_DESTINATIONS"; else cat "$CI_PROOF_DESTINATIONS"; fi' \
  '    exit 0 ;;' \
  '  build-for-testing)' \
  '    if [ "$CI_PROOF_FAIL" = generic ]; then echo "** TEST BUILD FAILED **"; exit 65; fi' \
  '    echo "** TEST BUILD SUCCEEDED **"; exit 0 ;;' \
  '  build)' \
  '    if [ "$CI_PROOF_FAIL" = build ]; then echo "** BUILD FAILED **"; exit 65; fi' \
  '    if [ -n "$CI_PROOF_RELEASE" ] && [ -n "$derived" ]; then' \
  '      app="$derived/Build/Products/$conf-iphonesimulator/Clave.app"' \
  '      plist() { printf "%s\n" "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" "<plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>$1</string></dict></plist>" >"$app/Info.plist"; }' \
  '      if [ "$conf" = Debug ]; then' \
  '        mkdir -p "$app"; printf "stub debug binary\n" >"$app/Clave"; plist com.clave.ios.dev' \
  '        printf "%s\n" UITestFake CLAVE_IOS_ISSUER DeveloperConnectionSection "Add the developer server" --ui-test-fake CLAVE_IOS_RELAY developer.add >"$app/Clave.debug.dylib"' \
  '      elif [ "$CI_PROOF_RELEASE" = clean ]; then' \
  '        mkdir -p "$app"; printf "stub release binary\n" >"$app/Clave"; plist com.clave.ios' \
  '      elif [ "$CI_PROOF_RELEASE" = marker ]; then' \
  '        mkdir -p "$app"; printf "stub release binary\nUITestFake\n" >"$app/Clave"; plist com.clave.ios' \
  '      elif [ "$CI_PROOF_RELEASE" = shared ]; then' \
  '        mkdir -p "$app"; printf "stub release binary\n" >"$app/Clave"; plist com.clave.ios.dev' \
  '      fi' \
  '    fi' \
  '    echo "** BUILD SUCCEEDED **"; exit 0 ;;' \
  '  test)' \
  '    if [ "$CI_PROOF_FAIL" = test ]; then echo "Test Case stand-in failed"; echo "** TEST FAILED **"; exit 65; fi' \
  '    echo "Test Suite All tests passed"; echo "** TEST SUCCEEDED **"; exit 0 ;;' \
  'esac' \
  'echo "stand-in xcodebuild: no action among the arguments"' \
  'exit 64' >"$sandbox/bin/xcodebuild"

# The xcrun stand-in answers the simulator SDK's version and the device list as the runner
# would. ci.sh's pick no longer asks either; a copy given with --against that still does
# meets the runner's shape here, never this Mac's devices. Anything else goes to the real xcrun.
printf '%s\n' '#!/bin/bash' \
  'if [ "$1" = "--sdk" ] && [ "$3" = "--show-sdk-version" ]; then echo "26.0"; exit 0; fi' \
  'if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "runtimes" ]; then printf "%s\n" "== Runtimes ==" "iOS 26.2 (26.2 - STAND-IN) - com.apple.CoreSimulator.SimRuntime.iOS-26-2" "iOS 26.5 (26.5 - STAND-IN) - com.apple.CoreSimulator.SimRuntime.iOS-26-5"; exit 0; fi' \
  'if [ "$1" = "simctl" ] && [ "$2" = "list" ]; then cat "$CI_PROOF_DEVICES"; exit 0; fi' \
  'exec /usr/bin/xcrun "$@"' >"$sandbox/bin/xcrun"

printf '%s\n' '#!/bin/bash' \
  'if [ "$CI_PROOF_FAIL" = release ]; then echo "FAIL release has UITestFake"; exit 1; fi' \
  'echo "PASS release binary check"' >"$sandbox/stand-in-check.sh"

# The hosted macos-26 runner as reported on 10 November 2026: Xcode 26.0.1 (simulator SDK 26.0) beside the iOS 26.2, 26.4 and
# 26.5 runtimes only, as simctl would list them.
printf '%s\n' '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-2":[{"udid":"OLD-2620","name":"iPhone 16e","isAvailable":true}],"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[{"udid":"MID-2640","name":"iPhone Air","isAvailable":true}],"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{"udid":"PICK-2650","name":"iPhone 17 Pro","isAvailable":true}]}}' \
  >"$sandbox/devices-runner.json"

# What `xcodebuild -showdestinations` prints: the file, the available destinations, then
# after "--" the ineligible ones, each line in xcodebuild's own shape.
listing() {
  local file="$1"
  shift
  printf '\t%s\n' 'Available destinations for the "Clave" scheme:' >"$file"
  for entry in "$@"; do
    if [ "$entry" = -- ]; then
      printf '\n\t%s\n' 'Ineligible destinations for the "Clave" scheme:' >>"$file"
    else
      printf '\t\t{ %s }\n' "$entry" >>"$file"
    fi
  done
}
mac='platform:macOS, arch:arm64, variant:Designed for [iPad,iPhone], id:00006021-STAND-IN, name:My Mac'
any_device='platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device'
any_simulator='platform:iOS Simulator, id:dvtdevice-DVTiOSDeviceSimulatorPlaceholder-iphonesimulator:placeholder, name:Any iOS Simulator Device'
ipad='platform:iOS Simulator, arch:arm64, id:IPAD-2650, OS:26.5, name:iPad Pro 13-inch (M4)'
listing "$sandbox/destinations-runner.txt" "$mac" "$any_device" "$any_simulator" "$ipad" \
  'platform:iOS Simulator, arch:arm64, id:OLD-2620, OS:26.2, name:iPhone 16e' \
  'platform:iOS Simulator, arch:arm64, id:PICK-2650, OS:26.5, name:iPhone 17 Pro' \
  'platform:iOS Simulator, arch:arm64, id:LATER-2650, OS:26.5, name:iPhone 17' \
  'platform:iOS Simulator, arch:arm64, id:MID-2640, OS:26.4, name:iPhone Air' \
  -- 'platform:iOS Simulator, arch:arm64, id:INELIGIBLE-2700, OS:27.0, name:iPhone 18 Pro, error:iOS 27.0 is not supported by this Xcode'
listing "$sandbox/destinations-no-iphone.txt" "$mac" "$any_device" "$any_simulator" "$ipad" \
  -- 'platform:iOS Simulator, arch:arm64, id:INELIGIBLE-2650, OS:26.5, name:iPhone 17 Pro, error:iOS 26.5 is not supported by this Xcode'
# The hosted macos-26 runner as its own run of 10 November 2026 (run 42892565953) listed the
# scheme's destinations under the job's Xcode 26.0.1: the Mac and the two placeholders, no
# simulator and no ineligible one (the runner Mac's id replaced). Two toolchain folders stand
# for the job's Xcode and for an installed Xcode that can run the runner's simulators.
listing "$sandbox/destinations-hosted-20261110.txt" \
  'platform:macOS, arch:arm64, variant:Designed for [iPad,iPhone], id:RUNNER-MAC, name:My Mac' "$any_device" "$any_simulator"
mkdir -p "$sandbox/xcode-26.0.1/usr/bin" "$sandbox/xcode-26.2/usr/bin"
printf '%s\n' '#!/bin/bash' 'exit 64' >"$sandbox/xcode-26.0.1/usr/bin/xcodebuild"
printf '%s\n' '#!/bin/bash' 'exit 64' >"$sandbox/xcode-26.2/usr/bin/xcodebuild"
chmod +x "$sandbox/xcode-26.0.1/usr/bin/xcodebuild" "$sandbox/xcode-26.2/usr/bin/xcodebuild"
chmod +x "$sandbox/bin/swift" "$sandbox/bin/xcodebuild" "$sandbox/bin/xcrun" "$sandbox/stand-in-check.sh"

failed=0
output=""
code=0

# Runs ci.sh once: the release check to use (stand-in or real), the simulator's id (empty to
# leave it unset, as on a runner), then the scenario's own variables.
run_ci() {
  local which="$1" udid="$2"
  shift 2
  rm -rf "$sandbox/run/DerivedData" "$sandbox/run/DerivedData-release-check"
  if [ "$which" = real ]; then
    cp "$check" "$sandbox/run/scripts/check-release-binary.sh"
  else
    cp "$sandbox/stand-in-check.sh" "$sandbox/run/scripts/check-release-binary.sh"
  fi
  local -a vars
  vars=(HOME="$sandbox/tmp" TMPDIR="$sandbox/tmp" PATH="$sandbox/bin:/usr/bin:/bin" "$@")
  if [ -n "$udid" ]; then vars+=(CLAVE_IOS_SIMULATOR_UDID="$udid"); fi
  output="$(env -i "${vars[@]}" bash "$sandbox/run/ci.sh" 2>&1)"
  code=$?
}

# Judges the last run: the scenario's name, pass or fail, and a line the output must hold.
# A pattern match rather than a here-string into grep: no pipe for bash to fill (see above).
judge() {
  local name="$1" want="$2" line="${3:-}" green=no seen=yes
  [[ $'\n'"$output"$'\n' == *$'\n'"ci: green"$'\n'* ]] && green=yes
  if [ -n "$line" ]; then
    [[ $'\n'"$output"$'\n' == *$'\n'"$line"$'\n'* ]] || seen=no
  fi
  local said=""
  [ -n "$line" ] && said=", \"$line\" printed: $seen"
  if [ "$want" = pass ] && [ "$code" -eq 0 ] && [ "$green" = yes ] && [ "$seen" = yes ]; then
    echo "PASS $name: exit 0, ci: green$said"
  elif [ "$want" = fail ] && [ "$code" -ne 0 ] && [ "$green" = no ] && [ "$seen" = yes ]; then
    echo "PASS $name: exit $code, no ci: green$said"
  else
    echo "FAIL $name: exit $code, ci: green printed: $green$said (expected $want)"
    failed=1
  fi
}

udid=00000000-0000-0000-0000-000000000000

run_ci stand-in "$udid" CI_PROOF_FAIL=
judge "all steps pass" pass
run_ci stand-in "$udid" CI_PROOF_FAIL=swift
judge "the core's tests fail" fail
run_ci stand-in "$udid" CI_PROOF_FAIL=build
judge "the build fails" fail
run_ci stand-in "$udid" CI_PROOF_FAIL=test
judge "the tests fail" fail
run_ci stand-in "$udid" CI_PROOF_FAIL=release
judge "the release check fails" fail

run_ci real "$udid" CI_PROOF_FAIL= CI_PROOF_RELEASE=clean
judge "the real release check on a clean Release output" pass "PASS release binary check"
run_ci real "$udid" CI_PROOF_FAIL= CI_PROOF_RELEASE=marker
judge "the real release check on a Release output carrying UITestFake" fail "FAIL release has UITestFake"
run_ci real "$udid" CI_PROOF_FAIL= CI_PROOF_RELEASE=missing
judge "the real release check with no Release output" fail "FAIL release binary check: the Release binary could not be read"
run_ci real "$udid" CI_PROOF_FAIL= CI_PROOF_RELEASE=shared
judge "the real release check on a Release sharing the Debug identifier" fail "FAIL release is 'com.clave.ios.dev', not com.clave.ios"

runner=(CI_PROOF_FAIL= CI_PROOF_DEVICES="$sandbox/devices-runner.json")
rm -rf "$sandbox/run/build"
run_ci stand-in "" "${runner[@]}" CI_PROOF_DESTINATIONS="$sandbox/destinations-no-iphone.txt"
judge "a runner whose Xcode lists no iPhone simulator" fail "ci: no iPhone simulator among the destinations xcodebuild lists for the Clave scheme"
judge "the same run prints the listing it judged" fail "ci: listed: { platform:iOS Simulator, arch:arm64, id:INELIGIBLE-2650, OS:26.5, name:iPhone 17 Pro, error:iOS 26.5 is not supported by this Xcode }"
judge "the same run prints the runtimes simctl lists" fail "ci: runtime: iOS 26.5 (26.5 - STAND-IN) - com.apple.CoreSimulator.SimRuntime.iOS-26-5"
# The listing the job uploads: kept under build/reports, byte for byte what xcodebuild printed.
if cmp -s "$sandbox/destinations-no-iphone.txt" "$sandbox/run/build/reports/showdestinations.txt"; then
  echo "PASS the same run keeps the listing under build/reports for the job to upload"
else
  echo "FAIL the same run keeps no build/reports/showdestinations.txt equal to what xcodebuild printed"
  failed=1
fi
run_ci stand-in "" "${runner[@]}" CI_PROOF_DESTINATIONS="$sandbox/destinations-runner.txt"
judge "the hosted runner, Xcode 26.0.1 beside iOS 26.2, 26.4 and 26.5 only" pass "ci: simulator PICK-2650"
run_ci stand-in "" "${runner[@]}" CI_PROOF_DESTINATIONS="$sandbox/destinations-runner.txt" CI_PROOF_LISTING=fail
judge "a runner whose destinations cannot be listed" fail "xcodebuild: error: a stand-in failure"

# Two toolchains. The trace names each xcodebuild action with the Xcode it ran under.
trace="$sandbox/trace.txt"
trace_says() {  # the scenario, the first line wanted, the Xcode every later line must name
  local name="$1" first="$2" later="$3"
  if [ "$(sed -n 1p "$trace")" = "$first" ] && [ "$(wc -l <"$trace" | tr -d ' ')" -ge 4 ] \
    && [ "$(sed -n '2,$p' "$trace" | grep -vc " $later\$")" = 0 ]; then
    echo "PASS $name"
  else
    echo "FAIL $name: the trace reads $(tr '\n' ';' <"$trace")"
    failed=1
  fi
}
# The job's own Xcode is DEVELOPER_DIR unset here, as on a Mac whose selected Xcode is the job's:
# a folder standing for it would also stand between /usr/bin/python3 and its interpreter.
job=(CI_PROOF_FAIL= CI_PROOF_DEVICES="$sandbox/devices-runner.json"
  CI_PROOF_SIM_DEVDIR="$sandbox/xcode-26.2" CI_PROOF_DESTINATIONS="$sandbox/destinations-runner.txt")
: >"$trace"
run_ci stand-in "" "${job[@]}" CI_PROOF_TRACE="$trace"
judge "no simulator Xcode named: every step under the job's own Xcode, as before" pass "ci: simulator PICK-2650"
trace_says "the same run's trace: the job's Xcode for the build for any simulator and for every simulator step" \
  "build-for-testing unset" "unset"
if [[ $'\n'"$output"$'\n' == *$'\n'"ci: the simulator steps run under "* ]]; then
  echo "FAIL the same run names another Xcode though none was named"; failed=1
else
  echo "PASS the same run names no other Xcode"
fi
hosted=("${job[@]}" CI_PROOF_JOB_DESTINATIONS="$sandbox/destinations-hosted-20261110.txt")
run_ci stand-in "" "${hosted[@]}"
judge "the hosted runner as its run of 10 November listed it, no simulator Xcode named" fail "ci: no iPhone simulator among the destinations xcodebuild lists for the Clave scheme"
: >"$trace"
run_ci stand-in "" "${hosted[@]}" CLAVE_IOS_SIMULATOR_DEVELOPER_DIR="$sandbox/xcode-26.2" CI_PROOF_TRACE="$trace"
judge "the same runner with an installed simulator Xcode named" pass "ci: the simulator steps run under Xcode 26.2 (CLAVE_IOS_SIMULATOR_DEVELOPER_DIR)"
trace_says "the same run's trace: the build for any simulator under the job's Xcode 26.0.1, the pick, build and tests under the named one" \
  "build-for-testing unset" "$sandbox/xcode-26.2"
run_ci stand-in "" "${hosted[@]}" CLAVE_IOS_SIMULATOR_DEVELOPER_DIR="$sandbox/no-such-xcode"
judge "a named simulator Xcode folder that is not there" fail "ci: CLAVE_IOS_SIMULATOR_DEVELOPER_DIR holds no Xcode: $sandbox/no-such-xcode"
run_ci stand-in "" "${hosted[@]}" CLAVE_IOS_SIMULATOR_DEVELOPER_DIR="$sandbox/tmp"
judge "a named folder that holds no Xcode" fail "ci: CLAVE_IOS_SIMULATOR_DEVELOPER_DIR holds no Xcode: $sandbox/tmp"
run_ci stand-in "$udid" CI_PROOF_FAIL=generic
judge "the build for any simulator fails" fail "** TEST BUILD FAILED **"

if [ "$failed" -eq 0 ]; then
  echo "PASS ci gate proof: $target follows each step, with $check read for real"
  exit 0
fi
echo "FAIL ci gate proof: $target or $check does not follow its steps"
exit 1

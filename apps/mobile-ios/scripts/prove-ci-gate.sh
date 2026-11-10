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
#   - the simulator pick a runner makes when CLAVE_IOS_SIMULATOR_UDID is unset:
#     no iPhone at all (red), and a runtime newer than this Xcode's simulator
#     SDK skipped for the newest one it can run (green, that device named).
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
  'if [ "$1" = "-version" ]; then printf "Xcode 26.0.1\nBuild version 17A400\n"; exit 0; fi' \
  'conf=Debug; derived=""; action=""' \
  'while [ $# -gt 0 ]; do' \
  '  case "$1" in' \
  '    -configuration) conf="$2"; shift 2; continue ;;' \
  '    -derivedDataPath) derived="$2"; shift 2; continue ;;' \
  '    build|test) action="$1" ;;' \
  '  esac' \
  '  shift' \
  'done' \
  'case "$action" in' \
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

# The xcrun stand-in answers the simulator SDK's version and the device list the pick reads;
# anything else goes to the real xcrun.
printf '%s\n' '#!/bin/bash' \
  'if [ "$1" = "--sdk" ] && [ "$3" = "--show-sdk-version" ]; then echo "26.0"; exit 0; fi' \
  'if [ "$1" = "simctl" ] && [ "$2" = "list" ]; then cat "$CI_PROOF_DEVICES"; exit 0; fi' \
  'exec /usr/bin/xcrun "$@"' >"$sandbox/bin/xcrun"

printf '%s\n' '#!/bin/bash' \
  'if [ "$CI_PROOF_FAIL" = release ]; then echo "FAIL release has UITestFake"; exit 1; fi' \
  'echo "PASS release binary check"' >"$sandbox/stand-in-check.sh"

printf '%s\n' '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-0":[{"udid":"IPAD-2600","name":"iPad Air 11-inch (M3)","isAvailable":true}]}}' \
  >"$sandbox/devices-no-iphone.json"
printf '%s\n' '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-5":[{"udid":"OLD-1750","name":"iPhone 15 Pro","isAvailable":true}],"com.apple.CoreSimulator.SimRuntime.iOS-26-1":[{"udid":"NEWER-2610","name":"iPhone 17","isAvailable":true}],"com.apple.CoreSimulator.SimRuntime.iOS-26-0":[{"udid":"PICK-2600","name":"iPhone 17","isAvailable":true}]}}' \
  >"$sandbox/devices-newer-runtime.json"
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

run_ci stand-in "" CI_PROOF_FAIL= CI_PROOF_DEVICES="$sandbox/devices-no-iphone.json"
judge "a runner with no iPhone simulator" fail "no available iPhone simulator on a runtime this Xcode can run"
run_ci stand-in "" CI_PROOF_FAIL= CI_PROOF_DEVICES="$sandbox/devices-newer-runtime.json"
judge "a runner with a runtime newer than its Xcode" pass "ci: simulator PICK-2600"

if [ "$failed" -eq 0 ]; then
  echo "PASS ci gate proof: $target follows each step, with $check read for real"
  exit 0
fi
echo "FAIL ci gate proof: $target or $check does not follow its steps"
exit 1

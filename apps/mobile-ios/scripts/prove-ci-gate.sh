#!/usr/bin/env bash
# Proves that ci.sh's verdict follows its steps: it must exit non-zero, and
# never print "ci: green", when the core's tests, the simulator build, the
# simulator tests or the release-binary check fail, and exit 0 when all pass.
#
# ci.sh is copied into a scratch folder and run there with stand-ins for
# swift, xcodebuild and xcrun first on the PATH; no build runs, no simulator is
# touched, nothing is left behind. Four kinds of scenario:
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
#     (green, that device named); the listing itself failing (red);
#   - the simulator the gate makes for its run when the listing offers no
#     iPhone, on the runner as its run at 5d176d40 listed it (the named Xcode
#     26.2 offering the Mac and the two placeholders only, beside the installed
#     iOS 26.2 runtime of its SDK): one iPhone made on that runtime, run on,
#     then deleted, and no other device deleted (green); no runtime of the SDK
#     installed (red, nothing made); the made one missing from the scheme's
#     destinations (red, and still deleted); the runner's inventory kept under
#     build/reports; nothing made on a runner that lists an iPhone.
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
  'if [ -n "$CI_PROOF_TRACE" ]; then echo "swift ${DEVELOPER_DIR:-unset}" >>"$CI_PROOF_TRACE"; fi' \
  'if [ "$CI_PROOF_FAIL" = swift ]; then echo "error: a stand-in failure"; exit 1; fi' \
  'echo "Executed 312 tests, with 0 failures (0 unexpected)"' >"$sandbox/bin/swift"

# The xcodebuild stand-in fails the step it is told to, and, for the real release check,
# writes the binaries a build would: Debug with every development-only marker in its debug
# dylib, Release clean, carrying a marker, or absent, as CI_PROOF_RELEASE says. Once the xcrun
# stand-in has recorded a create, the destinations it lists hold the made simulator among the
# available ones, unless CI_PROOF_MADE_UNLISTED is set.
printf '%s\n' '#!/bin/bash' \
  'if [ "$1" = "-version" ]; then' \
  '  if [ -n "$CI_PROOF_SIM_DEVDIR" ] && [ "$DEVELOPER_DIR" = "$CI_PROOF_SIM_DEVDIR" ]; then printf "Xcode 26.2\nBuild version 17C52\n"' \
  '  else printf "Xcode 26.0.1\nBuild version 17A400\n"; fi' \
  '  exit 0' \
  'fi' \
  'if [ "$1" = "-showsdks" ]; then' \
  '  if [ -n "$CI_PROOF_SIM_DEVDIR" ] && [ "$DEVELOPER_DIR" = "$CI_PROOF_SIM_DEVDIR" ]; then sdk=26.2; else sdk=26.0; fi' \
  '  printf "iOS SDKs:\n\tiOS %s\t-sdk iphoneos%s\n\niOS Simulator SDKs:\n\tSimulator - iOS %s\t-sdk iphonesimulator%s\n" "$sdk" "$sdk" "$sdk" "$sdk"' \
  '  exit 0' \
  'fi' \
  'conf=Debug; derived=""; action=""' \
  'while [ $# -gt 0 ]; do' \
  '  case "$1" in' \
  '    -configuration) conf="$2"; shift 2; continue ;;' \
  '    -derivedDataPath) derived="$2"; shift 2; continue ;;' \
  '    build|test) action="$1" ;;' \
  '    -showdestinations) action=showdestinations ;;' \
  '  esac' \
  '  shift' \
  'done' \
  'if [ -n "$CI_PROOF_TRACE" ]; then' \
  '  echo "$action ${DEVELOPER_DIR:-unset}" >>"$CI_PROOF_TRACE"' \
  'fi' \
  'case "$action" in' \
  '  showdestinations)' \
  '    if [ "$CI_PROOF_LISTING" = fail ]; then echo "xcodebuild: error: a stand-in failure"; exit 70; fi' \
  '    file="$CI_PROOF_DESTINATIONS"' \
  '    if [ -n "$CI_PROOF_JOB_DESTINATIONS" ] && [ "$DEVELOPER_DIR" != "$CI_PROOF_SIM_DEVDIR" ]; then file="$CI_PROOF_JOB_DESTINATIONS"; fi' \
  '    if [ ! -s "$CI_PROOF_CREATES" ] || [ -n "$CI_PROOF_MADE_UNLISTED" ]; then cat "$file"; exit 0; fi' \
  '    while IFS= read -r line; do' \
  '      printf "%s\n" "$line"' \
  '      case "$line" in *"Available destinations for"*) printf "\t\t%s\n" "{ platform:iOS Simulator, arch:arm64, id:MADE-2620, OS:26.2, name:clave-ci-STAND-IN }" ;; esac' \
  '    done <"$file"' \
  '    exit 0 ;;' \
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

# The xcrun stand-in answers what ci.sh asks of the runner, as the runner would: the simulator
# SDK's version (26.2 under the named Xcode, 26.0 under the job's own, as on the hosted runner),
# and simctl's device list (CI_PROOF_DEVICES), device types, runtimes in JSON (CI_PROOF_RUNTIMES)
# and as text (the .txt beside it), a create (the call recorded in CI_PROOF_CREATES, answered
# with the id MADE-2620) and a delete (its id recorded in CI_PROOF_DELETES). Each simctl call is
# traced like the xcodebuild actions. Any other simctl call is refused: this Mac's simulators are
# never listed, made, booted, erased or deleted here. Anything else goes to the real xcrun.
printf '%s\n' '#!/bin/bash' \
  'if [ "$1" = "--sdk" ] && [ "$3" = "--show-sdk-version" ]; then' \
  '  if [ -n "$CI_PROOF_SIM_DEVDIR" ] && [ "$DEVELOPER_DIR" = "$CI_PROOF_SIM_DEVDIR" ]; then echo "26.2"; else echo "26.0"; fi' \
  '  exit 0' \
  'fi' \
  'if [ "$1" != "simctl" ]; then exec /usr/bin/xcrun "$@"; fi' \
  'if [ -n "$CI_PROOF_TRACE" ]; then echo "simctl $2 ${DEVELOPER_DIR:-unset}" >>"$CI_PROOF_TRACE"; fi' \
  'if [ "$2" = list ]; then' \
  '  if [ "$3" = runtimes ] && [ "$4" = --json ]; then cat "$CI_PROOF_RUNTIMES"' \
  '  elif [ "$3" = runtimes ]; then cat "${CI_PROOF_RUNTIMES%.json}.txt"' \
  '  elif [ "$3" = devicetypes ]; then cat "$CI_PROOF_DEVICETYPES"' \
  '  else cat "$CI_PROOF_DEVICES"; fi' \
  '  exit 0' \
  'fi' \
  'if [ "$2" = create ]; then echo "$*" >>"$CI_PROOF_CREATES"; echo "MADE-2620"; exit 0; fi' \
  'if [ "$2" = delete ]; then echo "$3" >>"$CI_PROOF_DELETES"; exit 0; fi' \
  'echo "stand-in xcrun: simctl $2 is not answered here, and the real simctl is never asked"' \
  'exit 64' >"$sandbox/bin/xcrun"

printf '%s\n' '#!/bin/bash' \
  'if [ "$CI_PROOF_FAIL" = release ]; then echo "FAIL release has UITestFake"; exit 1; fi' \
  'echo "PASS release binary check"' >"$sandbox/stand-in-check.sh"

# The hosted macos-26 runner as reported on 10 November 2026: Xcode 26.0.1 (simulator SDK 26.0) beside the iOS 26.2, 26.4 and
# 26.5 runtimes only, as simctl would list them.
printf '%s\n' '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-2":[{"udid":"OLD-2620","name":"iPhone 16e","state":"Shutdown","isAvailable":true}],"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[{"udid":"MID-2640","name":"iPhone Air","state":"Shutdown","isAvailable":true}],"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{"udid":"PICK-2650","name":"iPhone 17 Pro","state":"Shutdown","isAvailable":true}]}}' \
  >"$sandbox/devices-runner.json"
# The device types and the runtimes simctl lists in JSON, in the runner's shape and trimmed to what
# the gate reads: each iOS runtime names the device types it supports, an iPad first. The runner's
# set holds the iOS 26.2 runtime of the named Xcode's SDK; the no-match set lacks it.
ipad_type='{"name":"iPad Pro 13-inch (M4)","identifier":"com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB","productFamily":"iPad"}'
iphone_types='{"name":"iPhone 17 Pro","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro","productFamily":"iPhone"},{"name":"iPhone 17","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17","productFamily":"iPhone"}'
printf '%s\n' '{"devicetypes":['"$ipad_type,$iphone_types"']}' >"$sandbox/devicetypes-runner.json"
runtime_2620='{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-2","version":"26.2","buildversion":"STAND-IN","name":"iOS 26.2","platform":"iOS","isAvailable":true,"supportedDeviceTypes":['"$ipad_type,$iphone_types"']}'
runtime_2650='{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5","version":"26.5","buildversion":"STAND-IN","name":"iOS 26.5","platform":"iOS","isAvailable":true,"supportedDeviceTypes":['"$ipad_type,$iphone_types"']}'
printf '%s\n' '{"runtimes":['"$runtime_2620,$runtime_2650"']}' >"$sandbox/runtimes-runner.json"
printf '%s\n' '== Runtimes ==' 'iOS 26.2 (26.2 - STAND-IN) - com.apple.CoreSimulator.SimRuntime.iOS-26-2' \
  'iOS 26.5 (26.5 - STAND-IN) - com.apple.CoreSimulator.SimRuntime.iOS-26-5' >"$sandbox/runtimes-runner.txt"
printf '%s\n' '{"runtimes":['"$runtime_2650"']}' >"$sandbox/runtimes-no-match.json"
printf '%s\n' '== Runtimes ==' 'iOS 26.5 (26.5 - STAND-IN) - com.apple.CoreSimulator.SimRuntime.iOS-26-5' >"$sandbox/runtimes-no-match.txt"

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
# Its run at 5d176d40 (run 42900368452) listed the same three under the named Xcode 26.2, though
# the iOS 26.2, 26.4.1 and 26.5 runtimes were installed (showdestinations.txt and
# simctl-runtimes.txt of that run): installed runtimes, and no device made on them for that Xcode.
listing "$sandbox/destinations-hosted-5d176d40.txt" \
  'platform:macOS, arch:arm64, variant:Designed for [iPad,iPhone], id:RUNNER-MAC, name:My Mac' "$any_device" "$any_simulator"
mkdir -p "$sandbox/xcode-26.0.1/usr/bin" "$sandbox/xcode-26.2/usr/bin"
printf '%s\n' '#!/bin/bash' 'exit 64' >"$sandbox/xcode-26.0.1/usr/bin/xcodebuild"
printf '%s\n' '#!/bin/bash' 'exit 64' >"$sandbox/xcode-26.2/usr/bin/xcodebuild"
chmod +x "$sandbox/xcode-26.0.1/usr/bin/xcodebuild" "$sandbox/xcode-26.2/usr/bin/xcodebuild"
chmod +x "$sandbox/bin/swift" "$sandbox/bin/xcodebuild" "$sandbox/bin/xcrun" "$sandbox/stand-in-check.sh"

failed=0
output=""
code=0
# What the xcrun stand-in records of each run: every simctl create call, every UDID deleted.
creates="$sandbox/creates.txt"
deletes="$sandbox/deletes.txt"

# Runs ci.sh once: the release check to use (stand-in or real), the simulator's id (empty to
# leave it unset, as on a runner), then the scenario's own variables, which win over the
# runner's defaults set here.
run_ci() {
  local which="$1" udid="$2"
  shift 2
  rm -rf "$sandbox/run/DerivedData" "$sandbox/run/DerivedData-release-check"
  : >"$creates"
  : >"$deletes"
  if [ "$which" = real ]; then
    cp "$check" "$sandbox/run/scripts/check-release-binary.sh"
  else
    cp "$sandbox/stand-in-check.sh" "$sandbox/run/scripts/check-release-binary.sh"
  fi
  local -a vars
  vars=(HOME="$sandbox/tmp" TMPDIR="$sandbox/tmp" PATH="$sandbox/bin:/usr/bin:/bin"
    CI_PROOF_CREATES="$creates" CI_PROOF_DELETES="$deletes" CI_PROOF_DEVICES="$sandbox/devices-runner.json"
    CI_PROOF_DEVICETYPES="$sandbox/devicetypes-runner.json" CI_PROOF_RUNTIMES="$sandbox/runtimes-runner.json" "$@")
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

# Reads a record of the last run: the scenario, the record, and an extended regular expression
# its whole content must match (one line per call recorded, so ^$ for none).
recorded() {
  local name="$1" file="$2" want="$3" have
  have="$(cat "$file")"
  if [[ "$have" =~ $want ]]; then
    echo "PASS $name"
  else
    echo "FAIL $name: the record reads \"$(tr '\n' ';' <"$file")\""
    failed=1
  fi
}
nothing_made() {  # the scenario: the last run made no simulator and deleted none
  if [ ! -s "$creates" ] && [ ! -s "$deletes" ]; then
    echo "PASS $1"
  else
    echo "FAIL $1: created \"$(tr '\n' ';' <"$creates")\", deleted \"$(tr '\n' ';' <"$deletes")\""
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
judge "the same run prints the iOS simulators simctl lists" fail "ci: device: iPhone 17 Pro PICK-2650 Shutdown"
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

# Two toolchains. The trace names each xcodebuild action and each simctl call with the Xcode it
# ran under.
trace="$sandbox/trace.txt"
trace_says() {  # the scenario, the first line wanted (the core's tests), the Xcode every later line must name
  local name="$1" first="$2" later="$3"
  # At least the core's tests, the listing, the build and the tests: the simctl calls, traced
  # as well, must name the same Xcode but are not counted among those four.
  if [ "$(sed -n 1p "$trace")" = "$first" ] && [ "$(grep -vc '^simctl ' "$trace")" -ge 4 ] \
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
trace_says "the same run's trace: the core's tests and every xcodebuild action under the job's own Xcode" "swift unset" "unset"
if [[ $'\n'"$output"$'\n' == *$'\n'"ci: the simulator steps run under "* ]]; then
  echo "FAIL the same run names another Xcode though none was named"; failed=1
else
  echo "PASS the same run names no other Xcode"
fi
hosted=("${job[@]}" CI_PROOF_JOB_DESTINATIONS="$sandbox/destinations-hosted-20261110.txt")
run_ci stand-in "" "${hosted[@]}"
judge "the hosted runner as its run of 10 November listed it, no simulator Xcode named" fail "ci: no iPhone simulator among the destinations xcodebuild lists for the Clave scheme"
nothing_made "the same run makes no simulator: no runtime of the job's own SDK, 26.0, is installed"
: >"$trace"
run_ci stand-in "" "${hosted[@]}" CLAVE_IOS_SIMULATOR_DEVELOPER_DIR="$sandbox/xcode-26.2" CI_PROOF_TRACE="$trace"
judge "the same runner with an installed simulator Xcode named" pass "ci: the simulator steps run under Xcode 26.2 (CLAVE_IOS_SIMULATOR_DEVELOPER_DIR)"
trace_says "the same run's trace: the core's tests under the job's Xcode, the listing, the build and the tests under the named one" "swift unset" "$sandbox/xcode-26.2"
nothing_made "the same run makes no simulator and deletes none: its Xcode lists an iPhone, and a runtime of its SDK is installed"
run_ci stand-in "" "${hosted[@]}" CLAVE_IOS_SIMULATOR_DEVELOPER_DIR="$sandbox/no-such-xcode"
judge "a named simulator Xcode folder that is not there" fail "ci: CLAVE_IOS_SIMULATOR_DEVELOPER_DIR holds no Xcode: $sandbox/no-such-xcode"
run_ci stand-in "" "${hosted[@]}" CLAVE_IOS_SIMULATOR_DEVELOPER_DIR="$sandbox/tmp"
judge "a named folder that holds no Xcode" fail "ci: CLAVE_IOS_SIMULATOR_DEVELOPER_DIR holds no Xcode: $sandbox/tmp"

# The runner as its run at 5d176d40 listed it: the named Xcode 26.2 offers no iPhone, though the
# iOS 26.2 runtime of its SDK is installed. The gate makes one iPhone for its run on that runtime,
# runs on it, and deletes it and nothing else.
owned=(CI_PROOF_FAIL= CI_PROOF_DEVICES="$sandbox/devices-runner.json" CI_PROOF_SIM_DEVDIR="$sandbox/xcode-26.2"
  CLAVE_IOS_SIMULATOR_DEVELOPER_DIR="$sandbox/xcode-26.2" CI_PROOF_DESTINATIONS="$sandbox/destinations-hosted-5d176d40.txt")
rm -rf "$sandbox/run/build"
: >"$trace"
run_ci stand-in "" "${owned[@]}" CI_PROOF_TRACE="$trace"
judge "the hosted runner as its run at 5d176d40 listed it, the runtime of the SDK installed" pass "ci: simulator MADE-2620"
recorded "the same run made exactly one simulator, an iPhone 17 Pro on the iOS 26.2 runtime, named for its run" "$creates" \
  '^simctl create clave-ci-[0-9]+-[0-9]+ com\.apple\.CoreSimulator\.SimDeviceType\.iPhone-17-Pro com\.apple\.CoreSimulator\.SimRuntime\.iOS-26-2$'
made_name="$(sed -n 's/^simctl create \([^ ]*\) .*/\1/p' "$creates")"
judge "the same run names the simulator it made" pass "ci: made simulator $made_name MADE-2620 (iPhone 17 Pro, iOS 26.2) for this run"
recorded "the same run deleted the simulator it made, and no other" "$deletes" '^MADE-2620$'
trace_says "the same run's trace: the core's tests under the job's Xcode, every simctl call and xcodebuild action under the named one" "swift unset" "$sandbox/xcode-26.2"
if [ "$(sed -n '$p' "$trace")" = "simctl delete $sandbox/xcode-26.2" ]; then
  echo "PASS the same run deletes the simulator it made last, after the tests ran on it"
else
  echo "FAIL the same run's trace ends with \"$(sed -n '$p' "$trace")\", not the delete of the simulator it made"
  failed=1
fi
rm -rf "$sandbox/run/build"
run_ci stand-in "" "${owned[@]}" CI_PROOF_RUNTIMES="$sandbox/runtimes-no-match.json"
judge "the same runner without the runtime of the SDK" fail "ci: no installed iOS runtime matches the simulator SDK 26.2, so no simulator was made"
nothing_made "the same run made no simulator and deleted none"
# What the job uploads from a run that picked nothing: simctl's own answers, byte for byte, and
# the named Xcode's version and SDKs.
reports="$sandbox/run/build/reports"
if cmp -s "$sandbox/devices-runner.json" "$reports/simctl-devices.json" \
  && cmp -s "$sandbox/devicetypes-runner.json" "$reports/simctl-devicetypes.json" \
  && cmp -s "$sandbox/runtimes-no-match.json" "$reports/simctl-runtimes.json" \
  && [ "$(sed -n 1p "$reports/xcode.txt" 2>/dev/null)" = "Xcode 26.2" ] \
  && grep -q -e "-sdk iphonesimulator26.2" "$reports/xcode.txt" 2>/dev/null; then
  echo "PASS the same run keeps the runner's inventory under build/reports: simctl's devices, device types and runtimes, the Xcode and its SDKs"
else
  echo "FAIL the same run keeps no complete inventory under build/reports: it holds $(ls "$reports" 2>/dev/null | tr '\n' ' ')"
  failed=1
fi
rm -rf "$sandbox/run/build"
run_ci stand-in "" "${owned[@]}" CI_PROOF_MADE_UNLISTED=1
judge "the same runner whose scheme does not list the simulator made for it" fail "ci: the simulator made for this run, MADE-2620, is not among the scheme's destinations"
recorded "the same run deleted the simulator it made, and no other" "$deletes" '^MADE-2620$'
if cmp -s "$sandbox/destinations-hosted-5d176d40.txt" "$sandbox/run/build/reports/showdestinations-made.txt"; then
  echo "PASS the same run keeps the listing it checked the made simulator against under build/reports"
else
  echo "FAIL the same run keeps no build/reports/showdestinations-made.txt equal to what xcodebuild printed"
  failed=1
fi

if [ "$failed" -eq 0 ]; then
  echo "PASS ci gate proof: $target follows each step, with $check read for real"
  exit 0
fi
echo "FAIL ci gate proof: $target or $check does not follow its steps"
exit 1

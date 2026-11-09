#!/usr/bin/env bash
# Proves the development-only code stays out of a release build: the UI-test
# fake, its launch argument, the issuer and relay overrides and the developer
# connection. Builds Debug and Release for the simulator, then reads each
# binary with `strings`. Every marker must be PRESENT in Debug (else this
# check looks for the wrong thing) and ABSENT from Release.
#
# A Debug build keeps its code in Clave.app/Clave.debug.dylib beside a stub
# Clave executable (Xcode's debug dylib), so both files are read.
#
#   bash scripts/check-release-binary.sh              # the check
#   bash scripts/check-release-binary.sh --prove-red  # Release built with DEBUG set: the check must fail
#
# Run from apps/mobile-ios. CLAVE_IOS_SIMULATOR_UDID names the simulator,
# CLAVE_IOS_DERIVED_DATA the build folder.
set -uo pipefail

cd "$(dirname "$0")/.."

UDID="${CLAVE_IOS_SIMULATOR_UDID:-DA4B1D9E-9C78-4614-8C52-4F2C075298E2}"
DERIVED="${CLAVE_IOS_DERIVED_DATA:-/private/tmp/clave-native-a/DerivedData-release-check}"
# What strings really shows (verified on 9 November 2026): Swift keeps a
# string of 15 bytes or fewer inline in the instructions of an optimized
# build, so `--ui-test-fake`, `CLAVE_IOS_RELAY` and `developer.add` can be
# absent from a Release binary that still carries their code. They are
# checked, but the proof rests on the STRONG markers, which an optimized
# binary keeps as text: the fake's type names, CLAVE_IOS_ISSUER (read in the
# same guarded function as the argument and the relay variable), the
# developer section's type name and its button's label. --prove-red requires
# every strong marker to be found once the guard is off.
# ClaveCore's DeveloperMachineSource is no marker: the package compiles it
# into every build and its MachineSource conformance keeps the type name in
# a release binary whatever the app references.
STRONG=(UITestFake CLAVE_IOS_ISSUER DeveloperConnectionSection "Add the developer server")
WEAK=(--ui-test-fake CLAVE_IOS_RELAY developer.add)
MARKERS=("${STRONG[@]}" "${WEAK[@]}")
PROVE_RED=0
[ "${1:-}" = "--prove-red" ] && PROVE_RED=1

build() {
  local configuration="$1"
  shift
  xcodebuild -project Clave.xcodeproj -scheme Clave -configuration "$configuration" \
    -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath "$DERIVED" "$@" build >"$DERIVED/xcodebuild-$configuration.log" 2>&1
  local code=$?
  if [ $code -ne 0 ]; then
    echo "FAIL build $configuration (xcodebuild exited $code; log: $DERIVED/xcodebuild-$configuration.log)"
    exit 1
  fi
}

# The text of every binary of the app, Clave and its debug dylib when there is one.
binary_strings() {
  local app="$DERIVED/Build/Products/$1-iphonesimulator/Clave.app"
  [ -f "$app/Clave" ] || { echo "FAIL no binary at $app/Clave" >&2; exit 1; }
  for file in "$app/Clave" "$app/Clave.debug.dylib"; do
    [ -f "$file" ] && strings -a "$file"
  done
}

mkdir -p "$DERIVED"
failed=0

if [ $PROVE_RED -eq 0 ]; then
  build Debug
  debug_text="$(binary_strings Debug)"
  for marker in "${MARKERS[@]}"; do
    if grep -qF -- "$marker" <<<"$debug_text"; then
      echo "PASS debug has $marker"
    else
      echo "FAIL debug lacks $marker (the check looks for the wrong thing)"
      failed=1
    fi
  done
  build Release
else
  # The guard left off: Release compiled with DEBUG set must carry the markers.
  build Release "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG \$(inherited)"
fi

release_text="$(binary_strings Release)"
release_failed=0
for marker in "${MARKERS[@]}"; do
  if grep -qF -- "$marker" <<<"$release_text"; then
    echo "FAIL release has $marker"
    release_failed=1
  else
    echo "PASS release lacks $marker"
  fi
done

if [ $PROVE_RED -eq 1 ]; then
  missed=0
  for marker in "${STRONG[@]}"; do
    grep -qF -- "$marker" <<<"$release_text" || { echo "FAIL prove-red: the strong marker $marker went unseen"; missed=1; }
  done
  if [ $release_failed -eq 1 ] && [ $missed -eq 0 ]; then
    echo "PASS prove-red: a Release built with DEBUG set fails the check on every strong marker"
    exit 0
  fi
  echo "FAIL prove-red: a Release built with DEBUG set was not caught on every strong marker"
  exit 1
fi

[ $failed -eq 0 ] && [ $release_failed -eq 0 ] || exit 1
echo "PASS release binary check"

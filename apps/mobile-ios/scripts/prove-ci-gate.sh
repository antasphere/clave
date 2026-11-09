#!/usr/bin/env bash
# Proves that ci.sh's verdict follows its steps: it must exit non-zero, and
# never print "ci: green", when the core's tests, the simulator build, the
# simulator tests or the release-binary check fail, and exit 0 when all pass.
#
# ci.sh is copied into a scratch folder and run there with stand-ins for
# swift, xcodebuild and the release-binary check, first on the PATH; no build
# runs, no simulator is touched, nothing is left behind.
#
#   bash scripts/prove-ci-gate.sh                    # proves ./ci.sh
#   bash scripts/prove-ci-gate.sh --against <file>   # the same scenarios on another copy
#
# Run from apps/mobile-ios. Exits 0 when every scenario gives the expected
# verdict, 1 otherwise.
set -uo pipefail

cd "$(dirname "$0")/.."
target="ci.sh"
if [ "${1:-}" = "--against" ]; then
  target="${2:?--against needs a file}"
fi
[ -f "$target" ] || { echo "FAIL no ci script at $target"; exit 1; }

sandbox="$(mktemp -d "${TMPDIR:-/tmp}/clave-ios-ci-proof.XXXXXX")"
trap 'rm -rf "$sandbox"' EXIT
mkdir -p "$sandbox/run/ClaveCore" "$sandbox/run/scripts" "$sandbox/bin" "$sandbox/tmp"
cp "$target" "$sandbox/run/ci.sh"

# The stand-ins are written with printf: a heredoc over 512 bytes can hang bash 5.2 on a Mac
# whose pipes are at their minimum size (seen on 9 November 2026), since bash fills the pipe
# before the reader starts.
printf '%s\n' '#!/bin/bash' \
  'if [ "$CI_PROOF_FAIL" = swift ]; then echo "error: a stand-in failure"; exit 1; fi' \
  'echo "Executed 312 tests, with 0 failures (0 unexpected)"' >"$sandbox/bin/swift"

printf '%s\n' '#!/bin/bash' \
  'if [ "$1" = "-version" ]; then printf "Xcode 26.0.1\nBuild version 17A400\n"; exit 0; fi' \
  'for arg in "$@"; do' \
  '  case "$arg" in' \
  '    build)' \
  '      if [ "$CI_PROOF_FAIL" = build ]; then echo "** BUILD FAILED **"; exit 65; fi' \
  '      echo "** BUILD SUCCEEDED **"; exit 0 ;;' \
  '    test)' \
  '      if [ "$CI_PROOF_FAIL" = test ]; then echo "Test Case stand-in failed"; echo "** TEST FAILED **"; exit 65; fi' \
  '      echo "Test Suite All tests passed"; echo "** TEST SUCCEEDED **"; exit 0 ;;' \
  '  esac' \
  'done' \
  'echo "stand-in xcodebuild: no action among the arguments"' \
  'exit 64' >"$sandbox/bin/xcodebuild"

printf '%s\n' '#!/bin/bash' \
  'if [ "$CI_PROOF_FAIL" = release ]; then echo "FAIL release has UITestFake"; exit 1; fi' \
  'echo "PASS release binary check"' >"$sandbox/run/scripts/check-release-binary.sh"
chmod +x "$sandbox/bin/swift" "$sandbox/bin/xcodebuild" "$sandbox/run/scripts/check-release-binary.sh"

failed=0
# A scenario: the step made to fail (none for the passing run), then the expected verdict.
scenario() {
  local fail="$1" expect="$2" output code green=no
  output="$(env -i HOME="$sandbox/tmp" TMPDIR="$sandbox/tmp" PATH="$sandbox/bin:/usr/bin:/bin" \
    CLAVE_IOS_SIMULATOR_UDID=00000000-0000-0000-0000-000000000000 CI_PROOF_FAIL="$fail" \
    bash "$sandbox/run/ci.sh" 2>&1)"
  code=$?
  # A pattern match, not a here-string into grep: no pipe for bash to fill (see above).
  [[ $'\n'"$output"$'\n' == *$'\n'"ci: green"$'\n'* ]] && green=yes
  local name="${fail:-none}"
  if [ "$expect" = pass ] && [ "$code" -eq 0 ] && [ "$green" = yes ]; then
    echo "PASS all steps pass: exit 0, ci: green printed"
  elif [ "$expect" = fail ] && [ "$code" -ne 0 ] && [ "$green" = no ]; then
    echo "PASS $name fails: exit $code, no ci: green"
  else
    echo "FAIL $name: exit $code, ci: green printed: $green (expected $expect)"
    failed=1
  fi
}

scenario "" pass
scenario swift fail
scenario build fail
scenario test fail
scenario release fail

if [ "$failed" -eq 0 ]; then
  echo "PASS ci gate proof: $target goes red on each failing step"
  exit 0
fi
echo "FAIL ci gate proof: $target does not follow its steps"
exit 1

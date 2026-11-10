#!/usr/bin/env bash
# The release APK reaches the real API and nothing else: no in-process fake, no developer
# connection, no test double in its dex, no plain-http allowance in its network security
# config, the release application id and no debuggable flag. The fakes behind the UI tests
# live in the androidTest and debug source sets; this check is what keeps them there. Each
# rule is shown red on a release APK built with what it refuses (the lane's record names
# those runs).
#
#   bash scripts/check-release-apk.sh [app/build/outputs/apk/release/app-release-unsigned.apk]
#
# Needs JAVA_HOME and ANDROID_HOME (apkanalyzer from the command-line tools, aapt2 from the
# build tools). Exit 1 names every offending class and attribute; exit 2 when the APK or a
# tool cannot be read.
#
# Every dump is written to a file and matched there, never piped into a reader that may stop
# early: with `aapt2 dump … | grep -q` under pipefail, grep exits at the first match, aapt2
# dies of SIGPIPE, and the pipeline reads as no match. That is how a debuggable release APK
# once passed this check.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
APK=${1:-$HERE/app/build/outputs/apk/release/app-release-unsigned.apk}
: "${ANDROID_HOME:?ANDROID_HOME must point at the SDK root}"
APKANALYZER=$(ls -d "$ANDROID_HOME"/cmdline-tools/*/bin/apkanalyzer 2>/dev/null | sort -V | tail -1 || true)
AAPT2=$(ls -d "$ANDROID_HOME"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -1 || true)
[ -f "$APK" ] || { echo "check-release-apk: no APK at $APK (run ./gradlew assembleRelease first)" >&2; exit 2; }
[ -n "$APKANALYZER" ] || { echo "check-release-apk: no apkanalyzer under $ANDROID_HOME/cmdline-tools" >&2; exit 2; }
[ -n "$AAPT2" ] || { echo "check-release-apk: no aapt2 under $ANDROID_HOME/build-tools" >&2; exit 2; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/check-release-apk.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

failed=0
say() { printf '%s\n' "$*"; }
fail() { say "check-release-apk: FAIL · $*"; failed=1; }

# dump FILE COMMAND…: the command's whole output into FILE. A command that fails stops the
# check with exit 2: an unreadable APK never reads as a clean one.
dump() {
  local file=$1 rc=0
  shift
  "$@" > "$file" 2> "$file.err" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "check-release-apk: cannot read the APK, ${1##*/} exited $rc: $(head -c 300 "$file.err")" >&2
    exit 2
  fi
}

# found PATTERN FILE: status 0 when a line of FILE matches the extended PATTERN, 1 when none
# does. Any other status of grep stops the check rather than reading as "not found".
found() {
  local rc=0
  grep -qE -e "$1" -- "$2" || rc=$?
  [ "$rc" -le 1 ] || { echo "check-release-apk: grep exited $rc on ${2##*/}" >&2; exit 2; }
  return "$rc"
}

# lines FLAGS PATTERN FILE: the lines grep selects with FLAGS (-E, or -vE for the lines that do
# not match), none being a valid answer. Any other status of grep stops the check.
lines() {
  local rc=0
  grep "$1" -e "$2" -- "$3" || rc=$?
  [ "$rc" -le 1 ] || { echo "check-release-apk: grep exited $rc on ${3##*/}" >&2; exit 2; }
}

# 1. The dex: every class defined in the APK, matched against what a release must not carry.
#    A fake is any class under a `fake` package or named Fake…, the developer connection,
#    MockWebServer, the Compose test manifest and the test runners.
dump "$WORK/dex.txt" "$APKANALYZER" dex packages --defined-only "$APK"
awk '$1 == "C" {print $NF}' "$WORK/dex.txt" > "$WORK/defined.txt"
total=$(awk 'END {print NR}' "$WORK/defined.txt")
lines -E '(^|\.)fake(\.|$)|(^|\.)Fake[A-Z]|mockwebserver|(^|\.)dev(eloper)?\.|DeveloperConnection|androidx\.compose\.ui\.test|androidx\.test\.|junit\.' "$WORK/defined.txt" > "$WORK/offending.txt"
if [ -s "$WORK/offending.txt" ]; then
  fail "$(awk 'END {print NR}' "$WORK/offending.txt") class(es) a release must not carry, of $total:"
  sed 's/^/  /' "$WORK/offending.txt"
else
  say "check-release-apk: ok · no fake, developer connection or test double among $total classes"
fi

# 2. The network security config: no cleartext allowance, no domain exception. A release build
#    shortens resource file names (res/8G.xml), so the file is found through the resource table,
#    which maps xml/network_security_config to its path; the plain path is the fallback.
dump "$WORK/resources.txt" "$AAPT2" dump resources "$APK"
config_path=$(awk '/ xml\/network_security_config$/ {found=1; next} found && /\(file\)/ {print $3; exit}' "$WORK/resources.txt")
[ -n "$config_path" ] || config_path=res/xml/network_security_config.xml
if ! "$AAPT2" dump xmltree --file "$config_path" "$APK" > "$WORK/config.txt" 2> /dev/null || [ ! -s "$WORK/config.txt" ]; then
  fail "the APK carries no network security config (looked for xml/network_security_config at $config_path)"
else
  config_ok=1
  if found 'cleartextTrafficPermitted[^=]*=true' "$WORK/config.txt"; then
    fail "the network security config permits cleartext traffic"; config_ok=0
  fi
  if found 'E: domain(-config)? ' "$WORK/config.txt"; then
    fail "the network security config carries a domain exception"; config_ok=0
  fi
  if [ $config_ok -eq 1 ]; then
    say "check-release-apk: ok · network security config ($config_path): no cleartext, no domain exception"
  fi
fi

# 3. The manifest: the release application id, not debuggable. Debuggable is read twice, from
#    the badging and from the manifest's own attribute.
dump "$WORK/badging.txt" "$AAPT2" dump badging "$APK"
pkg=$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" "$WORK/badging.txt")
if [ "$pkg" != "com.clave.app.android" ]; then fail "application id is $pkg"; else say "check-release-apk: ok · application id $pkg"; fi
dump "$WORK/manifest.txt" "$AAPT2" dump xmltree --file AndroidManifest.xml "$APK"
if found '^application-debuggable' "$WORK/badging.txt" || found 'debuggable[^=]*=true' "$WORK/manifest.txt"; then
  fail "the manifest is debuggable"
else
  say "check-release-apk: ok · not debuggable"
fi

if [ $failed -eq 0 ]; then say "check-release-apk: passed"; else say "check-release-apk: FAILED"; fi
exit $failed

#!/usr/bin/env bash
# The release APK reaches the real API and nothing else: no in-process fake, no developer
# connection, no test double in its dex, no plain-http allowance in its network security
# config, the release application id and no debuggable flag. The fakes behind the UI tests
# live in the androidTest and debug source sets; this check is what keeps them there, and it
# is shown red once by moving a fake into main (the lane's record names that run).
#
#   bash scripts/check-release-apk.sh [app/build/outputs/apk/release/app-release-unsigned.apk]
#
# Needs JAVA_HOME and ANDROID_HOME (apkanalyzer from the command-line tools, aapt2 from the
# build tools). Exit 1 names every offending class and attribute.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
APK=${1:-$HERE/app/build/outputs/apk/release/app-release-unsigned.apk}
: "${ANDROID_HOME:?ANDROID_HOME must point at the SDK root}"
APKANALYZER=$(ls -d "$ANDROID_HOME"/cmdline-tools/*/bin/apkanalyzer 2>/dev/null | sort -V | tail -1)
AAPT2=$(ls -d "$ANDROID_HOME"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -1)
[ -f "$APK" ] || { echo "check-release-apk: no APK at $APK (run ./gradlew assembleRelease first)" >&2; exit 2; }
[ -n "$APKANALYZER" ] || { echo "check-release-apk: no apkanalyzer under $ANDROID_HOME/cmdline-tools" >&2; exit 2; }
[ -n "$AAPT2" ] || { echo "check-release-apk: no aapt2 under $ANDROID_HOME/build-tools" >&2; exit 2; }

failed=0
say() { printf '%s\n' "$*"; }

# 1. The dex: every class defined in the APK, matched against what a release must not carry.
#    A fake is any class under a `fake` package or named Fake…, the developer connection,
#    MockWebServer, the Compose test manifest and the test runners.
classes=$("$APKANALYZER" dex packages --defined-only "$APK" | awk '$1 == "C" {print $NF}')
total=$(printf '%s\n' "$classes" | grep -c . || true)
offending=$(printf '%s\n' "$classes" | grep -E '(^|\.)fake(\.|$)|(^|\.)Fake[A-Z]|mockwebserver|(^|\.)dev(eloper)?\.|DeveloperConnection|androidx\.compose\.ui\.test|androidx\.test\.|junit\.' || true)
if [ -n "$offending" ]; then
  say "check-release-apk: FAIL · $(printf '%s\n' "$offending" | grep -c .) class(es) a release must not carry, of $total:"
  printf '%s\n' "$offending" | sed 's/^/  /'
  failed=1
else
  say "check-release-apk: ok · no fake, developer connection or test double among $total classes"
fi

# 2. The network security config: no cleartext allowance, no domain exception. A release build
#    shortens resource file names (res/8G.xml), so the file is found through the resource table,
#    which maps xml/network_security_config to its path; the plain path is the fallback.
config_path=$("$AAPT2" dump resources "$APK" 2>/dev/null | awk '/ xml\/network_security_config$/ {found=1; next} found && /\(file\)/ {print $3; exit}')
[ -n "$config_path" ] || config_path=res/xml/network_security_config.xml
config=$("$AAPT2" dump xmltree --file "$config_path" "$APK" 2>/dev/null || true)
if [ -z "$config" ]; then
  say "check-release-apk: FAIL · the APK carries no network security config (looked for xml/network_security_config at $config_path)"; failed=1
else
  if printf '%s\n' "$config" | grep -qE 'cleartextTrafficPermitted[^=]*=true'; then
    say "check-release-apk: FAIL · the network security config permits cleartext traffic"; failed=1
  fi
  if printf '%s\n' "$config" | grep -qE 'E: domain(-config)? '; then
    say "check-release-apk: FAIL · the network security config carries a domain exception"; failed=1
  fi
  [ $failed -eq 0 ] && say "check-release-apk: ok · network security config ($config_path): no cleartext, no domain exception"
fi

# 3. The manifest: the release application id, not debuggable.
badging=$("$AAPT2" dump badging "$APK")
pkg=$(printf '%s\n' "$badging" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")
if [ "$pkg" != "com.clave.app.android" ]; then say "check-release-apk: FAIL · application id is $pkg"; failed=1; else say "check-release-apk: ok · application id $pkg"; fi
if "$AAPT2" dump xmltree --file AndroidManifest.xml "$APK" | grep -qE 'debuggable[^=]*=true'; then say "check-release-apk: FAIL · the manifest is debuggable"; failed=1; else say "check-release-apk: ok · not debuggable"; fi

[ $failed -eq 0 ] && say "check-release-apk: passed" || say "check-release-apk: FAILED"
exit $failed

#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

# Writes provenance.json beside the artifact; tracked source must stay clean.
# Usage: mobile-build-ios.sh [worktree-root] [output-directory]
# Default: unsigned device archive, not installable or eligible for TestFlight.
# Signed archive: MOBILE_IOS_TEAM_ID, MOBILE_IOS_PROFILE, MOBILE_IOS_IDENTITY.
# Optional export: MOBILE_IOS_EXPORT_OPTIONS_PLIST, supplied by the owning team.
# Optional managed provisioning: all of MOBILE_IOS_API_KEY_PATH,
# MOBILE_IOS_API_KEY_ID, MOBILE_IOS_API_ISSUER_ID. Key contents never enter argv.
ROOT="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/..}" && pwd)"
OUT="${2:-/tmp/clave-mobile-d/ios}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
ARCHIVE="$OUT/Clave.xcarchive"
[[ ! -e "$ARCHIVE" ]] || { echo 'Archive already exists; choose a fresh output directory.' >&2; exit 1; }
SIGNING_MODE=unsigned
SIGNING=(CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO 'CODE_SIGN_IDENTITY=' 'DEVELOPMENT_TEAM=')
if [[ -n "${MOBILE_IOS_TEAM_ID:-}${MOBILE_IOS_PROFILE:-}${MOBILE_IOS_IDENTITY:-}" ]]; then
  : "${MOBILE_IOS_TEAM_ID:?Explicit owning mobile team required}"
  : "${MOBILE_IOS_PROFILE:?Explicit mobile provisioning profile required}"
  : "${MOBILE_IOS_IDENTITY:?Explicit signing identity required}"
  SIGNING_MODE=team
  SIGNING=(CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Manual "DEVELOPMENT_TEAM=$MOBILE_IOS_TEAM_ID" "PROVISIONING_PROFILE_SPECIFIER=$MOBILE_IOS_PROFILE" "CODE_SIGN_IDENTITY=$MOBILE_IOS_IDENTITY")
fi
if [[ -n "${MOBILE_IOS_EXPORT_OPTIONS_PLIST:-}" ]]; then
  : "${MOBILE_IOS_TEAM_ID:?Export requires explicit signing configuration}"
  [[ -f "$MOBILE_IOS_EXPORT_OPTIONS_PLIST" ]] || { echo 'Export options plist missing.' >&2; exit 1; }
fi
AUTH=()
if [[ -n "${MOBILE_IOS_API_KEY_PATH:-}${MOBILE_IOS_API_KEY_ID:-}${MOBILE_IOS_API_ISSUER_ID:-}" ]]; then
  : "${MOBILE_IOS_TEAM_ID:?Provisioning requires explicit signing configuration}"
  : "${MOBILE_IOS_API_KEY_PATH:?API key file required}"
  : "${MOBILE_IOS_API_KEY_ID:?API key ID required}"
  : "${MOBILE_IOS_API_ISSUER_ID:?API issuer ID required}"
  [[ -f "$MOBILE_IOS_API_KEY_PATH" ]] || exit 1
  AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$MOBILE_IOS_API_KEY_PATH" -authenticationKeyID "$MOBILE_IOS_API_KEY_ID" -authenticationKeyIssuerID "$MOBILE_IOS_API_ISSUER_ID")
fi
# Native generation must start and end on the same committed tracked source.
assert_source() {
  git -C "$ROOT" diff --quiet HEAD -- || { echo 'Tracked source changes prevent a reproducible native build.' >&2; exit 1; }
  [[ "$(git -C "$ROOT" rev-parse HEAD)" == "$SOURCE_HEAD" ]] || { echo 'Repository HEAD changed during the build.' >&2; exit 1; }
  [[ "$(shasum -a 256 "$ROOT/package-lock.json" | cut -d ' ' -f 1)" == "$SOURCE_LOCK_SHA256" ]] || { echo 'Package lock changed during the build.' >&2; exit 1; }
}
SOURCE_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
SOURCE_TREE="$(git -C "$ROOT" rev-parse 'HEAD^{tree}')"
SOURCE_LOCK_SHA256="$(shasum -a 256 "$ROOT/package-lock.json" | cut -d ' ' -f 1)"
assert_source
cd "$ROOT/packages/mobile"
npm exec -- expo prebuild --platform ios --no-install
(cd ios && pod install)
WORKSPACE="${MOBILE_IOS_WORKSPACE:-$PWD/ios/Clave.xcworkspace}"
xcodebuild -workspace "$WORKSPACE" -scheme "${MOBILE_IOS_SCHEME:-Clave}" \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath "$OUT/DerivedData" -archivePath "$ARCHIVE" \
  "${AUTH[@]}" "${SIGNING[@]}" archive
[[ -f "$ARCHIVE/Info.plist" && -d "$ARCHIVE/Products/Applications/Clave.app" ]] || { echo 'Expected archive application missing.' >&2; exit 1; }
if [[ -n "${MOBILE_IOS_EXPORT_OPTIONS_PLIST:-}" ]]; then
  xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$OUT/export" \
    -exportOptionsPlist "$MOBILE_IOS_EXPORT_OPTIONS_PLIST" "${AUTH[@]}"
  IPA=("$OUT/export/"*.ipa)
  [[ -f "${IPA[0]}" ]] || { echo 'Expected exported IPA missing.' >&2; exit 1; }
  echo "Exported IPA: ${IPA[0]}"
elif [[ -z "${MOBILE_IOS_TEAM_ID:-}" ]]; then
  echo 'Unsigned device archive only; installation and TestFlight export require mobile distribution signing.'
fi
assert_source
APP="$ARCHIVE/Products/Applications/Clave.app"
EXECUTABLE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist")"
[[ -s "$APP/$EXECUTABLE_NAME" ]] || { echo 'Embedded app executable missing.' >&2; exit 1; }
node - "$OUT" "$ROOT" "$SOURCE_HEAD" "$SOURCE_TREE" "$SOURCE_LOCK_SHA256" "$SIGNING_MODE" "$ARCHIVE" "$APP/$EXECUTABLE_NAME" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const [out, repository, head, tree, packageLockSha256, signingMode, archive, executable] = process.argv.slice(2)
const hashFile = file => ({ path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') })
const bundle = path.join(path.dirname(executable), 'main.jsbundle')
fs.writeFileSync(path.join(out, 'provenance.json'), JSON.stringify({
  platform: 'ios', repository, head, tree, packageLockSha256, signingMode,
  createdAt: new Date().toISOString(), archive, executable: hashFile(executable),
  javascriptBundle: fs.existsSync(bundle) ? hashFile(bundle) : null
}, null, 2) + '\n', { mode: 0o600 })
NODE
assert_source
echo "Archive: $ARCHIVE"

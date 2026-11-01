#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

# Writes provenance.json beside the artifact; tracked source must stay clean.
# Usage: mobile-build-android.sh [worktree-root] [output-directory]
# Optional team signing: MOBILE_ANDROID_KEYSTORE, MOBILE_ANDROID_KEY_ALIAS,
# MOBILE_ANDROID_STORE_PASSWORD_FILE, MOBILE_ANDROID_KEY_PASSWORD_FILE.
# With none supplied, generates a local beta key, never a store credential.
# MOBILE_ANDROID_KEY_DIR overrides its directory, default /tmp/clave-mobile-d/keystore.
ROOT="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/..}" && pwd)"
OUT="${2:-/tmp/clave-mobile-d/android}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
[[ ! -e "$OUT/clave-release.apk" ]] || { echo 'APK already exists; choose a fresh output directory.' >&2; exit 1; }
SIGNING_MODE=team
if [[ -z "${MOBILE_ANDROID_KEYSTORE:-}${MOBILE_ANDROID_KEY_ALIAS:-}${MOBILE_ANDROID_STORE_PASSWORD_FILE:-}${MOBILE_ANDROID_KEY_PASSWORD_FILE:-}" ]]; then
  SIGNING_MODE=local-beta
  KEY_DIR="${MOBILE_ANDROID_KEY_DIR:-/tmp/clave-mobile-d/keystore}"
  mkdir -p "$KEY_DIR"
  chmod 700 "$KEY_DIR"
  export MOBILE_ANDROID_KEYSTORE="$KEY_DIR/beta.p12"
  export MOBILE_ANDROID_KEY_ALIAS=clave-beta
  export MOBILE_ANDROID_STORE_PASSWORD_FILE="$KEY_DIR/password"
  export MOBILE_ANDROID_KEY_PASSWORD_FILE="$KEY_DIR/password"
  if [[ ! -f "$MOBILE_ANDROID_KEYSTORE" ]]; then
    [[ ! -e "$MOBILE_ANDROID_STORE_PASSWORD_FILE" ]] || { echo 'Incomplete beta keystore; inspect the keystore directory.' >&2; exit 1; }
    openssl rand -hex 32 > "$MOBILE_ANDROID_STORE_PASSWORD_FILE"
    keytool -genkeypair -noprompt -storetype PKCS12 -keystore "$MOBILE_ANDROID_KEYSTORE" \
      -alias "$MOBILE_ANDROID_KEY_ALIAS" -storepass:file "$MOBILE_ANDROID_STORE_PASSWORD_FILE" \
      -keypass:file "$MOBILE_ANDROID_KEY_PASSWORD_FILE" -keyalg RSA -keysize 2048 \
      -validity 3650 -dname 'CN=Clave Local Beta'
  fi
  echo 'Using task-local beta signing. A team-owned keystore is required for store distribution.'
fi
: "${MOBILE_ANDROID_KEYSTORE:?Keystore required}"
: "${MOBILE_ANDROID_KEY_ALIAS:?Key alias required}"
: "${MOBILE_ANDROID_STORE_PASSWORD_FILE:?Store password file required}"
: "${MOBILE_ANDROID_KEY_PASSWORD_FILE:?Key password file required}"
for file in "$MOBILE_ANDROID_KEYSTORE" "$MOBILE_ANDROID_STORE_PASSWORD_FILE" "$MOBILE_ANDROID_KEY_PASSWORD_FILE"; do
  [[ -f "$file" ]] || { echo 'Signing file missing.' >&2; exit 1; }
done
node - "$MOBILE_ANDROID_KEYSTORE" "$MOBILE_ANDROID_STORE_PASSWORD_FILE" "$MOBILE_ANDROID_KEY_PASSWORD_FILE" <<'NODE'
const fs = require('node:fs')
for (const file of process.argv.slice(2)) {
  if ((fs.statSync(file).mode & 0o077) !== 0) {
    console.error('Signing files must have no group or other permissions. Use chmod 600.')
    process.exit(1)
  }
}
NODE
# Resolve paths before entering the native project. Pass secrets through files,
# never Gradle command-line properties or source-controlled gradle.properties.
export MOBILE_ANDROID_KEYSTORE="$(cd "$(dirname "$MOBILE_ANDROID_KEYSTORE")" && pwd)/$(basename "$MOBILE_ANDROID_KEYSTORE")"
export MOBILE_ANDROID_STORE_PASSWORD_FILE="$(cd "$(dirname "$MOBILE_ANDROID_STORE_PASSWORD_FILE")" && pwd)/$(basename "$MOBILE_ANDROID_STORE_PASSWORD_FILE")"
export MOBILE_ANDROID_KEY_PASSWORD_FILE="$(cd "$(dirname "$MOBILE_ANDROID_KEY_PASSWORD_FILE")" && pwd)/$(basename "$MOBILE_ANDROID_KEY_PASSWORD_FILE")"
export MOBILE_ANDROID_KEY_ALIAS
INIT="$(mktemp "$OUT/signing.XXXXXX")"
trap 'rm -f "$INIT"' EXIT
cat > "$INIT" <<'GRADLE'
gradle.beforeProject { project ->
  project.pluginManager.withPlugin('com.android.application') {
    def android = project.extensions.getByName('android')
    def signing = android.signingConfigs.maybeCreate('claveMobileRelease')
    signing.storeFile = new File(System.getenv('MOBILE_ANDROID_KEYSTORE'))
    signing.storePassword = new File(System.getenv('MOBILE_ANDROID_STORE_PASSWORD_FILE')).text.trim()
    signing.keyAlias = System.getenv('MOBILE_ANDROID_KEY_ALIAS')
    signing.keyPassword = new File(System.getenv('MOBILE_ANDROID_KEY_PASSWORD_FILE')).text.trim()
    project.afterEvaluate {
      android.buildTypes.getByName('release').signingConfig = signing
    }
  }
}
GRADLE
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
npm exec -- expo prebuild --platform android --no-install
(cd android && ./gradlew --no-daemon --console=plain --init-script "$INIT" :app:assembleRelease)
APK="$PWD/android/app/build/outputs/apk/release/app-release.apk"
[[ -s "$APK" ]] || { echo 'Expected release APK missing.' >&2; exit 1; }
assert_source
cp "$APK" "$OUT/clave-release.apk"
node - "$OUT" "$ROOT" "$SOURCE_HEAD" "$SOURCE_TREE" "$SOURCE_LOCK_SHA256" "$SIGNING_MODE" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const [out, repository, head, tree, packageLockSha256, signingMode] = process.argv.slice(2)
const apk = path.join(out, 'clave-release.apk')
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex')
fs.writeFileSync(path.join(out, 'provenance.json'), JSON.stringify({
  platform: 'android', repository, head, tree, packageLockSha256, signingMode,
  createdAt: new Date().toISOString(), apk: { path: apk, sha256 }
}, null, 2) + '\n', { mode: 0o600 })
NODE
assert_source
echo "Signed release APK: $OUT/clave-release.apk"

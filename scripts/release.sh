#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[release]${NC} $*"; }
warn()  { echo -e "${YELLOW}[release]${NC} $*"; }
error() { echo -e "${RED}[release]${NC} $*" >&2; exit 1; }

RELEASE_BRANCH="prod"

# ── Usage ──────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $0 [--patch | --minor | --major | --version X.Y.Z]
       $0 --prerelease [--dry-run]

Flags:
  --patch          Bump patch version (e.g. 1.1.1 → 1.1.2)
  --minor          Bump minor version (e.g. 1.1.1 → 1.2.0)
  --major          Bump major version (e.g. 1.1.1 → 2.0.0)
  --version X.Y.Z  Set explicit version
  --prerelease     Cut a beta from the 'beta' branch (see below)
  --dry-run        With --prerelease: build and name everything, publish nothing
  --help           Show this help

A stable release (the prod path) will:
  1. Bump version in package.json
  2. Roll CHANGELOG.md [Unreleased] into the new version heading
  3. Stamp "next" entries in whats-new.json with the new version
  4. Commit (with "chore: bump version to X.Y.Z")
  5. Build, sign, and notarize the macOS app
  6. Tag, push, and create a GitHub Release (changelog section as notes)

A pre-release (--prerelease, the beta path) touches no file and pushes no
commit. The version is computed by scripts/prerelease-version.mjs — the
highest stable tag, bumped by the markers since it, plus -beta.N — and is
injected into the build with electron-builder's extraMetadata; the tag is
created server-side by 'gh release create --prerelease --target <sha>'.
The channel file is beta-mac.yml, which electron-updater asks for when
'Receive pre-release builds' is on and never otherwise. --dry-run builds the
current checkout on any branch and stops before anything leaves the machine.

Runs locally (sources .env for signing credentials) and in CI (credentials
from the environment; set CI=true, which GitHub Actions does automatically).
EOF
  exit 0
}

# ── Parse args ─────────────────────────────────────────────────────
BUMP=""
EXPLICIT_VERSION=""
PRERELEASE=""
DRY_RUN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --patch) BUMP="patch"; shift ;;
    --minor) BUMP="minor"; shift ;;
    --major) BUMP="major"; shift ;;
    --version)
      [[ -n "${2:-}" ]] || error "--version requires a semver argument (e.g. 1.2.3)"
      EXPLICIT_VERSION="$2"; shift 2 ;;
    --prerelease) PRERELEASE="1"; shift ;;
    --dry-run) DRY_RUN="1"; shift ;;
    --help|-h) usage ;;
    *) error "Unknown flag: $1. Use --help for usage." ;;
  esac
done

if [[ -n "$PRERELEASE" ]]; then
  [[ -z "$BUMP" && -z "$EXPLICIT_VERSION" ]] || \
    error "--prerelease computes its own version; drop --patch/--minor/--major/--version"
  RELEASE_BRANCH="beta"
else
  [[ -z "$DRY_RUN" ]] || error "--dry-run is only implemented for --prerelease"
fi

[[ -n "$BUMP" || -n "$EXPLICIT_VERSION" || -n "$PRERELEASE" ]] || {
  error "No version bump specified. Use --patch, --minor, --major, --version X.Y.Z, or --prerelease"
}

if [[ -n "$EXPLICIT_VERSION" ]]; then
  [[ "$EXPLICIT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
    error "Invalid version: '$EXPLICIT_VERSION'. Must be X.Y.Z"
fi

# ── Pre-flight checks ─────────────────────────────────────────────
command -v gh   >/dev/null 2>&1 || error "gh CLI not found. Install: brew install gh"
command -v node >/dev/null 2>&1 || error "node not found"
command -v npm  >/dev/null 2>&1 || error "npm not found"

BRANCH=$(git branch --show-current)
if [[ -n "$DRY_RUN" ]]; then
  # A dry run builds whatever is checked out, on any branch, and stops before
  # anything leaves the machine — the way to rehearse the beta path.
  warn "Dry run: building '${BRANCH:-detached}' as it is; nothing will be tagged, pushed or published"
elif [[ "$BRANCH" != "$RELEASE_BRANCH" ]]; then
  # CI checks out a detached SHA of the release branch; resolve it.
  if [[ -n "${CI:-}" && -z "$BRANCH" ]]; then
    git checkout "$RELEASE_BRANCH"
  else
    error "Must be on '$RELEASE_BRANCH' branch (currently on '${BRANCH:-detached}')"
  fi
fi

if [[ -n "${CI:-}" ]]; then
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
fi

if [[ -z "$DRY_RUN" ]]; then
  git fetch origin "$RELEASE_BRANCH"
  git merge --ff-only "origin/$RELEASE_BRANCH" || error "Failed to fast-forward to origin/$RELEASE_BRANCH"
fi

# ── Pre-release: compute the version, touch nothing ───────────────
# The beta path stops here and rejoins at the build. No bump, no changelog
# roll, no whats-new stamp, no commit: the version exists only in the tag
# GitHub creates and inside the artifacts, so the branch is never written to
# and a beta leaves nothing behind to back-merge.
if [[ -n "$PRERELEASE" ]]; then
  # Every tag, including the betas already out for this base (N depends on
  # them) and a stable tag newer than this branch's history knows.
  [[ -n "$DRY_RUN" ]] || git fetch --tags origin
  PRERELEASE_JSON=$(node scripts/prerelease-version.mjs --json) || error "Could not compute the pre-release version"
  NEW_VERSION=$(node -pe "JSON.parse(process.argv[1]).version" "$PRERELEASE_JSON")
  PREVIOUS_TAG=$(node -pe "JSON.parse(process.argv[1]).previousTag" "$PRERELEASE_JSON")
  PRERELEASE_ID="${NEW_VERSION#*-}"; PRERELEASE_ID="${PRERELEASE_ID%%.*}"
  [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[a-z]+\.[0-9]+$ ]] || error "Not a pre-release version: '$NEW_VERSION'"
  info "Pre-release version: ${NEW_VERSION} ($(node -pe "const r=JSON.parse(process.argv[1]); r.bump+' over '+r.stableTag+', notes since '+r.previousTag" "$PRERELEASE_JSON"))"
  if [[ -z "$DRY_RUN" ]]; then
    git rev-parse -q --verify "refs/tags/v${NEW_VERSION}" >/dev/null && error "Tag v${NEW_VERSION} already exists"
    gh release view "v${NEW_VERSION}" >/dev/null 2>&1 && error "Release v${NEW_VERSION} already exists on GitHub"
  fi
fi

# ── Bump version ───────────────────────────────────────────────────
CURRENT_VERSION=$(node -p "require('./package.json').version")

if [[ -z "$PRERELEASE" ]]; then

if [[ -n "$BUMP" ]]; then
  npm version "$BUMP" --no-git-tag-version >/dev/null
else
  npm version "$EXPLICIT_VERSION" --no-git-tag-version >/dev/null
fi

NEW_VERSION=$(node -p "require('./package.json').version")
info "Version: $CURRENT_VERSION → $NEW_VERSION"

# ── Roll CHANGELOG.md: [Unreleased] → [X.Y.Z] — date ──────────────
# Extract the unreleased body (between "## [Unreleased]" and the next "## [").
NOTES_FILE="$(mktemp)"
awk '/^## \[Unreleased\]/{flag=1; next} /^## \[/{flag=0} flag' CHANGELOG.md \
  | sed -e '/./,$!d' > "$NOTES_FILE"

if [[ -s "$NOTES_FILE" ]]; then
  TODAY=$(date +%Y-%m-%d)
  perl -0pi -e "s/## \[Unreleased\]\n/## [Unreleased]\n\n## [${NEW_VERSION}] — ${TODAY}\n/" CHANGELOG.md
  info "CHANGELOG.md: rolled [Unreleased] into [${NEW_VERSION}]"
else
  warn "CHANGELOG.md has no [Unreleased] entries — release notes will be auto-generated"
fi

# ── Stamp whats-new.json: "next" → new version ────────────────────
WHATS_NEW="src/renderer/src/help/whats-new.json"
if [[ -f "$WHATS_NEW" ]] && grep -q '"version": "next"' "$WHATS_NEW"; then
  node -e "
    const fs = require('fs');
    const p = '$WHATS_NEW';
    const entries = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const e of entries) if (e.version === 'next') e.version = '$NEW_VERSION';
    fs.writeFileSync(p, JSON.stringify(entries, null, 2) + '\n');
  "
  info "whats-new.json: stamped 'next' entries as ${NEW_VERSION}"
fi

# ── Commit all changes (version bump + any staged/unstaged work) ──
git add -A
# [skip ci] guards against workflow recursion when CI pushes this commit back.
git commit -m "chore: bump version to ${NEW_VERSION} [skip ci]"
info "Committed version bump"
fi # end of the stable-only bump/changelog/commit block

# ── Build ──────────────────────────────────────────────────────────
info "Building macOS app (this takes a few minutes)..."

if [[ -f .env ]]; then
  info "Sourcing .env for signing credentials"
  set -a; source .env; set +a
elif [[ -z "${CSC_LINK:-}" ]]; then
  error "No .env and no CSC_LINK in the environment — cannot sign"
fi

# ── Signing keychain ───────────────────────────────────────────────
# We build the keychain ourselves rather than letting electron-builder do it.
# Its createKeychain() calls
#   security set-key-partition-list ... -k "$CSC_KEY_PASSWORD" <keychain>
# passing the CERTIFICATE's password where security expects the KEYCHAIN's (the
# latter being a random string it generates), and fails the build with a
# misleading "SecKeychainUnlock: the user name or passphrase you entered is not
# correct" — which reads as a bad CSC_KEY_PASSWORD secret and is not one.
#
# This worked in our CI for a long time and then stopped. The last green and
# first red builds differ only in the GitHub runner image (macos-26-arm64
# 20260728.0273 -> 20260831.0337): same code, same electron-builder 26.7.0, same
# credentials. We could not reproduce a passing set-key-partition-list with
# mismatched passwords locally, so what the old environment did differently is
# unexplained — the original logs expired before we could dig further. Verified:
# -k is validated against the keychain, the call is awaited unguarded so a
# failure is fatal, and the line is unchanged in 26.16.0, so upgrading is no fix.
#
# electron-builder skips its own keychain entirely when CSC_LINK is unset and
# uses CSC_KEYCHAIN as given (macPackager.js: `selected == null` →
# `{ keychainFile: process.env.CSC_KEYCHAIN }`), which is the seam we use: import
# the cert here, unlock it correctly, hand over the keychain, and unset CSC_LINK
# for the build so the buggy path is never entered.
setup_keychain() {
  local p12 keychain_pass
  KEYCHAIN="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/clave-signing-$$.keychain-db"
  keychain_pass="$(openssl rand -base64 24)"
  p12="$(mktemp -t clave-cert).p12"

  # CSC_LINK is a base64 .p12 in CI, a file path locally.
  if [[ -f "$CSC_LINK" ]]; then
    cp "$CSC_LINK" "$p12"
  else
    base64 --decode <<<"$CSC_LINK" > "$p12"
  fi

  security create-keychain -p "$keychain_pass" "$KEYCHAIN"
  # No -t/-u: clears the default lock-on-sleep timeout, so the keychain stays
  # usable for the whole build.
  security set-keychain-settings "$KEYCHAIN"
  security unlock-keychain -p "$keychain_pass" "$KEYCHAIN"

  security import "$p12" -k "$KEYCHAIN" -P "${CSC_KEY_PASSWORD:-}" \
    -T /usr/bin/codesign -T /usr/bin/productbuild >/dev/null
  rm -f "$p12"

  # -k takes the KEYCHAIN password — the argument electron-builder gets wrong.
  security set-key-partition-list -S apple-tool:,apple: -s \
    -k "$keychain_pass" "$KEYCHAIN" >/dev/null

  # Keep it on the search list so codesign can find the identity.
  security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')

  # Report what landed. Not fatal on its own: electron-builder fails clearly
  # enough if the identity is genuinely missing, and a mis-parse here should
  # never be what blocks a release.
  local found
  found=$(security find-identity -v -p codesigning "$KEYCHAIN" | grep -c "Developer ID Application" || true)
  if [[ "$found" -gt 0 ]]; then
    info "Signing keychain ready ($found Developer ID Application identity)"
  else
    warn "No Developer ID Application identity found after import — letting the build be the judge"
    security find-identity -v -p codesigning "$KEYCHAIN" || true
  fi
}

cleanup_keychain() {
  [[ -n "${KEYCHAIN:-}" && -f "$KEYCHAIN" ]] || return 0
  security list-keychains -d user -s $(security list-keychains -d user | tr -d '"' | grep -v "$KEYCHAIN") 2>/dev/null || true
  security delete-keychain "$KEYCHAIN" 2>/dev/null || true
}
trap cleanup_keychain EXIT

setup_keychain
export CSC_KEYCHAIN="$KEYCHAIN"
# Must be unset, or electron-builder creates its own keychain down the buggy path.
unset CSC_LINK CSC_KEY_PASSWORD

if [[ -n "$PRERELEASE" ]]; then
  # The version rides in as extraMetadata (deep-merged into the packaged
  # package.json, so app.getVersion() and every artifact name carry it) and
  # the publish channel is the pre-release id: electron-builder names the
  # update feed after the channel ('beta' → beta-mac.yml), which is the file
  # electron-updater asks for first on a -beta tag when pre-releases are
  # allowed. '--publish never' because gh publishes, not electron-builder.
  npm run build:mac -- --publish never \
    --config.extraMetadata.version="${NEW_VERSION}" \
    --config.publish.channel="${PRERELEASE_ID}"
else
  npm run build:mac
fi

# ── Verify artifacts ───────────────────────────────────────────────
DMG=$(ls dist/clave-"${NEW_VERSION}".dmg 2>/dev/null || true)
ZIP=$(ls dist/Clave-"${NEW_VERSION}"-universal-mac.zip 2>/dev/null || true)
if [[ -n "$PRERELEASE" ]]; then
  YML=$(ls dist/"${PRERELEASE_ID}"-mac.yml 2>/dev/null || true)
  [[ -n "$YML" ]] || error "${PRERELEASE_ID}-mac.yml not found in dist/ (the channel file a pre-release must carry)"
  # What a stable user must never see is 'latest' anything on a pre-release.
  [[ ! -f dist/latest-mac.yml ]] || error "latest-mac.yml was written for a pre-release build — refusing to publish it"
else
YML=$(ls dist/latest-mac.yml 2>/dev/null || true)
fi
BLOCKMAP=$(ls dist/clave-"${NEW_VERSION}".dmg.blockmap 2>/dev/null || true)
ZIP_BLOCKMAP=$(ls dist/Clave-"${NEW_VERSION}"-universal-mac.zip.blockmap 2>/dev/null || true)

[[ -n "$DMG" ]] || error "DMG not found in dist/"
[[ -n "$ZIP" ]] || error "ZIP not found in dist/"
[[ -n "$YML" ]] || error "latest-mac.yml not found in dist/"

info "Build artifacts:"
ls -lh "$DMG" "$ZIP" "$YML" ${BLOCKMAP:+"$BLOCKMAP"} ${ZIP_BLOCKMAP:+"$ZIP_BLOCKMAP"}

ASSETS=("$DMG" "$ZIP" "$YML")
[[ -n "$BLOCKMAP" ]] && ASSETS+=("$BLOCKMAP")
[[ -n "$ZIP_BLOCKMAP" ]] && ASSETS+=("$ZIP_BLOCKMAP")

# ── Pre-release: a GitHub pre-release on the pushed sha, no push ──
if [[ -n "$PRERELEASE" ]]; then
  HEAD_SHA=$(git rev-parse HEAD)
  if [[ -n "$DRY_RUN" ]]; then
    info "Dry run complete. Would have run:"
    info "  gh release create v${NEW_VERSION} --prerelease --target ${HEAD_SHA} --title v${NEW_VERSION} --generate-notes --notes-start-tag ${PREVIOUS_TAG} ${ASSETS[*]}"
    info "Nothing was tagged, pushed or published."
    exit 0
  fi
  # No local tag, no push: '--target <sha>' has GitHub create the tag on the
  # commit that was pushed to beta, so the branch itself is never written to.
  # '--prerelease' is what keeps it out of /releases/latest, the endpoint a
  # stable install reads.
  gh release create "v${NEW_VERSION}" \
    --prerelease \
    --target "${HEAD_SHA}" \
    --title "v${NEW_VERSION}" \
    --generate-notes \
    --notes-start-tag "${PREVIOUS_TAG}" \
    "${ASSETS[@]}"
  info "Pre-release v${NEW_VERSION} published!"
  info "https://github.com/antasphere/clave/releases/tag/v${NEW_VERSION}"
  exit 0
fi

# ── Tag, push, release ────────────────────────────────────────────
git tag -a "v${NEW_VERSION}" -m "v${NEW_VERSION}"
git push origin "$RELEASE_BRANCH" --follow-tags
info "Pushed v${NEW_VERSION} to origin"

if [[ -s "$NOTES_FILE" ]]; then
  gh release create "v${NEW_VERSION}" \
    --title "v${NEW_VERSION}" \
    --notes-file "$NOTES_FILE" \
    "${ASSETS[@]}"
else
  gh release create "v${NEW_VERSION}" \
    --title "v${NEW_VERSION}" \
    --generate-notes \
    "${ASSETS[@]}"
fi
rm -f "$NOTES_FILE"

info "Release v${NEW_VERSION} published!"
info "https://github.com/antasphere/clave/releases/tag/v${NEW_VERSION}"

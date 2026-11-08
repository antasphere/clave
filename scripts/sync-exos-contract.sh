#!/usr/bin/env bash
# Refresh Clave's verbatim mirror of the exos workstream-events contract.
#
#   scripts/sync-exos-contract.sh <path-to-exos-monorepo-checkout>
#
# Copies packages/contract/src/workstream-events.ts and the §6.3 fixtures into
# packages/host/src/exchange-capture/contract/, stamping the exos commit sha the copy
# mirrors. Never edit the mirror by hand; run the conformance test after.
set -euo pipefail
EXOS="${1:?usage: $0 <exos-monorepo-checkout>}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HERE/src/main/exchange-capture/contract"
SHA="$(git -C "$EXOS" rev-parse --short HEAD)"
BRANCH="$(git -C "$EXOS" rev-parse --abbrev-ref HEAD)"
mkdir -p "$DEST/fixtures"
{
  echo "/* eslint-disable */"
  echo "// MIRROR of @exos/contract packages/contract/src/workstream-events.ts at exos commit $SHA"
  echo "// (antasphere/exos, branch $BRANCH). Clave never depends on exos: this file is a"
  echo "// verbatim copy of the contract module — regenerate it with scripts/sync-exos-contract.sh, never"
  echo "// edit it by hand. The conformance test (contract.test.ts) pins it against the copied fixtures."
  cat "$EXOS/packages/contract/src/workstream-events.ts"
} > "$DEST/workstream-events.ts"
rm -rf "$DEST/fixtures/transcript"
cp -R "$EXOS/packages/contract/tests/fixtures/transcript" "$DEST/fixtures/"
cp "$EXOS"/packages/contract/tests/fixtures/events.*.jsonl "$DEST/fixtures/"
echo "mirrored exos@$SHA into $DEST"

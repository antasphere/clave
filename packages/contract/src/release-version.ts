/**
 * What a Clave release tag names (issue #266): `v` and a strict semver
 * version without build metadata. Pure and free of Effect on purpose: the
 * desktop's version sync applies it in main at boot, where no Effect module
 * may load (`src/main/server/lazy-load.test.ts`); `server-info.ts` re-exports it.
 */
/** Strict semver without build metadata: what a Clave release tag carries
 *  after its `v` (`3.0.0`, `3.0.0-beta.9`). Numeric identifiers have no
 *  leading zero, as semver says. */
const RELEASE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/
/** Longer than any real release, short enough to never matter in a log. */
const MAX_VERSION_LENGTH = 64

/** Whether `value` is a version a release tag `v<value>` can name. */
export function isReleaseVersion(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= MAX_VERSION_LENGTH && RELEASE_VERSION.test(value)
  )
}

/** Whether `ref` is a release tag (`v<semver>`), the only ref a Mac follows. */
export function isReleaseTag(ref: unknown): ref is string {
  return typeof ref === 'string' && ref.startsWith('v') && isReleaseVersion(ref.slice(1))
}

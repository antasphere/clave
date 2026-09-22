/**
 * What a version string says about its channel, shared by main and renderer.
 *
 * A pre-release is `X.Y.Z-<id>.N` (`2.0.0-beta.1`); the id names the channel
 * the build came from. Kept to a regex rather than `semver` so the renderer
 * bundle needs no dependency for a question this small, and so the two sides
 * cannot disagree on what counts as a pre-release.
 */
const PRERELEASE = /^\d+\.\d+\.\d+-([0-9A-Za-z]+)(?:[.-][0-9A-Za-z.-]*)?$/

/** `2.0.0-beta.1` → true; `2.0.0` → false. */
export function isPrereleaseVersion(version: string): boolean {
  return PRERELEASE.test(version)
}

/** `2.0.0-beta.1` → `beta`; a stable version → null. */
export function prereleaseIdOf(version: string): string | null {
  const m = PRERELEASE.exec(version)
  return m ? m[1] : null
}

/**
 * The word on the mark next to a pre-release version: the channel's own name
 * when it is one of the two conventional ids, "Pre-release" otherwise.
 */
export function prereleaseLabel(version: string): string | null {
  const id = prereleaseIdOf(version)
  if (id === null) return null
  if (id === 'beta') return 'Beta'
  if (id === 'alpha') return 'Alpha'
  return 'Pre-release'
}

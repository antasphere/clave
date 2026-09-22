#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by release.sh */
// The version of the next pre-release, as a pure function of the repository's
// tags and the commit subjects since the last stable release.
//
//   base    = the HIGHEST stable `vX.Y.Z` tag, bumped by the highest marker
//             opening a subject in `<that tag>..HEAD` ([major] > [minor] > patch)
//   version = `<base>-beta.N`, N = 1 + the highest N already tagged for that base
//
// Two choices worth their sentence. The base is the highest stable tag in the
// repo, not the nearest one reachable from HEAD (`git describe`, which the prod
// path uses): CI bumps the version ON prod and the back-merge into dev lags,
// so a beta cut from a branch that has not received the last back-merge would
// otherwise compute a version BELOW the stable already out — 1.91.0-beta.1
// while v1.91.0 is what everyone runs — and no stable user could ever be
// offered it. And N is 1 + the highest existing N rather than 1 + the count:
// a beta deleted from GitHub must not hand its number to the next one.
//
// `release.sh --prerelease` runs this file; the functions are exported so the
// unit test can feed it a fake tag list and go red when N or the bump is wrong.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const STABLE = /^v(\d+)\.(\d+)\.(\d+)$/
export const PRERELEASE_ID = 'beta'

/** `v1.2.3` → `[1, 2, 3]`; anything else (a beta tag, a stray tag) → null. */
export function parseStableTag(tag) {
  const m = STABLE.exec(tag)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function compareTriples(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/** The highest stable tag among `tags`, or null when there is none. */
export function highestStableTag(tags) {
  let best = null
  for (const tag of tags) {
    const v = parseStableTag(tag)
    if (v && (best === null || compareTriples(v, best.v) > 0)) best = { tag, v }
  }
  return best ? best.tag : null
}

/**
 * The same read as the prod path (release.yml, "Determine bump level"):
 * SUBJECTS only, and the marker must OPEN the subject.
 */
export function bumpFromSubjects(subjects) {
  if (subjects.some((s) => /^\[major\]/.test(s))) return 'major'
  if (subjects.some((s) => /^\[minor\]/.test(s))) return 'minor'
  return 'patch'
}

export function applyBump(stableTag, bump) {
  const v = parseStableTag(stableTag)
  if (!v) throw new Error(`not a stable tag: ${stableTag}`)
  const [major, minor, patch] = v
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** The N of every `v<base>-beta.N` tag, highest first. */
export function betaNumbersFor(tags, base) {
  const re = new RegExp(`^v${base.replace(/\./g, '\\.')}-${PRERELEASE_ID}\\.(\\d+)$`)
  return tags
    .map((t) => re.exec(t))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a)
}

/**
 * The whole computation. `tags` is every tag in the repo, `subjects` the
 * commit subjects of `<stableTag>..HEAD` (the caller runs the git log, since
 * the range depends on the tag this function picks — see `fromGit`).
 */
export function computePrereleaseVersion({ tags, subjects }) {
  const stableTag = highestStableTag(tags)
  if (!stableTag) throw new Error('no stable v*.*.* tag to base a pre-release on')
  const bump = bumpFromSubjects(subjects)
  const base = applyBump(stableTag, bump)
  const existing = betaNumbersFor(tags, base)
  const n = (existing[0] ?? 0) + 1
  return {
    stableTag,
    bump,
    base,
    n,
    version: `${base}-${PRERELEASE_ID}.${n}`,
    // What the release notes are generated against: the previous beta on
    // this base when there is one, else the stable release it grows from.
    previousTag: existing.length > 0 ? `v${base}-${PRERELEASE_ID}.${existing[0]}` : stableTag
  }
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf-8' })
}

/** The computation against the real repository (cwd). */
export function fromGit() {
  const tags = git(['tag', '-l', 'v*']).split('\n').filter(Boolean)
  const stableTag = highestStableTag(tags)
  if (!stableTag) throw new Error('no stable v*.*.* tag to base a pre-release on')
  const subjects = git(['log', '--pretty=%s', `${stableTag}..HEAD`])
    .split('\n')
    .filter(Boolean)
  return { ...computePrereleaseVersion({ tags, subjects }), subjects }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = fromGit()
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else {
    process.stdout.write(result.version + '\n')
  }
}

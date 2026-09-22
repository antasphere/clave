import { describe, it, expect } from 'vitest'
import {
  applyBump,
  betaNumbersFor,
  bumpFromSubjects,
  computePrereleaseVersion,
  highestStableTag,
  parseStableTag
} from './prerelease-version.mjs'

// Every case here is a version the pipeline could publish wrong without anyone
// noticing until a user is offered the wrong build: a beta numbered below the
// stable everyone runs, a beta number reused, a marker read from the wrong
// place. The script is pure so these can say exactly what N and what bump.

describe('highestStableTag', () => {
  it('picks the highest stable tag by semver, not by string order', () => {
    expect(highestStableTag(['v1.9.0', 'v1.91.0', 'v1.10.2'])).toBe('v1.91.0')
  })

  it('ignores pre-release tags when looking for the stable base', () => {
    expect(highestStableTag(['v1.91.0', 'v2.0.0-beta.1', 'v2.0.0-beta.2'])).toBe('v1.91.0')
  })

  it('returns null when nothing stable is tagged', () => {
    expect(highestStableTag(['v2.0.0-beta.1', 'nightly'])).toBeNull()
    expect(parseStableTag('v2.0.0-beta.1')).toBeNull()
  })
})

describe('bumpFromSubjects', () => {
  it('reads the marker where the prod path reads it: opening the subject', () => {
    expect(bumpFromSubjects(['[minor] Beta channel', 'fix: typo'])).toBe('minor')
    expect(bumpFromSubjects(['[major] Form factor', '[minor] x'])).toBe('major')
    expect(bumpFromSubjects(['fix: a', 'chore: b'])).toBe('patch')
  })

  it('does not count a marker mentioned mid-sentence', () => {
    expect(bumpFromSubjects(['docs: explain that [major] beats [minor]'])).toBe('patch')
  })
})

describe('applyBump', () => {
  it('bumps each level and resets the lower ones', () => {
    expect(applyBump('v1.91.2', 'major')).toBe('2.0.0')
    expect(applyBump('v1.91.2', 'minor')).toBe('1.92.0')
    expect(applyBump('v1.91.2', 'patch')).toBe('1.91.3')
  })
})

describe('betaNumbersFor', () => {
  it('lists the betas of exactly that base, highest first', () => {
    const tags = [
      'v2.0.0-beta.1',
      'v2.0.0-beta.3',
      'v2.0.0-beta.2',
      'v2.0.1-beta.1',
      'v20.0.0-beta.9'
    ]
    expect(betaNumbersFor(tags, '2.0.0')).toEqual([3, 2, 1])
  })
})

describe('computePrereleaseVersion', () => {
  it("the brief's example: last stable v1.92.0, a [major] in range, two betas out → 2.0.0-beta.3", () => {
    const result = computePrereleaseVersion({
      tags: ['v1.91.0', 'v1.92.0', 'v2.0.0-beta.1', 'v2.0.0-beta.2'],
      subjects: ['[major] Form factor', 'fix: something']
    })
    expect(result.version).toBe('2.0.0-beta.3')
    expect(result.bump).toBe('major')
    expect(result.previousTag).toBe('v2.0.0-beta.2')
  })

  it('starts at beta.1 for a base with no betas, with notes against the stable', () => {
    const result = computePrereleaseVersion({
      tags: ['v1.91.0'],
      subjects: ['[minor] Beta channel']
    })
    expect(result.version).toBe('1.92.0-beta.1')
    expect(result.previousTag).toBe('v1.91.0')
  })

  it('a patch-only range still gets a beta, one patch above the stable', () => {
    const result = computePrereleaseVersion({ tags: ['v1.91.0'], subjects: ['fix: a'] })
    expect(result.version).toBe('1.91.1-beta.1')
  })

  it('never hands a deleted beta number to the next one', () => {
    // beta.2 was deleted from GitHub; the next must be beta.4, not beta.3.
    const result = computePrereleaseVersion({
      tags: ['v1.91.0', 'v2.0.0-beta.1', 'v2.0.0-beta.3'],
      subjects: ['[major] x']
    })
    expect(result.version).toBe('2.0.0-beta.4')
  })

  it('betas of another base do not count towards N', () => {
    const result = computePrereleaseVersion({
      tags: ['v1.91.0', 'v1.92.0-beta.1', 'v1.92.0-beta.2'],
      subjects: ['[major] x']
    })
    expect(result.version).toBe('2.0.0-beta.1')
  })

  it('bases on the highest stable tag even when a newer one exists than the branch knows', () => {
    // dev tags v1.90.2 as reachable; prod already cut v1.91.0. A beta must
    // not be versioned below what everyone runs.
    const result = computePrereleaseVersion({
      tags: ['v1.90.2', 'v1.91.0'],
      subjects: ['fix: a']
    })
    expect(result.version).toBe('1.91.1-beta.1')
  })

  it('refuses to run without a stable base', () => {
    expect(() => computePrereleaseVersion({ tags: ['v2.0.0-beta.1'], subjects: [] })).toThrow()
  })
})

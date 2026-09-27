/**
 * The density presets, the text size, and what the app boots on.
 *
 * The E2E spec measures the presets in the rendered app. This pins what the
 * tables promise and an end-to-end run cannot see: the default is Comfortable,
 * a saved id that is not a preset never reaches `data-density`, and the old
 * multiplier's saved stops land on the preset that looks like them — in
 * particular its `regular` (scale 1, the 2026-09-21 spec) is `compact`, not
 * the old key's own `compact` (0.875).
 */
import { describe, it, expect } from 'vitest'
import {
  DENSITY_LEVELS,
  DEFAULT_DENSITY,
  densityIndex,
  resolveDensity,
  TEXT_SIZE_LEVELS,
  DEFAULT_TEXT_SIZE,
  resolveTextSize,
  textSizeOffset
} from './session-types'

describe('the density presets', () => {
  it('are the five presets, tightest to loosest', () => {
    expect(DENSITY_LEVELS.map((level) => level.id)).toEqual([
      'tight',
      'compact',
      'balanced',
      'comfortable',
      'spacious'
    ])
  })

  it('open on Comfortable', () => {
    expect(DEFAULT_DENSITY).toBe('comfortable')
    expect(resolveDensity(null)).toBe('comfortable')
  })

  it('resolve every preset to itself and its position', () => {
    DENSITY_LEVELS.forEach((level, i) => {
      expect(resolveDensity(level.id)).toBe(level.id)
      expect(densityIndex(level.id)).toBe(i)
    })
  })

  it.each(['enormous', '', '1.125', '__proto__', 'Compact', ' compact', 'regular'])(
    'refuse %j under the new key rather than normalising it',
    (saved) => {
      expect(resolveDensity(saved)).toBe(DEFAULT_DENSITY)
    }
  )
})

describe('the old multiplier slider, migrated', () => {
  it.each([
    ['compact', 'tight'],
    ['snug', 'tight'],
    ['regular', 'compact'],
    ['relaxed', 'balanced'],
    ['spacious', 'comfortable']
  ])('%j becomes %j', (legacy, preset) => {
    expect(resolveDensity(null, legacy)).toBe(preset)
  })

  it('never overrides a preset saved under the new key', () => {
    expect(resolveDensity('spacious', 'regular')).toBe('spacious')
  })

  it.each(['__proto__', 'toString', 'enormous'])('ignores %j', (legacy) => {
    expect(resolveDensity(null, legacy)).toBe(DEFAULT_DENSITY)
  })
})

describe('the text size', () => {
  it('adds nothing at Default, and at most 2px', () => {
    expect(textSizeOffset(DEFAULT_TEXT_SIZE)).toBe(0)
    expect(TEXT_SIZE_LEVELS.map((level) => level.offset)).toEqual([-1, 0, 1, 2])
  })

  it('falls back to Default for an id that is not a size', () => {
    expect(resolveTextSize(null)).toBe('default')
    expect(resolveTextSize('huge')).toBe('default')
    expect(resolveTextSize('larger')).toBe('larger')
  })
})

/**
 * The density table and the stop the app boots on.
 *
 * The E2E spec proves the slider moves the app. This proves the two promises
 * the table itself makes, neither of which an end-to-end run can see:
 *
 *  - the MIDDLE stop is exactly 1. Every metric in tokens.css is written as
 *    calc(<its old literal> * var(--density)), so 1 is what makes the default
 *    the file as it was before the scale existed. A middle stop of 0.98 would
 *    look completely normal on screen and would have moved every control in
 *    the app by half a pixel for every user who never opens Appearance.
 *  - a saved id that is not a stop never reaches `--density`. The value is
 *    read out of localStorage and written into a CSS length multiplier; the
 *    engine's answer to a multiplier it cannot parse is to invalidate every
 *    calc() in the spec at once, without throwing, warning or logging.
 */
import { describe, it, expect } from 'vitest'
import {
  DENSITY_LEVELS,
  DEFAULT_DENSITY,
  densityScale,
  densityIndex,
  resolveDensity
} from './session-types'

describe('the density table', () => {
  it('has five stops, ordered from tightest to loosest', () => {
    expect(DENSITY_LEVELS).toHaveLength(5)
    const scales = DENSITY_LEVELS.map((level) => level.scale)
    expect(scales).toEqual([...scales].sort((a, b) => a - b))
    expect(new Set(scales).size).toBe(scales.length)
  })

  it('puts the default in the middle, at exactly 1', () => {
    const middle = DENSITY_LEVELS[Math.floor(DENSITY_LEVELS.length / 2)]
    expect(middle.id).toBe(DEFAULT_DENSITY)
    expect(middle.scale).toBe(1)
    expect(densityScale(DEFAULT_DENSITY)).toBe(1)
  })

  it('reaches the row the sidebar had before 2026-09-20 at its loosest', () => {
    // 28px is --control-h-md; the team's complaint was that it replaced 32px.
    const loosest = DENSITY_LEVELS[DENSITY_LEVELS.length - 1]
    expect(28 * loosest.scale).toBeGreaterThan(31)
    expect(28 * loosest.scale).toBeLessThanOrEqual(32)
  })

  it('resolves every stop to its own scale and position', () => {
    DENSITY_LEVELS.forEach((level, i) => {
      expect(densityScale(level.id)).toBe(level.scale)
      expect(densityIndex(level.id)).toBe(i)
    })
  })

  it('falls back to the default for an id that is not a stop', () => {
    // Cast: the point of the check is precisely the value the type forbids.
    expect(densityScale('enormous' as never)).toBe(1)
    expect(densityIndex('enormous' as never)).toBe(
      DENSITY_LEVELS.indexOf(DENSITY_LEVELS.find((level) => level.id === DEFAULT_DENSITY)!)
    )
  })
})

describe('the stop the app boots on', () => {
  it('is the default when nothing was ever saved', () => {
    expect(resolveDensity(null)).toBe(DEFAULT_DENSITY)
  })

  it('is the saved stop when one was', () => {
    expect(resolveDensity('spacious')).toBe('spacious')
  })

  /* Every case here names a stop that is NOT the default's own id. That is the
     point, and it was got wrong first time: `'Regular'`, `'REGULAR'` and
     `' regular'` are satisfied equally by refusing them and by normalising
     them, so a `resolveDensity` loosened to `.trim().toLowerCase()` kept the
     file green (round-1 review, mutation M15). Casing and whitespace variants
     of SPACIOUS cannot pass by normalisation: a normalising implementation
     would return 'spacious', which is not the default. */
  it.each(['enormous', '', '1.125', '__proto__', 'Spacious', 'SPACIOUS', ' spacious'])(
    'refuses %j and returns the default rather than normalising it',
    (saved) => {
      const density = resolveDensity(saved)
      expect(DENSITY_LEVELS.map((level) => level.id)).toContain(density)
      expect(density).toBe(DEFAULT_DENSITY)
    }
  )
})

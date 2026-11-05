import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, GAP_MAX, GAP_MIN, parseGap, parseSettings } from './settings'

describe('parseGap', () => {
  it('takes a whole number of minutes within the bounds, as a number or a string', () => {
    expect(parseGap('15')).toBe(15)
    expect(parseGap(15)).toBe(15)
    expect(parseGap(1)).toBe(1)
    expect(parseGap(1440)).toBe(1440)
  })

  it('refuses anything else', () => {
    for (const value of [0, 1441, 12.5, '12.5', '', 'abc', null, undefined, true]) {
      expect(parseGap(value), String(value)).toBeNull()
    }
  })
})

describe('parseSettings', () => {
  it('reads the gap of a file and takes the default for anything off', () => {
    expect(parseSettings({})).toEqual({ gapMinutes: 15 })
    expect(parseSettings({ gapMinutes: 90 })).toEqual({ gapMinutes: 90 })
    expect(parseSettings({ gapMinutes: 0 })).toEqual({ gapMinutes: 15 })
    expect(parseSettings(null)).toEqual({ gapMinutes: 15 })
    expect(parseSettings([1])).toEqual({ gapMinutes: 15 })
  })

  it('says the defaults and the bounds', () => {
    expect(DEFAULT_SETTINGS).toEqual({ gapMinutes: 15 })
    expect(GAP_MIN).toBe(1)
    expect(GAP_MAX).toBe(1440)
  })
})

import { describe, expect, it } from 'vitest'
import {
  clockOf,
  dragSeek,
  partFor,
  partPlace,
  partTicks,
  scrubFill,
  scrubShown,
  tickAt
} from './progress'

/* The reading's place on its page (PRDCT-4430): parts to blocks, the
   bar's ticks and fill, the pointer's tick, the clock. */

const parts = [
  { block: 1, text: 'One.' },
  { block: 2, text: 'Two, first half.' },
  { block: 2, text: 'Two, second half.' },
  { block: 4, text: 'Four.' }
]

describe('the reading on its page', () => {
  it('has one tick per block read, in order', () => {
    expect(partTicks(parts)).toEqual([1, 2, 4])
    expect(partTicks([{ block: 0, text: 'All.' }])).toEqual([0])
    expect(partTicks([])).toEqual([])
  })

  it('places a part on its block and tick, a block in two parts counting halves', () => {
    expect(partPlace(parts, 0)).toEqual({ block: 1, tick: 0, fraction: 0 })
    expect(partPlace(parts, 1, 0.5)).toEqual({ block: 2, tick: 1, fraction: 0.25 })
    expect(partPlace(parts, 2, 0.5)).toEqual({ block: 2, tick: 1, fraction: 0.75 })
    expect(partPlace(parts, 3, 1)).toEqual({ block: 4, tick: 2, fraction: 1 })
    // A rendering without blocks lights nothing.
    expect(partPlace([{ block: 0, text: 'All.' }], 0).block).toBeNull()
  })

  it('starts a block at its first part, or the next block that speaks', () => {
    expect(partFor(parts, 2)).toBe(1)
    expect(partFor(parts, 3)).toBe(3)
    expect(partFor(parts, 9)).toBe(-1)
    expect(partFor([{ block: 0, text: 'All.' }], 0)).toBe(0)
  })

  it('fills the bar by ticks and the share of the one in play', () => {
    expect(scrubFill(0, 4, 0)).toBe(0)
    expect(scrubFill(1, 4, 0.5)).toBe(0.375)
    expect(scrubFill(3, 4, 1)).toBe(1)
    expect(scrubFill(0, 0, 0.5)).toBe(0)
    expect(scrubFill(2, 4, 7)).toBe(0.75)
  })

  it('finds the tick under the pointer, clamped to the bar', () => {
    expect(tickAt(0, 200, 4)).toBe(0)
    expect(tickAt(99, 200, 4)).toBe(1)
    expect(tickAt(100, 200, 4)).toBe(2)
    expect(tickAt(250, 200, 4)).toBe(3)
    expect(tickAt(-10, 200, 4)).toBe(0)
  })

  it('a drag moves the light only; the bar shows the reading again once let go (verifier round 3)', () => {
    expect(scrubShown(1, 0.5, 4, null)).toEqual({ tick: 1, fill: 0.375 })
    expect(scrubShown(1, 0.5, 4, 3)).toEqual({ tick: 3, fill: 0.75 })
    expect(scrubShown(1, 0.5, 4, 0)).toEqual({ tick: 0, fill: 0 })
  })

  it('a press seeks once, where it is let go, and never the tick in play (verifier round 3)', () => {
    expect(dragSeek(11, 0)).toBe(11)
    expect(dragSeek(0, 0)).toBeNull()
    expect(dragSeek(null, 3)).toBeNull()
  })

  it('reads the clock as m:ss, and –:–– while unknown', () => {
    expect(clockOf(null)).toBe('–:––')
    expect(clockOf(0)).toBe('0:00')
    expect(clockOf(65_400)).toBe('1:05')
    expect(clockOf(600_000)).toBe('10:00')
  })
})

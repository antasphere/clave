import { describe, expect, it } from 'vitest'
import { rowZone, ZONE_BAND, type RowZone } from './sidebar-drop-zones'

const zone = (
  frac: number,
  held: RowZone | null = null,
  nestable = true,
  nestOpen = false
): RowZone => rowZone({ frac, held, nestable, nestOpen })

describe('a row the dragged tab cannot be nested under', () => {
  it('offers two halves', () => {
    expect(zone(0.1, null, false)).toBe('before')
    expect(zone(0.49, null, false)).toBe('before')
    expect(zone(0.5, null, false)).toBe('after')
    expect(zone(0.9, null, false)).toBe('after')
  })

  it('holds a half until the cursor is a band past the middle', () => {
    expect(zone(0.5 + ZONE_BAND - 0.01, 'before', false)).toBe('before')
    expect(zone(0.5 + ZONE_BAND + 0.01, 'before', false)).toBe('after')
    expect(zone(0.5 - ZONE_BAND + 0.01, 'after', false)).toBe('after')
    expect(zone(0.5 - ZONE_BAND - 0.01, 'after', false)).toBe('before')
  })

  it('never answers onto, even when onto was held', () => {
    for (const frac of [0, 0.3, 0.5, 0.7, 1]) expect(zone(frac, 'onto', false)).not.toBe('onto')
  })
})

describe('a row the dragged tab can be nested under', () => {
  it('offers before, onto and after', () => {
    expect(zone(0.1)).toBe('before')
    expect(zone(0.29)).toBe('before')
    expect(zone(0.3)).toBe('onto')
    expect(zone(0.5)).toBe('onto')
    expect(zone(0.7)).toBe('onto')
    expect(zone(0.71)).toBe('after')
    expect(zone(1)).toBe('after')
  })

  it('does not flicker for a cursor resting on a boundary', () => {
    expect(zone(0.3, 'before')).toBe('before')
    expect(zone(0.3, 'onto')).toBe('onto')
    expect(zone(0.7, 'onto')).toBe('onto')
    expect(zone(0.7, 'after')).toBe('after')
  })

  it('leaves a held zone only past the band', () => {
    expect(zone(0.3 + ZONE_BAND - 0.01, 'before')).toBe('before')
    expect(zone(0.3 + ZONE_BAND + 0.01, 'before')).toBe('onto')
    expect(zone(0.75, 'before')).toBe('after')
    expect(zone(0.7 - ZONE_BAND + 0.01, 'after')).toBe('after')
    expect(zone(0.7 - ZONE_BAND - 0.01, 'after')).toBe('onto')
    expect(zone(0.2, 'after')).toBe('before')
    expect(zone(0.3 - ZONE_BAND + 0.01, 'onto')).toBe('onto')
    expect(zone(0.3 - ZONE_BAND - 0.01, 'onto')).toBe('before')
    expect(zone(0.7 + ZONE_BAND - 0.01, 'onto')).toBe('onto')
    expect(zone(0.7 + ZONE_BAND + 0.01, 'onto')).toBe('after')
  })
})

describe('a row whose nested rows are unfolded under it', () => {
  it('has no after zone: below the top band is onto', () => {
    expect(zone(0.1, null, true, true)).toBe('before')
    expect(zone(0.3, null, true, true)).toBe('onto')
    expect(zone(0.9, null, true, true)).toBe('onto')
    expect(zone(1, null, true, true)).toBe('onto')
    expect(zone(1, 'after', true, true)).toBe('onto')
  })

  it('holds its one boundary the same way', () => {
    expect(zone(0.3 + ZONE_BAND - 0.01, 'before', true, true)).toBe('before')
    expect(zone(0.3 + ZONE_BAND + 0.01, 'before', true, true)).toBe('onto')
    expect(zone(0.3 - ZONE_BAND + 0.01, 'onto', true, true)).toBe('onto')
    expect(zone(0.3 - ZONE_BAND - 0.01, 'onto', true, true)).toBe('before')
  })
})

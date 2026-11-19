import { describe, expect, it } from 'vitest'
import { AIM_TRAIL, aimVerdict, headsInto, recordAim, type AimRect } from './submenu-aim'

// The launcher's Connection panel beside its Model menu: model rows are 28px
// tall and end at x 200, the panel opens 11px to their right, aligned 5px above
// the hovered model (y 100–128) and four rows tall.
const panel: AimRect = { left: 211, right: 411, top: 95, bottom: 215 }

describe('headsInto', () => {
  it('a move straight across toward the panel heads into it', () => {
    expect(headsInto({ x: 120, y: 114 }, { x: 150, y: 114 }, panel, 'right')).toBe(true)
  })

  it('a diagonal toward a lower entry of the panel heads into it', () => {
    // From the hovered model toward the panel's third row (y ~180).
    expect(headsInto({ x: 120, y: 114 }, { x: 150, y: 136 }, panel, 'right')).toBe(true)
  })

  it('a move down onto the next model does not, even drifting right', () => {
    expect(headsInto({ x: 120, y: 118 }, { x: 124, y: 142 }, panel, 'right')).toBe(false)
  })

  it('a move away from the panel never does', () => {
    expect(headsInto({ x: 150, y: 114 }, { x: 120, y: 114 }, panel, 'right')).toBe(false)
    expect(headsInto({ x: 150, y: 114 }, { x: 150, y: 150 }, panel, 'right')).toBe(false)
  })

  it('a line that passes under the panel does not', () => {
    expect(headsInto({ x: 100, y: 150 }, { x: 140, y: 190 }, panel, 'right')).toBe(false)
  })

  it('mirrors for a panel that opened on the left', () => {
    const left: AimRect = { left: 0, right: 189, top: 95, bottom: 215 }
    expect(headsInto({ x: 280, y: 114 }, { x: 250, y: 120 }, left, 'left')).toBe(true)
    expect(headsInto({ x: 250, y: 114 }, { x: 280, y: 114 }, left, 'left')).toBe(false)
  })

  it('level with the panel, it heads in only within its height', () => {
    expect(headsInto({ x: 205, y: 114 }, { x: 215, y: 114 }, panel, 'right')).toBe(true)
    expect(headsInto({ x: 205, y: 300 }, { x: 215, y: 300 }, panel, 'right')).toBe(false)
  })
})

describe('aimVerdict', () => {
  const open = { rect: panel, side: 'right' as const }

  it('waits while the pointer heads into the open submenu', () => {
    expect(aimVerdict([{ x: 120, y: 114 }], { x: 150, y: 120 }, open)).toBe('wait')
  })

  it('takes the row when the pointer is not heading there', () => {
    expect(aimVerdict([{ x: 120, y: 118 }], { x: 122, y: 142 }, open)).toBe('take')
  })

  it('takes the row with no heading to read, or no submenu to aim at', () => {
    expect(aimVerdict([], { x: 150, y: 120 }, open)).toBe('take')
    expect(aimVerdict([{ x: 120, y: 114 }], { x: 150, y: 120 }, null)).toBe('take')
  })

  it('reads the heading across the trail, not the last pixel', () => {
    // Down onto the next model, then one pixel to the right: the last step alone
    // points into the panel, the trail does not.
    const trail = [
      { x: 120, y: 114 },
      { x: 120, y: 122 },
      { x: 121, y: 130 },
      { x: 121, y: 138 }
    ]
    expect(aimVerdict(trail, { x: 122, y: 138 }, open)).toBe('take')
  })
})

describe('recordAim', () => {
  it('keeps the last positions, the oldest first', () => {
    const trail: { x: number; y: number }[] = []
    for (let i = 0; i < AIM_TRAIL + 3; i++) recordAim(trail, { x: i, y: 0 })
    expect(trail.map((p) => p.x)).toEqual(Array.from({ length: AIM_TRAIL }, (_, i) => i + 3))
  })
})

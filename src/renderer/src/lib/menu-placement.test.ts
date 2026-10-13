import { describe, it, expect } from 'vitest'
import { MENU_EDGE_PADDING as P, placeMenu } from './menu-placement'

const vp = { width: 1000, height: 800 }
const inside = (r: { left: number; top: number }, w: number, h: number): boolean =>
  r.left >= P && r.top >= P && r.left + w <= vp.width - P && r.top + h <= vp.height - P

describe('placeMenu', () => {
  it('opens below and right of the cursor, raised by the lift', () => {
    expect(placeMenu(100, 400, 200, 300, 150, vp)).toEqual({ left: 100, top: 250 })
  })

  it('never leaves the top when the lift is taller than the room above', () => {
    const r = placeMenu(100, 40, 200, 300, 200, vp)
    expect(r.top).toBe(P)
    expect(inside(r, 200, 300)).toBe(true)
  })

  it('opens upward near the bottom edge', () => {
    expect(placeMenu(100, 750, 200, 300, 0, vp)).toEqual({ left: 100, top: 450 })
  })

  it('opens leftward near the right edge', () => {
    expect(placeMenu(950, 100, 200, 300, 0, vp)).toEqual({ left: 750, top: 100 })
  })

  it('stays inside for every click position', () => {
    for (let x = 0; x <= vp.width; x += 50)
      for (let y = 0; y <= vp.height; y += 50)
        for (const lift of [0, 200]) {
          expect(inside(placeMenu(x, y, 240, 420, lift, vp), 240, 420)).toBe(true)
        }
  })
})

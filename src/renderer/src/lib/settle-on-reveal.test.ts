import { describe, expect, it, vi } from 'vitest'
import { revealed, settle } from './settle-on-reveal'

describe('a pane that comes back (PRDCT-4419)', () => {
  it('is revealed when its box appears, first measured or after none', () => {
    expect(revealed(undefined, 1200)).toBe(true)
    expect(revealed(0, 1200)).toBe(true)
  })

  it('is not revealed when it only changes size, or stays without a box', () => {
    expect(revealed(1200, 900)).toBe(false)
    expect(revealed(undefined, 0)).toBe(false)
    expect(revealed(1200, 0)).toBe(false)
  })

  it('finishes the transitions running in it and leaves the keyframe animations', () => {
    const transition = { transitionProperty: 'opacity', finish: vi.fn() }
    const breathing = { finish: vi.fn() }
    const root = { getAnimations: vi.fn(() => [transition, breathing]) }
    expect(settle(root)).toBe(1)
    expect(root.getAnimations).toHaveBeenCalledWith({ subtree: true })
    expect(transition.finish).toHaveBeenCalledOnce()
    expect(breathing.finish).not.toHaveBeenCalled()
  })

  it('does nothing where no animation can be read', () => {
    expect(settle({})).toBe(0)
  })
})

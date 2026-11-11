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

  it('finishes the transitions and one-shot entries, and leaves loops and scripts', () => {
    const timing = (iterations: number): { getComputedTiming: () => { iterations: number } } => ({
      getComputedTiming: () => ({ iterations })
    })
    const transition = { transitionProperty: 'opacity', finish: vi.fn() }
    const entry = { animationName: 'chat-ask-field-in', effect: timing(1), finish: vi.fn() }
    const breathing = { animationName: 'breathe', effect: timing(Infinity), finish: vi.fn() }
    const scripted = { effect: timing(1), finish: vi.fn() }
    const root = { getAnimations: vi.fn(() => [transition, entry, breathing, scripted]) }
    expect(settle(root)).toBe(2)
    expect(root.getAnimations).toHaveBeenCalledWith({ subtree: true })
    expect(transition.finish).toHaveBeenCalledOnce()
    expect(entry.finish).toHaveBeenCalledOnce()
    expect(breathing.finish).not.toHaveBeenCalled()
    expect(scripted.finish).not.toHaveBeenCalled()
  })

  it('leaves an animation its element keeps on reveal (PRDCT-4422)', () => {
    const kept = { id: 'flashed row' } as unknown as Element
    vi.stubGlobal('getComputedStyle', (el: Element) => ({
      getPropertyValue: (name: string) => (el === kept && name === '--reveal-keep' ? ' 1' : '')
    }))
    const once = { getComputedTiming: () => ({ iterations: 1 }) }
    const flash = {
      animationName: 'jump-flash',
      effect: { ...once, target: kept },
      finish: vi.fn()
    }
    const entry = {
      animationName: 'chat-ask-field-in',
      effect: { ...once, target: { id: 'row' } as unknown as Element },
      finish: vi.fn()
    }
    expect(settle({ getAnimations: () => [flash, entry] })).toBe(1)
    expect(flash.finish).not.toHaveBeenCalled()
    expect(entry.finish).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })

  it('does nothing where no animation can be read', () => {
    expect(settle({})).toBe(0)
  })
})

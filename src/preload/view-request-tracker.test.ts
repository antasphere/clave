import { describe, expect, it } from 'vitest'
import { createViewRequestTracker } from './view-request-tracker'

describe('the view request tracker of a window', () => {
  it('runs a request once: the same id again is a repeat', () => {
    const tracker = createViewRequestTracker()
    expect(tracker.take('r1')).toBe(true)
    expect(tracker.take('r1')).toBe(false)
    expect(tracker.take('r2')).toBe(true)
  })
  it('owns a request from its start to its answer, and still refuses the repeat after', () => {
    const tracker = createViewRequestTracker()
    tracker.take('r1')
    expect(tracker.owns('r1')).toBe(true)
    tracker.answered('r1')
    expect(tracker.owns('r1')).toBe(false)
    expect(tracker.take('r1')).toBe(false)
    expect(tracker.owns('never')).toBe(false)
  })
  it('spares a request still being run when it evicts', () => {
    const tracker = createViewRequestTracker(2)
    tracker.take('slow')
    tracker.take('b')
    tracker.answered('b')
    tracker.take('c')
    expect(tracker.owns('slow')).toBe(true)
    expect(tracker.take('b')).toBe(true)
  })
  it('evicts the oldest id anyway when every known id is still being run', () => {
    const tracker = createViewRequestTracker(2)
    for (const id of ['a', 'b', 'c']) tracker.take(id)
    expect(tracker.size).toBe(2)
    expect(tracker.owns('a')).toBe(false)
    expect(tracker.take('a')).toBe(true)
  })
  it('forgets the oldest ids past its limit', () => {
    const tracker = createViewRequestTracker(3)
    for (const id of ['a', 'b', 'c', 'd']) {
      tracker.take(id)
      tracker.answered(id)
    }
    expect(tracker.size).toBe(3)
    expect(tracker.take('a')).toBe(true)
    expect(tracker.take('d')).toBe(false)
  })
})

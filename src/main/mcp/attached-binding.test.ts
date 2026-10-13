import { describe, expect, it } from 'vitest'
import { shouldBindAttachedSession } from './attached-binding'

describe('reconciling an attached session’s window binding', () => {
  it('binds when main holds none and the server names a window', () => {
    expect(shouldBindAttachedSession(null, 5)).toBe(true)
  })
  it('re-binds when the server now names a DIFFERENT window (a move)', () => {
    // The round-1 Major: the tab moved from window 3 to window 7 on the
    // server; main still points at 3 and must follow to 7.
    expect(shouldBindAttachedSession(3, 7)).toBe(true)
  })
  it('leaves the binding alone when it already names the server’s window', () => {
    expect(shouldBindAttachedSession(7, 7)).toBe(false)
  })
  it('does nothing when the server names no window', () => {
    expect(shouldBindAttachedSession(3, null)).toBe(false)
    expect(shouldBindAttachedSession(null, null)).toBe(false)
  })
})

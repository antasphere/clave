import { beforeEach, describe, expect, it } from 'vitest'
import { clearSessionDraft, setSessionDraft, useDraftStore } from './draft-store'

const read = (id: string): string => useDraftStore.getState().drafts[id] ?? ''

describe('the host-owned composer draft', () => {
  beforeEach(() => useDraftStore.setState({ drafts: {} }))
  it('keeps a draft per session, and an unknown session reads empty', () => {
    setSessionDraft('a', 'hello')
    setSessionDraft('b', 'other')
    expect(read('a')).toBe('hello')
    expect(read('b')).toBe('other')
    expect(read('c')).toBe('')
  })
  it('takes a functional update against the current text', () => {
    setSessionDraft('a', 'hel')
    setSessionDraft('a', (current) => current + 'lo')
    expect(read('a')).toBe('hello')
    setSessionDraft('a', (current) => (current === 'hello' ? '' : current))
    expect(read('a')).toBe('')
  })
  it('does not replace the state when nothing changed', () => {
    setSessionDraft('a', 'same')
    const before = useDraftStore.getState()
    setSessionDraft('a', 'same')
    expect(useDraftStore.getState()).toBe(before)
  })
  it("drops a session's draft on clear and leaves the others", () => {
    setSessionDraft('a', 'gone')
    setSessionDraft('b', 'kept')
    clearSessionDraft('a')
    expect(read('a')).toBe('')
    expect(read('b')).toBe('kept')
    expect('a' in useDraftStore.getState().drafts).toBe(false)
  })
})

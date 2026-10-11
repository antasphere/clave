import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSessionDraft,
  DRAFT_KEY_PREFIX,
  DRAFT_MAX_AGE_MS,
  readPersistedDrafts,
  setDraftStorageForTests,
  setSessionDraft,
  useDraftStore,
  type DraftStorage
} from './draft-store'

const read = (id: string): string => useDraftStore.getState().drafts[id] ?? ''

/** An in-memory Web Storage, the shape the store reads and writes. */
function memoryStorage(seed: Record<string, string> = {}): DraftStorage & {
  data: Map<string, string>
} {
  const data = new Map(Object.entries(seed))
  return {
    data,
    get length() {
      return data.size
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k)
  }
}
const stored = (text: string, at = Date.now()): string => JSON.stringify({ text, at })

describe('the host-owned composer draft', () => {
  beforeEach(() => setDraftStorageForTests(null))
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

describe('the draft outlives the app', () => {
  let storage: ReturnType<typeof memoryStorage>
  beforeEach(() => {
    storage = memoryStorage()
    setDraftStorageForTests(storage)
  })
  it('writes every change to storage under the session id, and an emptied draft removes its key', () => {
    setSessionDraft('s1', 'half a prompt')
    expect(JSON.parse(storage.data.get(DRAFT_KEY_PREFIX + 's1') ?? '{}').text).toBe('half a prompt')
    setSessionDraft('s1', '')
    expect(storage.data.has(DRAFT_KEY_PREFIX + 's1')).toBe(false)
  })
  it('a fresh store (the next launch) starts with the drafts storage holds', () => {
    setSessionDraft('s1', 'typed before the quit')
    setSessionDraft('s2', 'another tab')
    // The relaunch: the same storage, a store built from nothing.
    useDraftStore.setState({ drafts: {} })
    setDraftStorageForTests(storage)
    expect(read('s1')).toBe('typed before the quit')
    expect(read('s2')).toBe('another tab')
  })
  it('a closed session takes its draft out of storage', () => {
    setSessionDraft('s1', 'never sent')
    clearSessionDraft('s1')
    expect(storage.data.has(DRAFT_KEY_PREFIX + 's1')).toBe(false)
  })
  it('drops stale, empty and malformed entries on read, and leaves foreign keys alone', () => {
    const now = 1_000_000_000_000
    const seeded = memoryStorage({
      [DRAFT_KEY_PREFIX + 'fresh']: stored('keep me', now - 1000),
      [DRAFT_KEY_PREFIX + 'stale']: stored('too old', now - DRAFT_MAX_AGE_MS - 1),
      [DRAFT_KEY_PREFIX + 'empty']: stored('', now),
      [DRAFT_KEY_PREFIX + 'broken']: '{not json',
      'clave-theme': 'dark'
    })
    expect(readPersistedDrafts(seeded, now)).toEqual({ fresh: 'keep me' })
    expect([...seeded.data.keys()].sort()).toEqual(
      [DRAFT_KEY_PREFIX + 'fresh', 'clave-theme'].sort()
    )
  })
  it('a storage that throws costs the persistence, never the keystroke', () => {
    const broken = memoryStorage()
    broken.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    setDraftStorageForTests(broken)
    setSessionDraft('s1', 'still typed')
    expect(read('s1')).toBe('still typed')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../store/session-store', () => ({
  useSessionStore: {
    getState: () => ({ sessions: [], groups: [] }),
    subscribe: () => () => undefined
  }
}))
import type { Reading } from '../../../../plugins/chat-view/src/lab/read-aloud'
import {
  registerVoice,
  resetUpdates,
  useUpdatesStore,
  type SayResult,
  type VoiceControls
} from '../store/updates-store'
import {
  BANNER_MS,
  BUSY_RETRY_MS,
  setCardHover,
  startUpdatesVoice,
  toAnnounceAgain,
  updatesStatus,
  type UpdatesStatus
} from './updates-voice'

const store = useUpdatesStore.getState
const filed = (
  sessionId: string,
  pageKey: string,
  at = 1
): { sessionId: string; pageKey: string; markdown: string; title: string; at: number } => ({
  sessionId,
  pageKey,
  markdown: `Answer ${pageKey}`,
  title: `Title ${pageKey}`,
  at
})
const NAMES: Record<string, { group: string | null; tab: string }> = {
  a: { group: 'Atlas', tab: 'Notes' },
  b: { group: null, tab: 'Harbor' }
}

/** A pane's voice whose lines the test answers. */
function voice(answers: SayResult[] = []): VoiceControls & {
  said: string[]
  pending: ((r: SayResult) => void)[]
} {
  const said: string[] = []
  const pending: ((r: SayResult) => void)[] = []
  return {
    said,
    pending,
    read: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    stop: () => undefined,
    seekBlock: () => undefined,
    say: (text) => {
      said.push(text)
      const next = answers.shift()
      return next ? Promise.resolve(next) : new Promise((resolve) => pending.push(resolve))
    }
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

let stop: () => void
let reports: UpdatesStatus[]
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', { getItem: () => 'on', setItem: () => undefined })
  resetUpdates()
  reports = []
  stop = startUpdatesVoice({
    nameOf: (id) => NAMES[id],
    exists: (id) => id in NAMES,
    report: (status) => reports.push(status),
    onSessions: () => () => undefined
  })
})
afterEach(() => {
  stop()
  setCardHover(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const reading = { key: 'p', state: 'playing', ticks: [1] } as unknown as Reading

describe('the announcement', () => {
  it('says the group of a filed update, marks it announced and opens the banner', async () => {
    const a = voice(['said'])
    registerVoice('a', a)
    store().file(filed('a', 'p1'))
    await flush()
    expect(a.said).toEqual(['I have an update for you on Atlas.'])
    expect(store().updates[0].announced).toBe(true)
    expect(store().cardOpen).toBe('banner')
  })

  it('names an ungrouped tab by its own name', async () => {
    const b = voice(['said'])
    registerVoice('b', b)
    store().file(filed('b', 'p1'))
    await flush()
    expect(b.said).toEqual(['I have an update for you on Harbor.'])
  })

  it('never talks over a reading: an update filed during one waits, then is said', async () => {
    const a = voice(['said'])
    registerVoice('a', a)
    store().publish('b', { sessionId: 'b', pageKey: 'p', title: 'x', reading, onScreen: false })
    store().file(filed('a', 'p1'))
    await flush()
    expect(a.said).toEqual([])
    store().ended('b', 'p', 'heard')
    await flush()
    expect(a.said).toEqual(['I have an update for you on Atlas.'])
  })

  it('one line at a time: a second update waits for the first line to end', async () => {
    const a = voice()
    const b = voice(['said'])
    registerVoice('a', a)
    registerVoice('b', b)
    store().file(filed('a', 'p1'))
    store().file(filed('b', 'p2'))
    await flush()
    expect(a.said).toHaveLength(1)
    expect(b.said).toEqual([])
    a.pending[0]('said')
    await flush()
    expect(b.said).toEqual(['I have an update for you on Harbor.'])
  })

  it('busy defers the line and tries again', async () => {
    const a = voice(['busy', 'said'])
    registerVoice('a', a)
    store().file(filed('a', 'p1'))
    await flush()
    expect(store().updates[0].announced).toBe(false)
    vi.advanceTimersByTime(BUSY_RETRY_MS)
    await flush()
    expect(a.said).toHaveLength(2)
    expect(store().updates[0].announced).toBe(true)
  })

  it('a failure is marked announced and never loops', async () => {
    const a = voice(['failed'])
    registerVoice('a', a)
    store().file(filed('a', 'p1'))
    await flush()
    vi.advanceTimersByTime(BUSY_RETRY_MS * 5)
    await flush()
    expect(a.said).toHaveLength(1)
    expect(store().updates[0].announced).toBe(true)
  })

  it('a pane that is gone drops its update unsaid', async () => {
    store().file(filed('a', 'p1'))
    await flush()
    expect(store().updates).toEqual([])
  })

  it('says nothing with the play mode off', async () => {
    store().setOn(false)
    const a = voice(['said'])
    registerVoice('a', a)
    store().file(filed('a', 'p1'))
    await flush()
    expect(a.said).toEqual([])
  })
})

describe('the banner', () => {
  it('closes BANNER_MS after the announcement', async () => {
    registerVoice('a', voice(['said']))
    store().file(filed('a', 'p1'))
    await flush()
    expect(store().cardOpen).toBe('banner')
    vi.advanceTimersByTime(BANNER_MS - 1)
    expect(store().cardOpen).toBe('banner')
    vi.advanceTimersByTime(1)
    expect(store().cardOpen).toBeNull()
  })

  it('stays under the pointer, and closes once it leaves', async () => {
    registerVoice('a', voice(['said']))
    store().file(filed('a', 'p1'))
    await flush()
    setCardHover(true)
    vi.advanceTimersByTime(BANNER_MS)
    expect(store().cardOpen).toBe('banner')
    setCardHover(false)
    expect(store().cardOpen).toBeNull()
  })

  it('a pinned card is never closed by the timer', async () => {
    registerVoice('a', voice(['said']))
    store().openCard('pinned')
    store().file(filed('a', 'p1'))
    await flush()
    vi.advanceTimersByTime(BANNER_MS * 2)
    expect(store().cardOpen).toBe('pinned')
  })
})

describe('the re-announcement (rule 7)', () => {
  it('after a reading from an update is heard to its end, the oldest waiting is said again', async () => {
    const a = voice(['said'])
    const b = voice(['said', 'said'])
    registerVoice('a', a)
    registerVoice('b', b)
    store().file(filed('a', 'p1'))
    store().file(filed('b', 'p2'))
    await flush()
    await flush()
    expect(store().updates.every((u) => u.announced)).toBe(true)
    // The person plays a's update; it is read to its end.
    store().play('a|p1')
    store().publish('a', { sessionId: 'a', pageKey: 'p1', title: null, reading, onScreen: false })
    store().ended('a', 'p1', 'heard')
    await flush()
    expect(b.said).toEqual([
      'I have an update for you on Harbor.',
      'I have an update for you on Harbor.'
    ])
  })

  it('not after Stop', async () => {
    const a = voice(['said'])
    const b = voice(['said', 'said'])
    registerVoice('a', a)
    registerVoice('b', b)
    store().file(filed('a', 'p1'))
    store().file(filed('b', 'p2'))
    await flush()
    await flush()
    store().play('a|p1')
    store().publish('a', { sessionId: 'a', pageKey: 'p1', title: null, reading, onScreen: false })
    store().ended('a', 'p1', 'stopped')
    await flush()
    expect(b.said).toHaveLength(1)
  })

  it('toAnnounceAgain: only a heard reading from an update with updates waiting', () => {
    const u = { ...filed('b', 'p2'), id: 'b|p2', announced: true }
    const end = { sessionId: 'a', pageKey: 'p1', at: 1 }
    expect(toAnnounceAgain({ ...end, how: 'heard', fromUpdate: true }, [u])).toBe(true)
    expect(toAnnounceAgain({ ...end, how: 'stopped', fromUpdate: true }, [u])).toBe(false)
    expect(toAnnounceAgain({ ...end, how: 'heard', fromUpdate: false }, [u])).toBe(false)
    expect(toAnnounceAgain({ ...end, how: 'heard', fromUpdate: true }, [])).toBe(false)
    expect(toAnnounceAgain(null, [u])).toBe(false)
  })

  it('after a heard reading, ALL waiting updates are said again, in one line', async () => {
    const a = voice(['said', 'said'])
    const b = voice(['said', 'said'])
    registerVoice('a', a)
    registerVoice('b', b)
    registerVoice('c', voice(['said', 'said']))
    NAMES.c = { group: null, tab: 'Cedar' }
    store().file(filed('a', 'p1'))
    await flush()
    store().file(filed('b', 'p2'))
    await flush()
    store().file(filed('c', 'p3'))
    await flush()
    // The person plays the oldest (a); it is heard to its end.
    store().play('a|p1')
    store().publish('a', { sessionId: 'a', pageKey: 'p1', title: null, reading, onScreen: false })
    store().ended('a', 'p1', 'heard')
    await flush()
    expect(b.said.at(-1)).toBe('I have updates for you on Harbor and Cedar.')
    expect(store().updates.every((u) => u.announced)).toBe(true)
    delete NAMES.c
  })
})

describe('one sentence, a cut line', () => {
  it('several updates not yet announced are said in ONE line, in the oldest voice', async () => {
    const a = voice(['said'])
    const b = voice(['said'])
    registerVoice('a', a)
    registerVoice('b', b)
    // Both filed while a reading holds the voice.
    store().publish('x', { sessionId: 'x', pageKey: 'p', title: 'x', reading, onScreen: false })
    store().file(filed('a', 'p1'))
    store().file(filed('b', 'p2'))
    await flush()
    store().ended('x', 'p', 'stopped')
    await flush()
    expect(a.said).toEqual(['I have updates for you on Atlas and Harbor.'])
    expect(b.said).toEqual([])
    expect(store().updates.every((u) => u.announced)).toBe(true)
  })

  it('a line cut by a reading is not marked, and is said once the voice is free', async () => {
    const a = voice(['cut', 'said'])
    registerVoice('a', a)
    store().file(filed('a', 'p1'))
    await flush()
    expect(store().updates[0].announced).toBe(false)
    // The reading that cut it plays, then ends.
    store().publish('x', { sessionId: 'x', pageKey: 'p', title: 'x', reading, onScreen: false })
    vi.advanceTimersByTime(BUSY_RETRY_MS * 3)
    await flush()
    expect(a.said).toHaveLength(1)
    store().ended('x', 'p', 'heard')
    await flush()
    expect(a.said).toHaveLength(2)
    expect(store().updates[0].announced).toBe(true)
  })

  it('a paused reading is never polled: no line, no retry while it holds', async () => {
    const a = voice(['busy', 'said'])
    registerVoice('a', a)
    store().publish('x', {
      sessionId: 'x',
      pageKey: 'p',
      title: 'x',
      reading: { ...reading, state: 'paused' } as Reading,
      onScreen: false
    })
    store().file(filed('a', 'p1'))
    vi.advanceTimersByTime(BUSY_RETRY_MS * 10)
    await flush()
    expect(a.said).toEqual([])
  })
})

describe('the status main is told', () => {
  it('active while an update waits or a reading plays; the oldest time', async () => {
    expect(reports.at(-1)).toEqual({ active: false, playing: false, oldestAt: null })
    registerVoice('a', voice(['said']))
    store().file(filed('a', 'p1', 42))
    await flush()
    expect(reports.at(-1)).toEqual({ active: true, playing: false, oldestAt: 42 })
    store().play('a|p1')
    store().publish('a', { sessionId: 'a', pageKey: 'p1', title: null, reading, onScreen: false })
    expect(reports.at(-1)).toEqual({ active: true, playing: true, oldestAt: null })
    store().ended('a', 'p1', 'heard')
    expect(reports.at(-1)).toEqual({ active: false, playing: false, oldestAt: null })
  })

  it('updatesStatus is pure', () => {
    expect(updatesStatus({ updates: [], current: null })).toEqual({
      active: false,
      playing: false,
      oldestAt: null
    })
  })
})

describe('a closed tab', () => {
  it('takes its update with it', () => {
    stop()
    let listener = (): void => undefined
    const alive = new Set(['a'])
    stop = startUpdatesVoice({
      nameOf: (id) => NAMES[id],
      exists: (id) => alive.has(id),
      report: () => undefined,
      onSessions: (l) => {
        listener = l
        return () => undefined
      }
    })
    registerVoice('a', voice())
    store().file(filed('a', 'p1'))
    alive.delete('a')
    listener()
    expect(store().updates).toEqual([])
  })
})

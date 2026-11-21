import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Reading } from '../../../../plugins/chat-view/src/lab/read-aloud'
import { registerVoice, resetUpdates, useUpdatesStore, type VoiceControls } from './updates-store'

const store = useUpdatesStore.getState
const filed = (
  sessionId: string,
  pageKey: string,
  at = 1
): { sessionId: string; pageKey: string; markdown: string; title: string; at: number } => ({
  sessionId,
  pageKey,
  markdown: `Answer ${sessionId} ${pageKey}`,
  title: `Title ${pageKey}`,
  at
})

function fakeVoice(): VoiceControls & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    read: (pageKey, markdown) => void calls.push(`read ${pageKey} ${markdown}`),
    pause: () => void calls.push('pause'),
    resume: () => void calls.push('resume'),
    stop: () => void calls.push('stop'),
    seekBlock: (n) => void calls.push(`seek ${n}`),
    say: async () => 'said'
  }
}

const reading = (state: Reading['state'], ticks = [1, 2, 3]): Reading =>
  ({ key: 'p1', state, ticks, tick: 0, blocks: ticks.length }) as unknown as Reading

let saved: Record<string, string>
beforeEach(() => {
  saved = {}
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => saved[k] ?? null,
    setItem: (k: string, v: string) => void (saved[k] = v)
  })
  resetUpdates()
})
afterEach(() => vi.unstubAllGlobals())

describe('the play mode switch', () => {
  it('is kept under the Folio read-aloud key, on/off', () => {
    store().setOn(true)
    expect(saved['clave.folio.read-aloud']).toBe('on')
    expect(store().on).toBe(true)
    store().setOn(false)
    expect(saved['clave.folio.read-aloud']).toBe('off')
  })
  it('starts from what was kept', () => {
    saved['clave.folio.read-aloud'] = 'on'
    resetUpdates()
    expect(store().on).toBe(true)
  })
})

describe('the updates', () => {
  it('files, replaces the same tab, dismisses and clears a tab', () => {
    store().file(filed('a', 'p1'))
    store().file(filed('b', 'p1'))
    store().file(filed('a', 'p4'))
    expect(store().updates.map((u) => u.id)).toEqual(['b|p1', 'a|p4'])
    store().dismiss('b|p1')
    expect(store().updates.map((u) => u.id)).toEqual(['a|p4'])
    // The pane coming on screen clears its tab's update.
    store().clearSession('a')
    expect(store().updates).toEqual([])
  })
})

describe('the commands', () => {
  it('toggle with nothing playing plays the oldest update, which leaves the list', () => {
    const a = fakeVoice()
    registerVoice('a', a)
    registerVoice('b', fakeVoice())
    store().file(filed('a', 'p1'))
    store().file(filed('b', 'p2'))
    expect(store().toggle()).toBe(true)
    expect(a.calls).toEqual(['read p1 Answer a p1'])
    expect(store().updates.map((u) => u.id)).toEqual(['b|p2'])
  })

  it('toggle pauses and resumes the current reading, and never starts another', () => {
    const a = fakeVoice()
    const b = fakeVoice()
    registerVoice('a', a)
    registerVoice('b', b)
    store().file(filed('b', 'p2'))
    store().publish('a', {
      sessionId: 'a',
      pageKey: 'p1',
      title: 'One',
      reading: reading('playing'),
      onScreen: false
    })
    expect(store().toggle()).toBe(true)
    expect(a.calls).toEqual(['pause'])
    store().publish('a', {
      sessionId: 'a',
      pageKey: 'p1',
      title: 'One',
      reading: reading('paused'),
      onScreen: false
    })
    store().toggle()
    expect(a.calls).toEqual(['pause', 'resume'])
    expect(b.calls).toEqual([])
    expect(store().updates).toHaveLength(1)
  })

  it('toggle with nothing at all does nothing', () => {
    expect(store().toggle()).toBe(false)
  })

  it('a reading started by play is published as from an update, with the update title', () => {
    registerVoice('a', fakeVoice())
    store().file(filed('a', 'p1'))
    store().play('a|p1')
    store().publish('a', {
      sessionId: 'a',
      pageKey: 'p1',
      title: null,
      reading: reading('preparing'),
      onScreen: false
    })
    expect(store().current).toMatchObject({ fromUpdate: true, title: 'Title p1' })
    // It stays so as it plays on.
    store().publish('a', {
      sessionId: 'a',
      pageKey: 'p1',
      title: null,
      reading: reading('playing'),
      onScreen: true
    })
    expect(store().current).toMatchObject({ fromUpdate: true, title: 'Title p1', onScreen: true })
    store().ended('a', 'p1', 'heard')
    expect(store().current).toBeNull()
    expect(store().lastEnd).toMatchObject({ how: 'heard', fromUpdate: true })
  })

  it('a reading the person started on the page is not from an update', () => {
    store().publish('a', {
      sessionId: 'a',
      pageKey: 'p1',
      title: 'One',
      reading: reading('playing'),
      onScreen: true
    })
    expect(store().current?.fromUpdate).toBe(false)
    store().ended('a', 'p1', 'stopped')
    expect(store().lastEnd).toMatchObject({ how: 'stopped', fromUpdate: false })
  })

  it('Stop does not put the update back', () => {
    const a = fakeVoice()
    registerVoice('a', a)
    store().file(filed('a', 'p1'))
    store().play('a|p1')
    store().publish('a', {
      sessionId: 'a',
      pageKey: 'p1',
      title: null,
      reading: reading('playing'),
      onScreen: false
    })
    store().stop()
    expect(a.calls.at(-1)).toBe('stop')
    store().ended('a', 'p1', 'stopped')
    expect(store().updates).toEqual([])
  })

  it('seek goes to the block of the tick', () => {
    const a = fakeVoice()
    registerVoice('a', a)
    store().publish('a', {
      sessionId: 'a',
      pageKey: 'p1',
      title: 'One',
      reading: reading('playing', [2, 4, 6]),
      onScreen: false
    })
    store().seek(1)
    expect(a.calls).toEqual(['seek 4'])
    store().seek(9)
    expect(a.calls).toEqual(['seek 4'])
  })

  it('a pane that is gone drops its update', () => {
    const off = registerVoice('a', fakeVoice())
    store().file(filed('a', 'p1'))
    off()
    expect(store().play('a|p1')).toBe(false)
    expect(store().updates).toEqual([])
  })

  it('an old registration taken away leaves the new one', () => {
    const first = fakeVoice()
    const second = fakeVoice()
    const off = registerVoice('a', first)
    registerVoice('a', second)
    off()
    store().file(filed('a', 'p1'))
    store().play('a|p1')
    expect(second.calls).toHaveLength(1)
  })

  it('publishing null from another tab leaves the current reading', () => {
    store().publish('a', {
      sessionId: 'a',
      pageKey: 'p1',
      title: 'One',
      reading: reading('playing'),
      onScreen: false
    })
    store().publish('b', null)
    expect(store().current?.sessionId).toBe('a')
    store().publish('a', null)
    expect(store().current).toBeNull()
  })
})

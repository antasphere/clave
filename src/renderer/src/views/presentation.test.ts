import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyConversation, type Conversation } from '../../../../plugins/chat-view/src/reducer'
import {
  unfinishedTextOnly,
  makePresentationSchedule
} from '../../../../plugins/chat-view/src/presentation-policy'

const initial = (): Conversation => ({
  ...emptyConversation,
  state: 'working',
  entries: [
    { kind: 'user', text: 'question', final: true, at: 1 },
    { kind: 'assistant', text: 'first ', final: false, at: 2 }
  ]
})
function append(value: Conversation, text = 'second '): Conversation {
  const last = value.entries.at(-1)!
  if (last.kind !== 'assistant') throw new Error('test requires an assistant entry')
  return { ...value, entries: [...value.entries.slice(0, -1), { ...last, text: last.text + text }] }
}

afterEach(() => vi.useRealTimers())
describe('unfinished assistant presentation', () => {
  it('coalesces only append-only text on the same unfinished answer', () => {
    const before = initial()
    expect(unfinishedTextOnly(before, append(before))).toBe(true)
    expect(unfinishedTextOnly(before, append(append(before)))).toBe(true)
    expect(unfinishedTextOnly(before, { ...append(before), first: -1 })).toBe(false)
    expect(
      unfinishedTextOnly(before, {
        ...append(before),
        entries: [...before.entries, { kind: 'assistant', text: 'new answer', final: false, at: 3 }]
      })
    ).toBe(false)
  })
  it('flushes state, model, effort, mode, exit, final and non-assistant updates', () => {
    const before = initial(),
      after = append(before)
    const changes: Conversation[] = [
      { ...after, state: 'blocked' },
      { ...after, state: 'done' },
      { ...after, model: 'new-model' },
      { ...after, effort: 'high' },
      { ...after, permissionMode: { mode: 'ask', modes: [] } },
      { ...after, exitCode: 0 },
      {
        ...after,
        entries: [
          after.entries[0],
          { kind: 'assistant', text: 'first second ', final: true, at: 2 }
        ]
      },
      {
        ...after,
        entries: [{ kind: 'user', text: 'changed', final: true, at: 1 }, after.entries[1]]
      },
      {
        ...after,
        entries: [
          ...after.entries,
          {
            kind: 'permission',
            at: 3,
            request: {
              type: 'permission_request',
              id: 'q',
              description: 'Question?',
              options: [{ id: 'yes', label: 'Yes' }]
            }
          }
        ]
      }
    ]
    for (const change of changes) expect(unfinishedTextOnly(before, change)).toBe(false)
  })
  it('does not defer replacement text or another answer with a different timestamp', () => {
    const before = initial()
    for (const last of [
      { kind: 'assistant' as const, text: 'replacement', final: false, at: 2 },
      { kind: 'assistant' as const, text: 'first second ', final: false, at: 3 }
    ])
      expect(unfinishedTextOnly(before, { ...before, entries: [before.entries[0], last] })).toBe(
        false
      )
  })
})

describe('bounded presentation clock', () => {
  it('keeps the latest snapshot at a fixed deadline under continuous input', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const paints: Array<{ at: number; value: number }> = []
    const schedule = makePresentationSchedule<number>(
      (value) => paints.push({ at: Date.now(), value }),
      Date.now
    )
    schedule.commit(0)
    for (let value = 1; value <= 12; value++) {
      vi.advanceTimersByTime(20)
      schedule.offer(value)
    }
    expect(paints).toEqual([{ at: 150, value: 7 }])
    vi.advanceTimersByTime(60)
    expect(paints).toEqual([
      { at: 150, value: 7 },
      { at: 300, value: 12 }
    ])
  })
  it('an immediate control/final commit cancels stale text rather than painting it later', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const paint = vi.fn(),
      schedule = makePresentationSchedule(paint, Date.now)
    schedule.commit('first')
    schedule.offer('queued text')
    vi.advanceTimersByTime(50)
    schedule.commit('permission and final text')
    vi.advanceTimersByTime(200)
    expect(paint).not.toHaveBeenCalled()
  })
  it('hide/unmount cancellation prevents delayed painting and reveal starts a fresh interval', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const paint = vi.fn(),
      schedule = makePresentationSchedule(paint, Date.now)
    schedule.commit('first')
    schedule.offer('queued before hide')
    vi.advanceTimersByTime(100)
    schedule.cancel()
    vi.advanceTimersByTime(200)
    expect(paint).not.toHaveBeenCalled()
    schedule.commit('revealed latest')
    schedule.offer('new delta')
    vi.advanceTimersByTime(149)
    expect(paint).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(paint).toHaveBeenCalledWith('new delta')
    schedule.offer('unmounted')
    schedule.cancel()
    vi.advanceTimersByTime(200)
    expect(paint).toHaveBeenCalledTimes(1)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryItem, SessionEvent } from '../../../../src/shared/session-model'

// Folio's conversation hook run without a DOM (PRDCT-4832), the way the
// plugin's other hook tests run theirs: React is a one-render shim (state
// setters and reducers record, effects run at once), and the conversation's
// bridge is a fake that hands the test its handlers. What is pinned: a turn
// end is counted on the LIVE stream only, never when a tab's past arrives,
// nor on a reconnect's replace. The harness offers no way to mount a Folio
// pane again over a finished conversation (a reload drops the echo tabs),
// so this is where that rule is held.

const h = vi.hoisted(() => {
  const holders: { initial: unknown; value: unknown }[] = []
  const handlers: { current: Record<string, (...args: unknown[]) => void> | null } = {
    current: null
  }
  return {
    holders,
    handlers,
    react: {
      useState: <T>(initial: T | (() => T)) => {
        const value = typeof initial === 'function' ? (initial as () => T)() : initial
        const holder = { initial: value as unknown, value: value as unknown }
        holders.push(holder)
        const set = (next: T | ((now: T) => T)): void => {
          holder.value =
            typeof next === 'function' ? (next as (now: T) => T)(holder.value as T) : next
        }
        return [value, set] as const
      },
      useReducer: <S, A>(reducer: (s: S, a: A) => S, initial: S) => {
        const holder = { initial: initial as unknown, value: initial as unknown }
        holders.push(holder)
        return [initial, (action: A) => (holder.value = reducer(holder.value as S, action))]
      },
      useRef: <T>(current: T) => ({ current }),
      useCallback: <T>(fn: T) => fn,
      useEffect: (effect: () => void | (() => void)) => void effect()
    }
  }
})
vi.mock('react', () => ({ ...h.react, default: h.react }))
vi.mock('../bind-conversation', () => ({
  bindConversation: (_id: string, handlers: Record<string, (...args: unknown[]) => void>) => {
    h.handlers.current = handlers
    return { stop: () => undefined, retry: () => undefined, source: () => undefined }
  }
}))

import { useConversation } from './use-conversation'

beforeEach(() => {
  h.holders.length = 0
  h.handlers.current = null
  vi.stubGlobal('window', {
    electronAPI: { sessionsCapabilities: async () => ({ images: false }) }
  })
})
afterEach(() => vi.unstubAllGlobals())

/** The hook's live-turn counter: its one state that starts at the number 0. */
const turnEnds = (): number => h.holders.find((holder) => holder.initial === 0)!.value as number

const ev = (event: Record<string, unknown>): SessionEvent => event as unknown as SessionEvent
const finished: HistoryItem[] = [
  { event: ev({ type: 'user_message', text: 'An old question.' }), at: 1 },
  { event: ev({ type: 'state_change', state: 'working' }), at: 2 },
  { event: ev({ type: 'assistant_text', delta: 'An old answer.', final: true }), at: 3 },
  { event: ev({ type: 'state_change', state: 'done' }), at: 4 }
]
const live = (event: Record<string, unknown>): void =>
  h.handlers.current!.event({ event: ev(event), at: Date.now() })

describe('useConversation counts the turns of the live stream only', () => {
  it("a tab's past arriving, finished answer and all, is no turn", () => {
    useConversation('tab', 'done')
    h.handlers.current!.page({ items: finished, before: null }, true, false, false)
    expect(turnEnds()).toBe(0)
  })

  it('a live turn is one, and a reconnect replacing the past adds none', () => {
    useConversation('tab', 'idle')
    h.handlers.current!.page({ items: finished, before: null }, true, false, false)
    live({ type: 'state_change', state: 'working' })
    live({ type: 'assistant_text', delta: 'A new answer.', final: true })
    live({ type: 'state_change', state: 'done' })
    expect(turnEnds()).toBe(1)
    h.handlers.current!.page({ items: finished, before: null }, true, false, false)
    expect(turnEnds()).toBe(1)
  })

  it('a rest on the live stream with nothing run is no turn', () => {
    useConversation('tab', 'idle')
    live({ type: 'state_change', state: 'done' })
    expect(turnEnds()).toBe(0)
  })
})

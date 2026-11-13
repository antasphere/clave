/**
 * The store half of the model push (PRDCT-4256): main says which model a
 * session runs on, and the sidebar's store follows, so the foot and the row
 * warning judge the caps by the model the chat is on now, not the launch's.
 * The session store reads localStorage and the preload bridge at import time,
 * so this file stubs both before importing it, as group-dissolve.test.ts does.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Session } from './session-types'

let useSessionStore: typeof import('./session-store').useSessionStore

beforeAll(async () => {
  const mem = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k)
  }
  ;(globalThis as unknown as { window: unknown }).window = globalThis
  ;(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
    captureTabClosed: () => {}
  }
  useSessionStore = (await import('./session-store')).useSessionStore
})

const session = (id: string, model?: string): Session =>
  ({
    id,
    cwd: '/w',
    folderName: 'w',
    name: id,
    alive: true,
    claudeMode: true,
    antigravityMode: false,
    codexMode: false,
    dangerousMode: false,
    ...(model ? { model } : {}),
    activityStatus: 'idle',
    sessionType: 'local'
  }) as unknown as Session

beforeEach(() => {
  useSessionStore.setState({ sessions: [session('a', 'claude-opus-5-5'), session('b')] })
})

describe('the sidebar store learns a session’s model from main', () => {
  it('writes the model main pushed, on that session alone', () => {
    useSessionStore.getState().setSessionModel('a', 'claude-fable-5-1[1m]')
    const { sessions } = useSessionStore.getState()
    expect(sessions.find((s) => s.id === 'a')?.model).toBe('claude-fable-5-1[1m]')
    expect(sessions.find((s) => s.id === 'b')?.model).toBeUndefined()
  })
  it('a session launched on no model gets one when the provider names it', () => {
    useSessionStore.getState().setSessionModel('b', 'claude-opus-5-5')
    expect(useSessionStore.getState().sessions.find((s) => s.id === 'b')?.model).toBe(
      'claude-opus-5-5'
    )
  })
  it('the same model again, or an unknown session, changes nothing (no render for nothing)', () => {
    const before = useSessionStore.getState().sessions
    useSessionStore.getState().setSessionModel('a', 'claude-opus-5-5')
    expect(useSessionStore.getState().sessions).toBe(before)
    useSessionStore.getState().setSessionModel('gone', 'claude-opus-5-5')
    expect(useSessionStore.getState().sessions).toBe(before)
  })
})

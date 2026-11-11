/**
 * The CLI's limit report belongs to the account it arrived on: a restart onto
 * another account closes it, so the chip stops reading "Out" on an account
 * with headroom left. A restart on the same account keeps it.
 * The session store reads localStorage and the preload bridge at import time,
 * so this file stubs both before importing it, as session-model.test.ts does.
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

const session = (): Session =>
  ({
    id: 'a',
    cwd: '/w',
    folderName: 'w',
    name: 'a',
    alive: true,
    claudeMode: true,
    antigravityMode: false,
    codexMode: false,
    dangerousMode: false,
    claudeProfileId: 'spent',
    claudeSessionId: 'c1',
    activityStatus: 'idle',
    sessionType: 'local'
  }) as unknown as Session

const report = (): unknown => useSessionStore.getState().sessions[0].limitReported ?? null

beforeEach(() => {
  useSessionStore.setState({ sessions: [session()] })
  useSessionStore.getState().setLimitReported('a', { scope: { family: 'Fable' } })
})

describe('a limit report and the account it arrived on', () => {
  it('closes when the session restarts on another account', () => {
    useSessionStore
      .getState()
      .applySessionRestart('a', { claudeSessionId: 'c1', claudeProfileId: 'fresh' })
    expect(report()).toBeNull()
  })

  it('stays open when the session restarts on the same account', () => {
    useSessionStore
      .getState()
      .applySessionRestart('a', { claudeSessionId: 'c1', claudeProfileId: 'spent' })
    expect(report()).toEqual({ scope: { family: 'Fable' } })
  })

  it('stays open when the restart does not name an account', () => {
    useSessionStore.getState().applySessionRestart('a', { claudeSessionId: 'c1' })
    expect(report()).toEqual({ scope: { family: 'Fable' } })
  })
})

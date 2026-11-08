/**
 * An ongoing conversation follows its tab's launch (PRDCT-4190, verifier round 1, F4):
 * an account switch after the move must reach the entry, since the resume after a
 * reboot runs on it and the boot drops the record that held it.
 */
import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  const m = new Map<string, string>()
  const g = globalThis as unknown as Record<string, unknown>
  g.localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k)
  }
  g.window = globalThis
})
import { useSessionStore } from '../store/session-store'
import { useOngoingStore } from '../store/ongoing-store'
import { startOngoingFollow } from './ongoing-actions'
import type { OngoingEntry } from './ongoing'

describe('the entry follows the account a tab switched to', () => {
  it('an account switch after the move reaches the entry used to resume after a reboot', async () => {
    const base = {
      id: 'tab-1',
      name: 'Accountant',
      cwd: '/work',
      alive: true,
      claudeMode: true,
      dangerousMode: false,
      claudeSessionId: 'conv-1',
      sessionType: 'local',
      workspaceId: 'ws-a',
      claudeProfileId: 'acct-1',
      claudeProfileLabel: 'One',
      claudeConfigDir: '/acct-1'
    }
    useSessionStore.setState({ sessions: [base as never] })
    const entry: OngoingEntry = {
      id: 'e1',
      workspaceId: 'ws-a',
      sessionId: 'tab-1',
      provider: 'claude',
      conversationId: 'conv-1',
      name: 'Accountant',
      cwd: '/work',
      note: '',
      originGroup: null,
      addedAt: 1,
      launch: { claudeProfileId: 'acct-1', claudeProfileLabel: 'One', claudeConfigDir: '/acct-1' }
    }
    useOngoingStore.setState({ entries: [entry], hydrated: true })
    const stop = startOngoingFollow()
    // What applySessionRestart does on an account switch (store/session-store.ts).
    useSessionStore.getState().applySessionRestart('tab-1', {
      claudeSessionId: 'conv-1',
      claudeProfileId: 'acct-2',
      claudeProfileLabel: 'Two',
      claudeConfigDir: '/acct-2'
    })
    await new Promise((r) => setTimeout(r, 20))
    stop()
    const after = useOngoingStore.getState().entries[0]
    expect(after.launch.claudeConfigDir).toBe('/acct-2')
    expect(after.launch.claudeProfileId).toBe('acct-2')
  })
})

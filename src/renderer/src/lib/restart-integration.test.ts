import { beforeEach, afterEach, it, expect, vi } from 'vitest'
type RestartEvent = {
  id: string
  resumed: boolean
  requestId?: string
  account: { claudeProfileId?: string; claudeProfileLabel?: string }
}
const h = vi.hoisted(() => ({
  state: {
    sessions: [
      { id: 's1', sessionType: 'local', claudeMode: true, claudeProfileId: 'work', alive: true }
    ],
    activeView: 'terminals',
    selectedSessionIds: ['s1'],
    setSessionRestarting: vi.fn(),
    applySessionRestart: vi.fn()
  },
  restarted: vi.fn() as (event: RestartEvent) => void,
  api: {
    onSessionRestarted: vi.fn() as (cb: (event: RestartEvent) => void) => void,
    restartSession:
      vi.fn<
        (
          _id: string,
          _options: unknown,
          requestId?: string
        ) => Promise<{ id: string; resumed: boolean; requestId?: string }>
      >(),
    startSession: vi.fn()
  }
}))
vi.mock('../store/session-store', () => ({ useSessionStore: { getState: () => h.state } }))
vi.mock('../store/pinned-store', () => ({ usePinnedStore: { getState: () => ({}) } }))
vi.mock('../store/workspace-store', () => ({ useWorkspaceStore: { getState: () => ({}) } }))
vi.mock('./adopt-record', () => ({ adoptServerStartedTerminals: vi.fn() }))
vi.mock('../store/usage-store', () => ({ accountsUsageFor: vi.fn(), claudeUsageForModel: vi.fn() }))
vi.mock('../store/claude-profile-store', () => ({
  useClaudeProfileStore: {},
  getClaudeProfile: vi.fn(),
  claudeProfileUsable: vi.fn(),
  resolveClaudeProfile: vi.fn(),
  describeClaudeProfileAuth: vi.fn()
}))
vi.mock('../store/codex-account-store', () => ({
  useCodexAccountStore: {},
  getCodexAccount: vi.fn(),
  codexAccountUsable: vi.fn(),
  resolveCodexAccount: vi.fn(),
  describeCodexAccountAuth: vi.fn()
}))
let restartSessionProcess: typeof import('./switch-account').restartSessionProcess
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1000)
  h.state = {
    sessions: [
      { id: 's1', sessionType: 'local', claudeMode: true, claudeProfileId: 'work', alive: true }
    ],
    activeView: 'terminals',
    selectedSessionIds: ['s1'],
    setSessionRestarting: vi.fn(),
    applySessionRestart: vi.fn((_id, patch) => Object.assign(h.state.sessions[0], patch))
  }
  h.api = {
    onSessionRestarted: (cb: (event: RestartEvent) => void) => {
      h.restarted = cb
    },
    restartSession: vi.fn(),
    startSession: vi.fn()
  }
  vi.stubGlobal('window', { electronAPI: h.api })
  ;({ restartSessionProcess } = await import('./switch-account'))
  ;(await import('./served-events')).initServedToolsEvents()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
for (const delay of [100, 5001]) {
  it(`applies one remount with push before answer after ${delay}ms`, async () => {
    h.api.restartSession.mockImplementation(async (_id, _options, requestId) => {
      vi.setSystemTime(1000 + delay)
      h.restarted({
        id: 's1',
        requestId,
        resumed: true,
        account: { claudeProfileId: 'play', claudeProfileLabel: 'Play' }
      })
      return { id: 's1', resumed: true, requestId }
    })
    expect(
      await restartSessionProcess('s1', {
        overrides: { claudeProfileId: 'play' },
        patch: { claudeProfileId: 'play' }
      })
    ).toMatchObject({ ok: true })
    expect(h.state.applySessionRestart).toHaveBeenCalledTimes(1)
    expect(h.state.sessions[0].claudeProfileId).toBe('play')
  })
}
it('applies one remount when the own answer precedes the push', async () => {
  h.api.restartSession.mockImplementation(async (_id, _options, requestId) => ({
    id: 's1',
    resumed: true,
    requestId
  }))
  await restartSessionProcess('s1', { patch: { claudeProfileId: 'play' } })
  h.restarted({
    id: 's1',
    requestId: h.api.restartSession.mock.calls[0][2],
    resumed: true,
    account: { claudeProfileId: 'play' }
  })
  expect(h.state.applySessionRestart).toHaveBeenCalledTimes(1)
})
it('a refused call clears restarting, then a late push still applies', async () => {
  h.api.restartSession.mockRejectedValue(new Error('restart refused'))
  expect(await restartSessionProcess('s1')).toEqual({
    ok: false,
    resumed: false,
    error: 'restart refused'
  })
  expect(h.state.setSessionRestarting).toHaveBeenLastCalledWith('s1', false)
  h.restarted({ id: 's1', resumed: true, account: { claudeProfileId: 'play' } })
  expect(h.state.applySessionRestart).toHaveBeenCalledTimes(1)
})
it('one hidden-pane kick when the served push wins', async () => {
  h.state.selectedSessionIds = []
  h.api.restartSession.mockImplementation(async (_id, _options, requestId) => {
    h.restarted({ id: 's1', requestId, resumed: true, account: { claudeProfileId: 'play' } })
    return { id: 's1', resumed: true, requestId }
  })
  await restartSessionProcess('s1')
  expect(h.api.startSession).toHaveBeenCalledExactlyOnceWith('s1', 120, 30)
})

it('an unrelated served restart soon after a completed IPC restart is not suppressed', async () => {
  // The actual fallback sends no session.restarted push for its own call.
  h.api.restartSession.mockResolvedValue({ id: 's1', resumed: true })
  await restartSessionProcess('s1', { patch: { claudeProfileId: 'play' } })
  vi.setSystemTime(1200)
  h.restarted({
    id: 's1',
    resumed: true,
    account: { claudeProfileId: 'third', claudeProfileLabel: 'Third' }
  })
  expect(h.state.applySessionRestart).toHaveBeenCalledTimes(2)
  expect(h.state.sessions[0].claudeProfileId).toBe('third')
})

it('an unrelated correlated operation applies while an own call is pending', async () => {
  h.api.restartSession.mockImplementation(async (_id, _options, requestId) => {
    h.restarted({
      id: 's1',
      requestId: 'external-operation',
      resumed: true,
      account: { claudeProfileId: 'third' }
    })
    h.restarted({ id: 's1', requestId, resumed: true, account: { claudeProfileId: 'play' } })
    return { id: 's1', resumed: true, requestId }
  })
  await restartSessionProcess('s1')
  expect(h.state.applySessionRestart).toHaveBeenCalledTimes(2)
  expect(h.state.sessions[0].claudeProfileId).toBe('play')
})

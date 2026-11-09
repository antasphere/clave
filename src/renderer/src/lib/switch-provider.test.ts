import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../store/session-types'

/**
 * The move of a tab to another provider (PRDCT-4300), from the renderer's
 * side: which overrides reach the host's restart on each road, what the
 * store is told the tab is now, and how the handoff note is collected from
 * the current agent's own stream.
 */
const h = vi.hoisted(() => ({
  session: {
    id: 's1',
    sessionType: 'local',
    claudeMode: true,
    codexMode: false,
    claudeProfileId: 'work',
    alive: true,
    model: 'claude-opus-5-5',
    launchProfileId: 'claude-chat'
  } as unknown as Session,
  state: {} as Record<string, unknown>,
  api: {} as Record<string, unknown>,
  restart: vi.fn()
}))
vi.mock('../store/session-store', () => ({
  useSessionStore: { getState: () => h.state, setState: vi.fn() }
}))
vi.mock('../store/usage-store', () => ({
  accountsUsageFor: () => ({}),
  claudeUsageForModel: () => undefined,
  headroomLabel: () => '72% left · Overall'
}))
vi.mock('./account-policy', () => ({
  registerProviderSwitchRoad: vi.fn(),
  isChatSession: (session: { launchProfileId?: string }) =>
    session.launchProfileId === 'claude-chat' || session.launchProfileId === 'codex-chat'
}))
vi.mock('./switch-account', () => ({
  accountForLaunch: (provider: string) =>
    provider === 'codex' ? { id: 'c1', label: 'Codex 1' } : { id: 'work', label: 'Work' },
  accountProviderOf: () => 'claude',
  sessionAccountExhausted: () => false,
  restartSessionProcess: h.restart
}))

let mod: typeof import('./switch-provider')
beforeEach(async () => {
  vi.resetModules()
  h.state = { sessions: [h.session] }
  h.restart.mockReset()
  h.restart.mockResolvedValue({ ok: true, resumed: true })
  h.api = {
    providerSwitchConvert: vi.fn(async () => ({ ok: true, threadId: 'thread-7' })),
    providerSwitchPlan: vi.fn(),
    sessionsWrite: vi.fn(async () => undefined),
    onSessionStream: vi.fn(() => () => undefined),
    adaptersList: vi.fn(async () => [
      { adapterId: 'claude-chat', provider: 'claude', label: 'Claude' },
      { adapterId: 'codex-chat', provider: 'codex', label: 'Codex' }
    ]),
    adaptersModels: vi.fn(async () => [{ id: 'gpt-5.5', label: 'GPT-5.5' }]),
    sessionsHistory: vi.fn(async () => ({ items: [], before: null })),
    providerSwitchHandoff: vi.fn(async () => ({ path: '/tape.md', diffStat: null }))
  }
  Object.defineProperty(globalThis, 'window', {
    value: { electronAPI: h.api },
    configurable: true,
    writable: true
  })
  mod = await import('./switch-provider')
})
afterEach(() => {
  vi.useRealTimers()
})

const target = {
  adapterId: 'codex-chat',
  provider: 'codex',
  label: 'Codex',
  model: { id: 'gpt-5.5', label: 'GPT-5.5' }
}

describe('switchSessionProvider', () => {
  it('converts, then restarts the same tab on the Codex adapter resuming the thread, the store told it is a Codex chat', async () => {
    const handoff = vi.fn(async () => 'never')
    const result = await mod.switchSessionProvider('s1', {
      from: 'claude',
      target,
      road: 'convert',
      handoff
    })
    expect(result).toEqual({ ok: true, resumed: true, road: 'converted' })
    expect(h.api.providerSwitchConvert).toHaveBeenCalledWith('s1', {
      codexAccountId: 'c1',
      codexAccountLabel: 'Codex 1',
      model: 'gpt-5.5'
    })
    expect(handoff).not.toHaveBeenCalled()
    expect(h.restart).toHaveBeenCalledWith('s1', {
      overrides: {
        codexAccountId: 'c1',
        codexAccountLabel: 'Codex 1',
        adapterId: 'codex-chat',
        model: 'gpt-5.5',
        resume: 'thread-7',
        continuedFrom: { provider: 'claude', road: 'converted' }
      },
      patch: expect.objectContaining({
        codexMode: true,
        claudeMode: false,
        claudeAgentsMode: false,
        launchProfileId: 'codex-chat',
        model: 'gpt-5.5',
        codexAccountId: 'c1',
        codexAccountLabel: 'Codex 1',
        claudeProfileId: undefined,
        claudeProfileLabel: undefined,
        claudeConfigDir: undefined,
        continuedFrom: { provider: 'claude', road: 'converted' }
      })
    })
  })
  it('falls back to the handoff when Codex refuses the conversion, and says why', async () => {
    ;(h.api.providerSwitchConvert as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'Codex read the converted thread back with no turn in it.'
    })
    const handoff = vi.fn(async () => '# Continued from Claude · handoff')
    const result = await mod.switchSessionProvider('s1', {
      from: 'claude',
      target,
      road: 'convert',
      handoff
    })
    expect(result).toEqual({
      ok: true,
      resumed: true,
      road: 'handoff',
      fallback: 'Codex read the converted thread back with no turn in it.'
    })
    expect(handoff).toHaveBeenCalledOnce()
    const overrides = h.restart.mock.calls[0][1].overrides
    expect(overrides.resume).toBeUndefined()
    expect(overrides.firstMessage).toBe('# Continued from Claude · handoff')
    expect(overrides.continuedFrom).toEqual({ provider: 'claude', road: 'handoff' })
  })
  it('on the handoff road nothing is converted', async () => {
    await mod.switchSessionProvider('s1', {
      from: 'claude',
      target: {
        adapterId: 'echo',
        provider: 'echo',
        label: 'Echo',
        model: { id: 'echo-1', label: 'Echo 1' }
      },
      road: 'handoff',
      handoff: async () => 'handoff text'
    })
    expect(h.api.providerSwitchConvert).not.toHaveBeenCalled()
    const call = h.restart.mock.calls[0][1]
    expect(call.overrides).toEqual({
      adapterId: 'echo',
      model: 'echo-1',
      firstMessage: 'handoff text',
      continuedFrom: { provider: 'claude', road: 'handoff' }
    })
    expect(call.patch).toMatchObject({
      launchProfileId: 'dev-echo-adapter',
      claudeMode: true,
      codexMode: false
    })
  })
  it('reports a restart the host refused', async () => {
    h.restart.mockResolvedValue({
      ok: false,
      resumed: false,
      error: 'This session cannot be restarted from here.'
    })
    const result = await mod.switchSessionProvider('s1', {
      from: 'claude',
      target,
      road: 'handoff',
      handoff: async () => 'x'
    })
    expect(result).toMatchObject({
      ok: false,
      error: 'This session cannot be restarted from here.'
    })
  })
})

describe('providerSwitchLanding', () => {
  it("names the pool's account for the target's model with its headroom, and nothing for a provider without a pool", () => {
    expect(mod.providerSwitchLanding(target)).toEqual({
      account: { id: 'c1', label: 'Codex 1' },
      headroom: '72% left · Overall',
      overrides: { codexAccountId: 'c1', codexAccountLabel: 'Codex 1' }
    })
    expect(
      mod.providerSwitchLanding({
        provider: 'claude',
        model: { id: 'claude-opus-5-5', label: 'Opus 5.5' }
      })
    ).toEqual({
      account: { id: 'work', label: 'Work' },
      headroom: '72% left · Overall',
      overrides: { claudeProfileId: 'work', claudeProfileLabel: 'Work' }
    })
    expect(
      mod.providerSwitchLanding({ provider: 'echo', model: { id: 'echo-1', label: 'Echo 1' } })
    ).toEqual({
      account: null,
      headroom: null,
      overrides: {}
    })
  })
})

describe('requestHandoffNote', () => {
  it('asks the current agent for the note and resolves with its answer once the turn ends', async () => {
    let listener: ((stream: unknown) => void) | null = null
    h.api.onSessionStream = vi.fn((_id: string, cb: (stream: unknown) => void) => {
      listener = cb
      return () => {
        listener = null
      }
    })
    const note = mod.requestHandoffNote('s1', 5000)
    await Promise.resolve()
    expect(h.api.sessionsWrite).toHaveBeenCalledWith('s1', {
      type: 'user_message',
      text: mod.HANDOFF_NOTE_REQUEST
    })
    const emit = (event: unknown): void => listener?.({ kind: 'event', event })
    // Words before the request are the previous turn's and never the note.
    emit({ type: 'assistant_text', delta: 'earlier answer', final: true })
    emit({ type: 'user_message', text: mod.HANDOFF_NOTE_REQUEST })
    emit({ type: 'assistant_text', delta: 'We are ', final: false })
    emit({ type: 'assistant_text', delta: 'moving the chip.', final: false })
    // A subagent's words are its own.
    emit({ type: 'assistant_text', delta: 'subagent noise', final: true, parent: 'tool-1' })
    emit({ type: 'state_change', state: 'done' })
    await expect(note).resolves.toBe('We are moving the chip.')
    expect(listener).toBeNull()
  })
  it('gives up with nothing when the turn yields no text in time', async () => {
    vi.useFakeTimers()
    h.api.onSessionStream = vi.fn(() => () => undefined)
    const note = mod.requestHandoffNote('s1', 1000)
    await vi.advanceTimersByTimeAsync(1001)
    await expect(note).resolves.toBeNull()
  })
})

describe("lane E's third rung: the road the limit policy takes (PRDCT-4300)", () => {
  it('names Codex for a Claude tab once the host has said what it runs, and nothing before', async () => {
    const { registerProviderSwitchRoad } = await import('./account-policy')
    mod.installProviderSwitchRoad()
    expect(registerProviderSwitchRoad).toHaveBeenCalledWith({
      targetFor: mod.providerSwitchTargetFor,
      switchTo: mod.switchToProvider
    })
    await vi.waitFor(() =>
      expect(mod.providerSwitchTargetFor(h.session)).toEqual({
        adapterId: 'codex-chat',
        label: 'Codex'
      })
    )
    // A terminal tab's conversation is the CLI's own: no provider rung for it.
    expect(
      mod.providerSwitchTargetFor({ ...h.session, launchProfileId: 'claude-terminal' } as Session)
    ).toBeNull()
  })
  it("moves the tab on the plan's road with the target's first model, the handoff written from the host's history", async () => {
    ;(h.api.providerSwitchPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
      from: { adapterId: 'claude-chat', provider: 'claude' },
      to: { adapterId: 'codex-chat', provider: 'codex' },
      road: 'handoff',
      reason: 'no transcript'
    })
    ;(h.api.sessionsHistory as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        { event: { type: 'user_message', text: 'first question' } },
        { event: { type: 'assistant_text', delta: 'an answer', final: true } },
        { event: { type: 'tool_call', id: 't', name: 'Bash', input: {} } },
        { event: { type: 'assistant_text', delta: 'sub', final: true, parent: 'x' } }
      ],
      before: null
    })
    const result = await mod.switchToProvider('s1', 'codex-chat')
    expect(result).toMatchObject({ ok: true, road: 'handoff' })
    const call = h.restart.mock.calls.at(-1)![1]
    expect(call.overrides).toMatchObject({ adapterId: 'codex-chat', model: 'gpt-5.5' })
    expect(call.overrides.firstMessage).toContain('# Continued from Claude · handoff')
    expect(call.overrides.firstMessage).toContain('first question')
    expect(call.overrides.firstMessage).toContain('an answer')
    expect(call.overrides.firstMessage).toContain('- Bash')
    expect(call.overrides.firstMessage).not.toContain('sub')
    expect(call.overrides.firstMessage).toContain('The full conversation is in /tape.md')
  })
  it('refuses when the provider lists no model', async () => {
    ;(h.api.adaptersModels as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(h.api.providerSwitchPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
      from: { adapterId: 'claude-chat', provider: 'claude' },
      to: { adapterId: 'codex-chat', provider: 'codex' },
      road: 'convert',
      codexVersion: '0.167.0'
    })
    expect(await mod.switchToProvider('s1', 'codex-chat')).toMatchObject({ ok: false })
    expect(h.restart).not.toHaveBeenCalled()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createTriageStore, type TriageChoices, type TriageSelection } from './triage'
import type { TriagePrepareResult, TriageSnapshot } from '../../../shared/triage'
import type { LaunchRequest } from './launch-session'

const origin = { instanceId: 'instance-one', shellPid: 42, windowId: 2, windowKey: 'second' }
const prepared = {
  generatedAt: '2026-10-21T12:00:00Z',
  origin,
  snapshot: { origin, reconciliation: { complete: false } },
  contextMarkdown: '# Safe context\nNo transcripts.',
  launchPrompt: 'Read ./playbook.md and ./context.md for instance-one.',
  bundle: {
    dir: '/private/triage/capture-one',
    contextPath: 'context.md',
    promptPath: 'playbook.md',
    snapshotPath: 'snapshot.json'
  },
  externalCommands: {
    claude: "cd '/private/triage/capture-one' && claude",
    codex: "cd '/private/triage/capture-one' && codex"
  },
  agentLaunch: 'in-app',
  warnings: ['One renderer did not answer.'],
  summary: { mode: 'in-process', serverOk: true, windows: 2, sessions: 4, problems: 1 }
} as TriagePrepareResult

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- preserve inferred mock signatures
function fixture() {
  const selection = (provider: 'claude' | 'codex' = 'codex'): TriageSelection => ({
    provider,
    profileId: `${provider}-work-chat`,
    accountId: 'work',
    dangerousMode: false
  })
  const choices: TriageChoices = {
    profiles: ['claude', 'codex'].map((family) => ({
      id: `${family}-work-chat`,
      name: `${family} Work chat`,
      family: family as 'claude' | 'codex',
      command: [family],
      additionalArgs: ['--sandbox', 'read-only']
    })),
    accounts: {
      claude: [{ id: 'work', label: 'Work Claude', usable: true }],
      codex: [{ id: 'work', label: 'Work Codex', usable: true }]
    }
  }
  const deps = {
    prepare: vi.fn(async () => prepared),
    snapshot: vi.fn(async () => ({ origin }) as TriageSnapshot),
    choices: vi.fn(async () => choices),
    selection,
    workspace: vi.fn(() => 'workspace-one' as string | null),
    launch: vi.fn(async (request: LaunchRequest) => {
      request.onCreated?.('support-one')
      return 'support-one'
    }),
    writeText: vi.fn<(text: string) => Promise<void>>(async () => {})
  }
  const store = createTriageStore(deps)
  return { store, deps, choices }
}

describe('triage support controller', () => {
  it('captures once before launch and cancel/reopen creates no sessions', async () => {
    const { store, deps } = fixture()
    await store.getState().openDialog()
    expect(store.getState().prepared).toBe(prepared)
    store.getState().closeDialog()
    await store.getState().openDialog()
    expect(deps.prepare).toHaveBeenCalledTimes(1)
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it.each(['claude', 'codex'] as const)(
    'passes the exact %s selection, private cwd and capture prompt through ordinary launch',
    async (provider) => {
      const { store, deps } = fixture()
      await store.getState().openDialog()
      store.getState().select({ provider, dangerousMode: true })
      store.getState().setProblem('The terminal stopped repainting.')
      await store.getState().start()
      const request = deps.launch.mock.calls[0][0]
      expect(request).toMatchObject({
        cwd: { kind: 'path', path: prepared.bundle!.dir },
        remember: false,
        throwOnError: true,
        setup: {
          kind: provider,
          launchProfileId: `${provider}-work-chat`,
          dangerousMode: true,
          ...(provider === 'claude' ? { claudeProfileId: 'work' } : { codexAccountId: 'work' })
        }
      })
      expect(request.groupId).toBeUndefined()
      expect(request.initialPrompt).toContain(prepared.launchPrompt)
      expect(request.initialPrompt).toContain('The terminal stopped repainting.')
      expect(deps.snapshot).toHaveBeenCalledOnce()
      expect(store.getState().supportSessionId).toBe('support-one')
      expect(store.getState().launchState).toBe('started')
    }
  )

  it('guards double submit before preflight resolves and preserves success across reopen', async () => {
    const { store, deps } = fixture()
    await store.getState().openDialog()
    await Promise.all([store.getState().start(), store.getState().start()])
    store.getState().closeDialog()
    await store.getState().openDialog()
    await store.getState().start()
    await store.getState().refresh()
    expect(deps.launch).toHaveBeenCalledOnce()
    expect(deps.prepare).toHaveBeenCalledOnce()
  })

  it.each(['profile', 'account', 'credential'] as const)(
    'rejects a disappeared or unusable %s without substitution',
    async (removed) => {
      const { store, deps, choices } = fixture()
      await store.getState().openDialog()
      if (removed === 'profile') choices.profiles = []
      if (removed === 'account') choices.accounts.codex = []
      if (removed === 'credential') choices.accounts.codex[0].usable = false
      await store.getState().start()
      expect(deps.launch).not.toHaveBeenCalled()
      expect(store.getState().error).toMatch(/selected (account|launch profile)/)
      await store.getState().copy('context')
      expect(deps.writeText).toHaveBeenCalledWith(prepared.contextMarkdown)
    }
  )

  it.each(['instance', 'window', 'workspace'] as const)(
    'rejects a changed %s before spawning',
    async (change) => {
      const { store, deps } = fixture()
      await store.getState().openDialog()
      if (change === 'workspace') deps.workspace.mockReturnValue('workspace-two')
      else
        deps.snapshot.mockResolvedValue({
          origin: {
            ...origin,
            ...(change === 'instance' ? { instanceId: 'foreign' } : { windowId: 3 })
          }
        } as TriageSnapshot)
      await store.getState().start()
      expect(deps.launch).not.toHaveBeenCalled()
      expect(store.getState().error).toContain('Capture context again')
    }
  )

  it('keeps context and external copy usable on attached servers without in-app launch', async () => {
    const { store, deps } = fixture()
    deps.prepare.mockResolvedValue({ ...prepared, agentLaunch: 'external-only' })
    await store.getState().openDialog()
    await store.getState().start()
    await store.getState().copy('external')
    expect(deps.launch).not.toHaveBeenCalled()
    expect(deps.writeText).toHaveBeenCalledWith(prepared.externalCommands!.codex)
  })

  it('does not blindly retry an ambiguous provider/spawn failure, and omits raw errors', async () => {
    const { store, deps } = fixture()
    deps.launch.mockRejectedValue(new Error('SECRET_TOKEN=sentinel'))
    await store.getState().openDialog()
    await store.getState().start()
    expect(store.getState().launchState).toBe('uncertain')
    expect(store.getState().error).not.toContain('sentinel')
    store.getState().closeDialog()
    await store.getState().openDialog()
    await store.getState().start()
    await store.getState().refresh()
    await store.getState().copy('prompt')
    expect(deps.launch).toHaveBeenCalledOnce()
    expect(deps.writeText).toHaveBeenCalledWith(prepared.launchPrompt)
  })

  it('retains an acknowledged support id when renderer placement fails', async () => {
    const { store, deps } = fixture()
    deps.launch.mockImplementation(async (request) => {
      request.onCreated?.('known-tab')
      throw new Error('placement failed')
    })
    await store.getState().openDialog()
    await store.getState().start()
    expect(store.getState()).toMatchObject({
      launchState: 'started',
      supportSessionId: 'known-tab'
    })
    await store.getState().start()
    expect(deps.launch).toHaveBeenCalledOnce()
  })

  it('preserves useful context when reading launch choices fails', async () => {
    const { store, deps } = fixture()
    deps.choices.mockRejectedValue(new Error('provider unavailable'))
    await store.getState().openDialog()
    expect(store.getState().prepared).toBe(prepared)
    expect(store.getState().choicesError).toBeTruthy()
    await store.getState().copy('context')
    expect(deps.writeText).toHaveBeenCalledWith(prepared.contextMarkdown)
  })

  it('announces clipboard success only after it resolves and reports rejection honestly', async () => {
    const { store, deps } = fixture()
    await store.getState().openDialog()
    let resolve!: () => void
    deps.writeText.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolve = r
        })
    )
    const copying = store.getState().copy('context')
    expect(store.getState().copyStatus).toBeNull()
    resolve()
    await copying
    expect(store.getState().copyStatus).toBe('Copied')
    deps.writeText.mockRejectedValueOnce(new Error('clipboard denied'))
    await store.getState().copy('context')
    expect(store.getState().copyStatus).toContain('Copy failed')
  })

  it('bounds a capture that never answers and allows an explicit fresh capture', async () => {
    vi.useFakeTimers()
    try {
      const { store, deps } = fixture()
      deps.prepare.mockImplementationOnce(() => new Promise(() => {}))
      const opening = store.getState().openDialog()
      await vi.advanceTimersByTimeAsync(15_000)
      await opening
      expect(store.getState()).toMatchObject({ preparing: false, prepared: null })
      expect(store.getState().error).toContain('could not be prepared')
      await store.getState().refresh()
      expect(store.getState().prepared).toBe(prepared)
      expect(deps.launch).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not respawn after a timeout and reconciles a later creation acknowledgement', async () => {
    vi.useFakeTimers()
    try {
      const { store, deps } = fixture()
      let request!: LaunchRequest
      deps.launch.mockImplementation((r) => {
        request = r
        return new Promise(() => {})
      })
      await store.getState().openDialog()
      const starting = store.getState().start()
      await vi.advanceTimersByTimeAsync(15_000)
      await starting
      expect(store.getState().launchState).toBe('uncertain')
      await store.getState().start()
      expect(deps.launch).toHaveBeenCalledOnce()
      request.onCreated?.('late-tab')
      expect(store.getState()).toMatchObject({
        launchState: 'started',
        supportSessionId: 'late-tab'
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

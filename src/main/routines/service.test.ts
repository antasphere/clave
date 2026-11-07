import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionHostService, StartInput } from '@clave/server'
import type { Session, SessionInfo, SessionStream } from '@clave/contract/sessions'
import { WorkspaceFiles, memoryWorkspaceFilesStorage } from '@clave/server/workspace-files'
import type { LaunchFacts } from './launch'
import { RoutineReportRefusal, createRoutineService, type RoutineService } from './service'
import { RoutinesStore, STORE_FILE } from './store'

/**
 * The service over fakes (round 1 of the verifier found it had no test of its
 * own): a session host that records starts and lets a test drive the stream,
 * a trusted workspace file with routines, a memory store. What is pinned:
 * the report tool's session gate (G1), the recovery of a run the server
 * stopped during (G4), an agent that cannot report (G5), and a run that
 * waits for the agent tools and fails unstarted when they never come (F1).
 */

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clave-routines-svc-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const INDEX = '<html><script type="application/json" id="slideless-data">{}</script></html>'

function workspace(routines: Record<string, unknown>[]): string {
  const tpl = join(root, '.clave', 'routines', 'ok')
  mkdirSync(tpl, { recursive: true })
  writeFileSync(join(tpl, 'index.html'), INDEX)
  writeFileSync(
    join(tpl, 'schema.json'),
    JSON.stringify({ type: 'object', required: ['n'], properties: { n: { type: 'number' } } })
  )
  mkdirSync(join(root, '.clave', 'workspaces'), { recursive: true })
  const file = join(root, '.clave', 'workspaces', 'default.clave')
  writeFileSync(
    file,
    JSON.stringify({ name: 'G', cwd: '.', sessions: [], terminals: [], routines })
  )
  return file
}

const routine = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  schedule: '0 0 31 2 *',
  prompt: 'do it',
  report: { template: '.clave/routines/ok' },
  ...extra
})

/** A session host that starts nothing real: every start answers a new id,
 *  the stream listeners are kept so a test can emit frames. */
function fakeHost(): SessionHostService & {
  starts: StartInput[]
  stopped: string[]
  emit: (id: string, frame: SessionStream) => void
  exit: (id: string, code: number) => void
} {
  const sessions = new Map<string, Session>()
  const streams = new Map<string, Set<(s: SessionStream) => void>>()
  const exits = new Map<string, Set<(c: number) => void>>()
  const starts: StartInput[] = []
  const stopped: string[] = []
  let n = 0
  const host = {
    starts,
    stopped,
    emit: (id: string, frame: SessionStream) => {
      for (const l of streams.get(id) ?? []) l(frame)
    },
    exit: (id: string, code: number) => {
      for (const l of exits.get(id) ?? []) l(code)
    },
    list: () => [...sessions.values()],
    get: (id: string) => sessions.get(id),
    subscribe: (id: string, listener: (s: SessionStream) => void) => {
      if (!sessions.has(id)) throw new Error(`Unknown session: ${id}`)
      const set = streams.get(id) ?? new Set()
      set.add(listener)
      streams.set(id, set)
      return () => set.delete(listener)
    },
    subscribeExit: (id: string, listener: (c: number) => void) => {
      const set = exits.get(id) ?? new Set()
      set.add(listener)
      exits.set(id, set)
      return () => set.delete(listener)
    },
    start: async (input: StartInput): Promise<SessionInfo> => {
      starts.push(input)
      const id = `s${++n}`
      sessions.set(id, {
        id,
        provider: 'claude',
        transport: 'events',
        cwd: input.cwd,
        windowKey: input.windowKey ?? '',
        state: 'idle',
        createdAt: 1,
        adapterId: 'claude-chat',
        title: 't'
      })
      return {
        id,
        cwd: input.cwd,
        folderName: 'x',
        alive: true,
        claudeSessionId: `c-${id}`,
        piSessionId: null
      }
    },
    stop: async (id: string) => {
      stopped.push(id)
      sessions.delete(id)
    },
    resize: () => {},
    setView: (id: string) => sessions.get(id)!,
    write: async () => {},
    models: async () => [],
    commands: async () => [],
    control: async () => ({}),
    capabilities: () => ({ images: false }),
    history: () => ({ items: [], before: null }),
    listAdoptableRecords: () => [],
    discardRecord: () => {},
    release: () => ({ released: [], refused: [] }),
    rename: (id: string) => sessions.get(id)!,
    setPage: () => {},
    keepOnRecord: () => {},
    screen: async () => ({ lines: [] }),
    type: async () => ({ submitted: true, draftHandling: 'none' as const }),
    restart: async () => {
      throw new Error('no')
    }
  }
  return host as unknown as ReturnType<typeof fakeHost>
}

const facts: LaunchFacts = {
  preferences: () => ({
    version: 1,
    customProfiles: [],
    globalDefaults: {},
    workspaceOverrides: {}
  }),
  accounts: () => [{ id: 'default', label: 'Default', usable: true }],
  selectedAccountId: () => undefined
}

function memory(): {
  docs: Map<string, string>
  read: (n: string) => string | null
  write: (n: string, t: string) => void
} {
  const docs = new Map<string, string>()
  return { docs, read: (n) => docs.get(n) ?? null, write: (n, t) => void docs.set(n, t) }
}

async function build(
  file: string,
  host: ReturnType<typeof fakeHost>,
  storage = memory(),
  extra: Partial<Parameters<typeof createRoutineService>[0]> = {}
): Promise<RoutineService> {
  const files = new WorkspaceFiles(memoryWorkspaceFilesStorage())
  files.trustRoot(root)
  const service = createRoutineService({
    sessions: host,
    files,
    workspaces: async () => [{ id: 'ws', name: 'W', rootDir: root, profileFile: file }],
    facts,
    storage,
    dataDir: join(root, 'data'),
    claimsDir: join(root, 'claims'),
    holder: 'test',
    pluginDir: join(root, 'plugin'),
    viewer: false,
    schedule: false,
    rehome: () => {},
    providerSessionIdOf: (id) => `c-${id}`,
    agentToolsWaitMs: 50,
    ...extra
  })
  await service.start()
  return service
}

const key = (file: string, name: string): string => `${file}::${name}`

describe('the report tool gate (G1)', () => {
  it('takes a report from the run session only: not from another session, not from a discussion, not after the end', async () => {
    const host = fakeHost()
    const file = workspace([routine('Health')])
    const service = await build(file, host)
    const run = await service.runNow(key(file, 'Health'))
    expect(run.state).toBe('running')
    expect(run.sessionId).toBe('s1')
    // Another session of the host is not a run.
    await expect(
      service.report({
        sessionId: 'nope',
        status: 'ok',
        headline: 'h',
        summary: 's',
        data: { n: 1 }
      })
    ).rejects.toBeInstanceOf(RoutineReportRefusal)
    // Invalid data is refused with the schema's errors; the run goes on.
    await expect(
      service.report({
        sessionId: 's1',
        status: 'ok',
        headline: 'h',
        summary: 's',
        data: { n: 'x' }
      })
    ).rejects.toMatchObject({ errors: [expect.stringContaining('data/n')] })
    expect(service.list().routines[0].runs[0].deck).toBeNull()
    // The run's own session reports.
    const taken = await service.report({
      sessionId: 's1',
      status: 'attention',
      headline: 'look',
      summary: 's',
      data: { n: 1 }
    })
    expect(taken.runId).toBe(run.id)
    // The run ends on done with the report's status, and its process is stopped.
    host.emit('s1', { kind: 'event', event: { type: 'state_change', state: 'done' } })
    const ended = service.list().routines[0].runs[0]
    expect(ended.state).toBe('attention')
    expect(ended.headline).toBe('look')
    expect(host.stopped).toEqual(['s1'])
    // After the end, a report is refused.
    await expect(
      service.report({ sessionId: 's1', status: 'ok', headline: 'h', summary: 's', data: { n: 1 } })
    ).rejects.toThrow(/ended/)
    // A discussion opened on the run is not the run: it cannot report.
    const { sessionId } = await service.openDiscussion(run.id, 'w1', 'panel')
    expect(sessionId).toBe('s2')
    await expect(
      service.report({ sessionId: 's2', status: 'ok', headline: 'h', summary: 's', data: { n: 1 } })
    ).rejects.toThrow(/not one/)
  })
})

describe('what a start finds (G4)', () => {
  it('fails a run the previous life left running, and runs it no second time', async () => {
    const file = workspace([routine('Health')])
    const storage = memory()
    const store = new RoutinesStore(storage)
    store.addRun({
      id: 'old',
      routineKey: key(file, 'Health'),
      trigger: 'scheduled',
      startedAt: 1,
      endedAt: null,
      state: 'running',
      headline: null,
      summary: null,
      reason: null,
      sessionId: 'gone',
      providerSessionId: null,
      discussionSessionId: null,
      agent: 'claude',
      form: 'chat',
      model: null,
      account: null,
      deck: null,
      seen: false
    })
    expect(storage.docs.has(STORE_FILE)).toBe(true)
    const host = fakeHost()
    const service = await build(file, host, storage)
    const runs = service.list().routines[0].runs
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      id: 'old',
      state: 'failed',
      reason: 'the server stopped during the run'
    })
    expect(host.starts).toEqual([])
  })
})

describe('an agent that cannot report (G5)', () => {
  it('runs nothing for a Pi routine and records the reason', async () => {
    const host = fakeHost()
    const file = workspace([routine('Pi job', { agent: 'pi' })])
    const service = await build(file, host)
    const run = await service.runNow(key(file, 'Pi job'))
    expect(run.state).toBe('failed')
    expect(run.reason).toContain('cannot report')
    expect(host.starts).toEqual([])
  })
})

describe('the agent tools must be reachable (round 1, F1)', () => {
  it('waits for them, then starts; fails unstarted when they never come', async () => {
    const file = workspace([routine('Health')])
    let ready = false
    const host = fakeHost()
    const service = await build(file, host, memory(), {
      agentToolsReady: () => (ready ? Promise.resolve() : Promise.reject(new Error('no MCP yet')))
    })
    const failed = await service.runNow(key(file, 'Health'))
    expect(failed.state).toBe('failed')
    expect(failed.reason).toContain('agent tools are not reachable')
    expect(host.starts).toEqual([])
    ready = true
    const started = await service.runNow(key(file, 'Health'))
    expect(started.state).toBe('running')
    expect(host.starts).toHaveLength(1)
    const spawn = host.starts[0].options!
    expect(spawn.link).toEqual({
      kind: 'routine',
      routineKey: key(file, 'Health'),
      runId: started.id
    })
    expect(spawn.pluginDir).toBe(join(root, 'plugin'))
    expect(spawn.initialPrompt).toContain('/clave-routine:run Routine: Health')
  })
})

describe('the conversation id the discussion resumes on', () => {
  it('keeps what the stream named when the record answers nothing at the end', async () => {
    const host = fakeHost()
    const file = workspace([routine('Health')])
    const service = await build(file, host, memory(), { providerSessionIdOf: () => null })
    const run = await service.runNow(key(file, 'Health'))
    host.emit('s1', {
      kind: 'event',
      event: { type: 'session_meta', model: 'm', providerSessionId: 'conv-1' }
    })
    await service.report({
      sessionId: 's1',
      status: 'ok',
      headline: 'h',
      summary: 's',
      data: { n: 1 }
    })
    host.emit('s1', { kind: 'event', event: { type: 'state_change', state: 'done' } })
    expect(service.list().routines[0].runs[0].providerSessionId).toBe('conv-1')
    const { sessionId } = await service.openDiscussion(run.id, 'w1', 'tab')
    expect(host.starts[1].options?.resumeSessionId).toBe('conv-1')
    expect(host.starts[1].windowKey).toBe('w1')
    expect(host.starts[1].options?.link).toBeUndefined()
    expect(sessionId).toBe('s2')
  })
})

describe('a discussion carried on and reopened (6 November 2026)', () => {
  it('resumes after the messages sent in Discussion, not back at the run', async () => {
    const host = fakeHost()
    const file = workspace([routine('Health')])
    const service = await build(file, host, memory(), { providerSessionIdOf: () => null })
    const run = await service.runNow(key(file, 'Health'))
    host.emit('s1', {
      kind: 'event',
      event: { type: 'session_meta', model: 'm', providerSessionId: 'conv-run' }
    })
    await service.report({
      sessionId: 's1',
      status: 'ok',
      headline: 'h',
      summary: 's',
      data: { n: 1 }
    })
    host.emit('s1', { kind: 'event', event: { type: 'state_change', state: 'done' } })
    // The panel opens the discussion on the run's conversation...
    await service.openDiscussion(run.id, 'w1', 'panel')
    expect(host.starts[1].options?.resumeSessionId).toBe('conv-run')
    // ...the person writes, and the resumed chat carries on under a new id.
    host.emit('s2', {
      kind: 'event',
      event: { type: 'session_meta', model: 'm', providerSessionId: 'conv-talk' }
    })
    // While it lives, reopening the panel gets the very same session back.
    expect((await service.openDiscussion(run.id, 'w1', 'panel')).sessionId).toBe('s2')
    // Once it has stopped, the next discussion resumes where the talk left off.
    await host.stop('s2')
    await service.openDiscussion(run.id, 'w1', 'panel')
    expect(host.starts[2].options?.resumeSessionId).toBe('conv-talk')
  })
})

describe('what the record says of a run that never started (round 2, N1 and F12)', () => {
  it('records the run before the agent-tools wait, so a stop during it is recoverable', async () => {
    const file = workspace([routine('Health')])
    const host = fakeHost()
    let seen: unknown = null
    const service = await build(file, host, memory(), {
      agentToolsReady: async () => {
        seen = service.list().routines[0].runs[0]
        throw new Error('no MCP yet')
      }
    })
    const failed = await service.runNow(key(file, 'Health'))
    expect(failed.state).toBe('failed')
    expect(seen).toMatchObject({ id: failed.id, state: 'running' })
  })

  it('marks a late due occurrence of a routine that cannot run as a catch-up', async () => {
    // Hourly at the minute half an hour away: the latest occurrence is about
    // thirty minutes old, past the on-time threshold (a per-minute schedule
    // would always be on time, the e2e spec's own lesson).
    const hourly = `${(new Date().getMinutes() + 30) % 60} * * * *`
    const file = workspace([routine('Team', { scope: 'team', schedule: hourly })])
    const storage = memory()
    const store = new RoutinesStore(storage)
    store.considered(key(file, 'Team'), Date.now() - 3 * 3_600_000, hourly)
    const service = await build(file, fakeHost(), storage)
    await service.tick()
    const run = service.list().routines[0].runs[0]
    expect(run.state).toBe('failed')
    expect(run.reason).toBe('team scope is not built yet')
    expect(run.trigger).toBe('catch-up')
  })
})

describe('the agents that can report (round 2, gap)', () => {
  it('fails an Antigravity routine too, before any agent starts', async () => {
    const host = fakeHost()
    const file = workspace([routine('Agy', { agent: 'antigravity' })])
    const service = await build(file, host)
    const run = await service.runNow(key(file, 'Agy'))
    expect(run.state).toBe('failed')
    expect(run.reason).toContain('cannot report')
    expect(host.starts).toEqual([])
  })
})

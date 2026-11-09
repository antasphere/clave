import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionHostService, StartInput } from '@clave/server'
import type { RoutineRun } from '@clave/contract/routines'
import type { Session, SessionInfo, SessionStream } from '@clave/contract/sessions'
import { WorkspaceFiles, memoryWorkspaceFilesStorage } from '@clave/server/workspace-files'
import { DECKS_DIR, MAX_TEMPLATE_BYTES, escapeForScript } from './deck'
import type { LaunchFacts } from './launch'
import { PublishFailure, type PublishInput, type PublishOutcome } from './publisher'
import {
  RoutineReportRefusal,
  createRoutineService,
  type RoutineService,
  INTERRUPTED_REASON
} from './service'
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
  runsOn: 'every',
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
    identity: () => ({ id: 'server-test', name: 'TestMac' }),
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

describe('a run cut short from outside (7 November 2026)', () => {
  it('says it was interrupted, not that the agent ended without a report', async () => {
    const host = fakeHost()
    const file = workspace([routine('Health')])
    const service = await build(file, host, memory(), { providerSessionIdOf: () => null })
    await service.runNow(key(file, 'Health'))
    // the app quitting stops the chat: the CLI acknowledges the interrupt, the turn ends
    host.emit('s1', { kind: 'event', event: { type: 'turn_interrupted' } })
    host.emit('s1', { kind: 'event', event: { type: 'state_change', state: 'done' } })
    const run = service.list().routines[0].runs[0]
    expect(run.state).toBe('failed')
    expect(run.reason).toBe(INTERRUPTED_REASON)
  })
  it('a run that simply ends without its report still says so', async () => {
    const host = fakeHost()
    const file = workspace([routine('Health')])
    const service = await build(file, host, memory(), { providerSessionIdOf: () => null })
    await service.runNow(key(file, 'Health'))
    host.emit('s1', { kind: 'event', event: { type: 'state_change', state: 'done' } })
    expect(service.list().routines[0].runs[0].reason).toBe('ended without a report')
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

/** An hourly schedule whose latest occurrence is about thirty minutes old, and
 *  a store whose clock last considered it hours ago: a due catch-up at the
 *  next tick (the same seed as the catch-up test above). */
function dueHourly(
  file: string,
  name: string,
  storage = memory()
): {
  schedule: string
  storage: ReturnType<typeof memory>
} {
  const schedule = `${(new Date().getMinutes() + 30) % 60} * * * *`
  new RoutinesStore(storage).considered(key(file, name), Date.now() - 3 * 3_600_000, schedule)
  return { schedule, storage }
}

describe('a routine pinned to a server (PRDCT-4149)', () => {
  it('is listed on another server and never run there, by the tick or by Run now', async () => {
    const schedule = `${(new Date().getMinutes() + 30) % 60} * * * *`
    const file = workspace([routine('Nightly', { runsOn: 'Studio', schedule })])
    const { storage } = dueHourly(file, 'Nightly')
    const host = fakeHost()
    const service = await build(file, host, storage)
    await service.tick()
    expect(host.starts).toEqual([])
    const listed = service.list().routines[0]
    expect(listed.routine).toMatchObject({ runsOn: 'Studio', runsHere: false })
    expect(listed.runs).toEqual([])
    expect(listed.nextRunAt).toEqual(expect.any(Number))
    const refused = service.runNow(key(file, 'Nightly'))
    await expect(refused).rejects.toThrow(/Studio/)
    await expect(refused).rejects.toThrow(/TestMac/)
    expect(host.starts).toEqual([])
  })

  it('runs on the server it names, whatever the case of the name', async () => {
    const schedule = `${(new Date().getMinutes() + 30) % 60} * * * *`
    const file = workspace([routine('Nightly', { runsOn: 'testmac', schedule })])
    const { storage } = dueHourly(file, 'Nightly')
    const host = fakeHost()
    const service = await build(file, host, storage)
    await service.tick()
    expect(host.starts).toHaveLength(1)
    expect(service.list().routines[0].routine.runsHere).toBe(true)
    expect(service.list().routines[0].runs[0].trigger).toBe('catch-up')
  })

  it('runs on a server named by its id under another identity', async () => {
    const file = workspace([routine('Nightly', { runsOn: 'srv-42' })])
    const host = fakeHost()
    const service = await build(file, host, memory(), {
      identity: () => ({ id: 'srv-42', name: 'Studio' })
    })
    const run = await service.runNow(key(file, 'Nightly'))
    expect(run.state).toBe('running')
    expect(service.list().server).toEqual({ id: 'srv-42', name: 'Studio' })
  })

  it('answers the server it lists from', async () => {
    const file = workspace([routine('Health')])
    const service = await build(file, fakeHost())
    expect(service.list().server).toEqual({ id: 'server-test', name: 'TestMac' })
  })
})

describe('the deck read over the API (PRDCT-4149)', () => {
  it('answers the filled page of a reported run, and refuses a run with no deck', async () => {
    const host = fakeHost()
    const file = workspace([routine('Health')])
    const service = await build(file, host)
    const run = await service.runNow(key(file, 'Health'))
    const headline = 'all good </script> here'
    await service.report({ sessionId: 's1', status: 'ok', headline, summary: 's', data: { n: 1 } })
    host.emit('s1', { kind: 'event', event: { type: 'state_change', state: 'done' } })
    const { html } = await service.deck(run.id)
    const block = html.slice(html.indexOf('id="slideless-data"'), html.lastIndexOf('</script>'))
    expect(block).toContain(escapeForScript(JSON.stringify(headline)))
    expect(block).not.toContain(headline)

    await expect(service.deck('no-such-run')).rejects.toThrow(/no-such-run/)

    const bare = await service.runNow(key(file, 'Health'))
    host.emit('s2', { kind: 'event', event: { type: 'state_change', state: 'done' } })
    expect(service.list().routines[0].runs[0]).toMatchObject({ id: bare.id, deck: null })
    await expect(service.deck(bare.id)).rejects.toThrow(/no deck/)
  })
})

describe('the publish to Slideless (PRDCT-4149)', () => {
  /** A publisher that records what it is asked and answers a new version each time. */
  function fakePublisher(fail?: string): {
    inputs: PublishInput[]
    publish: (input: PublishInput) => Promise<PublishOutcome>
  } {
    const inputs: PublishInput[] = []
    return {
      inputs,
      publish: async (input) => {
        inputs.push(input)
        if (fail) throw new PublishFailure(fail)
        const share = { tokenId: 'tok', url: 'https://s.example/d' }
        return {
          deckId: 'deck-1',
          version: inputs.length,
          url: share.url,
          state: { deckId: 'deck-1', share },
          shareError: null
        }
      }
    }
  }

  const published = routine('Health', {
    report: { template: '.clave/routines/ok', publish: true }
  })

  async function reportedRun(
    service: RoutineService,
    host: ReturnType<typeof fakeHost>,
    file: string,
    sessionId: string
  ): Promise<string> {
    const run = await service.runNow(key(file, 'Health'))
    await service.report({ sessionId, status: 'ok', headline: 'h', summary: 's', data: { n: 1 } })
    host.emit(sessionId, { kind: 'event', event: { type: 'state_change', state: 'done' } })
    return run.id
  }

  const runOf = (service: RoutineService, id: string): RoutineRun =>
    service.list().routines[0].runs.find((r) => r.id === id)!

  it('pushes each run once, from its deck folder, under the routine name, with the kept state', async () => {
    const host = fakeHost()
    const file = workspace([published])
    const publisher = fakePublisher()
    const service = await build(file, host, memory(), { publisher })
    const first = await reportedRun(service, host, file, 's1')
    await vi.waitFor(() => expect(runOf(service, first).published).toBeDefined())
    expect(publisher.inputs).toHaveLength(1)
    const deck = runOf(service, first).deck!
    expect(publisher.inputs[0]).toMatchObject({
      folder: dirname(join(root, 'data', DECKS_DIR, deck)),
      title: 'Health',
      state: null
    })
    expect(runOf(service, first)).toMatchObject({
      state: 'ok',
      published: { deckId: 'deck-1', version: 1, url: 'https://s.example/d' },
      publishError: null
    })

    const second = await reportedRun(service, host, file, 's2')
    await vi.waitFor(() => expect(runOf(service, second).published).toBeDefined())
    expect(publisher.inputs).toHaveLength(2)
    expect(publisher.inputs[1].state).toEqual({
      deckId: 'deck-1',
      share: { tokenId: 'tok', url: 'https://s.example/d' }
    })
    expect(runOf(service, second).published?.version).toBe(2)
  })

  it('writes why on the run when the publish fails, and leaves the run ok', async () => {
    const host = fakeHost()
    const file = workspace([published])
    const service = await build(file, host, memory(), { publisher: fakePublisher('x') })
    const id = await reportedRun(service, host, file, 's1')
    await vi.waitFor(() => expect(runOf(service, id).publishError).toBe('x'))
    expect(runOf(service, id).state).toBe('ok')
    expect(runOf(service, id).published).toBeUndefined()
  })

  it('says no publisher runs in this process when the server has none', async () => {
    for (const publisher of [false as const, undefined]) {
      const host = fakeHost()
      const file = workspace([published])
      const service = await build(file, host, memory(), { publisher })
      const id = await reportedRun(service, host, file, 's1')
      await vi.waitFor(() =>
        expect(runOf(service, id).publishError).toMatch(/no Slideless publisher/)
      )
      expect(runOf(service, id).state).toBe('ok')
    }
  })

  const report = (service: RoutineService, sessionId: string, headline: string): Promise<unknown> =>
    service.report({ sessionId, status: 'ok', headline, summary: 's', data: { n: 1 } })
  const done = (host: ReturnType<typeof fakeHost>, sessionId: string): void =>
    host.emit(sessionId, { kind: 'event', event: { type: 'state_change', state: 'done' } })

  it('one run reported twice is published once, from its last deck (round 1, Minor 2)', async () => {
    const host = fakeHost()
    const file = workspace([published])
    const publisher = fakePublisher()
    const service = await build(file, host, memory(), { publisher })
    const run = await service.runNow(key(file, 'Health'))
    await report(service, 's1', 'first')
    const firstDeck = runOf(service, run.id).deck
    await report(service, 's1', 'second')
    // The correction rewrites the deck in place: same path, its content the last.
    expect(runOf(service, run.id).deck).toBe(firstDeck)
    done(host, 's1')
    await vi.waitFor(() => expect(runOf(service, run.id).published).toBeDefined())
    // Settle any stray publish a report might still have queued.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(publisher.inputs).toHaveLength(1)
    expect(publisher.inputs[0].folder).toBe(dirname(join(root, 'data', DECKS_DIR, firstDeck!)))
    expect(runOf(service, run.id)).toMatchObject({
      headline: 'second',
      published: { version: 1 }
    })
  })

  it('publishes nothing before the run ends', async () => {
    const host = fakeHost()
    const file = workspace([published])
    const publisher = fakePublisher()
    const service = await build(file, host, memory(), { publisher })
    await service.runNow(key(file, 'Health'))
    await report(service, 's1', 'h')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(publisher.inputs).toHaveLength(0)
    done(host, 's1')
    await vi.waitFor(() => expect(publisher.inputs).toHaveLength(1))
  })

  it('pushes one run at a time per routine, the second with the first one’s outcome (Gap 3)', async () => {
    const host = fakeHost()
    const file = workspace([published])
    const states: PublishInput['state'][] = []
    const share = { tokenId: 'tok', url: 'https://s.example/d' }
    const publisher = {
      publish: async (input: PublishInput): Promise<PublishOutcome> => {
        states.push(input.state)
        // Slow enough that the second run ends while the first push is on the wire.
        await new Promise((resolve) => setTimeout(resolve, 60))
        return {
          deckId: 'deck-1',
          version: states.length,
          url: share.url,
          state: { deckId: 'deck-1', share },
          shareError: null
        }
      }
    }
    const service = await build(file, host, memory(), { publisher })
    const first = await reportedRun(service, host, file, 's1')
    const second = await reportedRun(service, host, file, 's2')
    await vi.waitFor(() => {
      expect(runOf(service, first).published).toBeDefined()
      expect(runOf(service, second).published).toBeDefined()
    })
    // Had both pushed at once, both would have seen no deck and made two.
    expect(states).toEqual([null, { deckId: 'deck-1', share }])
  })

  it('never writes the share URL on a log line, only on the run (Gap 4)', async () => {
    const lines: string[] = []
    const log = (_level: 'info' | 'warn', message: string): void => void lines.push(message)
    const url = 'https://s.example/d/SECRET'
    const host = fakeHost()
    const file = workspace([published])
    const publisher = {
      publish: async (): Promise<PublishOutcome> => ({
        deckId: 'deck-1',
        version: 1,
        url,
        state: { deckId: 'deck-1', share: { tokenId: 'tok', url } },
        shareError: null
      })
    }
    const service = await build(file, host, memory(), { publisher, log })
    const id = await reportedRun(service, host, file, 's1')
    await vi.waitFor(() => expect(runOf(service, id).published?.url).toBe(url))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toContain('SECRET')

    // A failing publish: its reason on the run carries no URL either.
    const failingHost = fakeHost()
    const failing = await build(file, failingHost, memory(), {
      publisher: fakePublisher('refused'),
      log
    })
    const failed = await reportedRun(failing, failingHost, file, 's1')
    await vi.waitFor(() => expect(runOf(failing, failed).publishError).toBe('refused'))
    expect(runOf(failing, failed).publishError).not.toContain('SECRET')
    for (const line of lines) expect(line).not.toContain('SECRET')
  })

  it('publishes at the next start a run that reported and was cut off by the stop (round 2, Minor 1)', async () => {
    const host = fakeHost()
    const file = workspace([published])
    const storage = memory()
    const first = await build(file, host, storage, { publisher: fakePublisher() })
    const run = await first.runNow(key(file, 'Health'))
    await first.report({
      sessionId: 's1',
      status: 'ok',
      headline: 'h',
      summary: 's',
      data: { n: 1 }
    })
    // No end: the server stops here. The next life marks the run failed and
    // finds its deck with nothing published.
    await first.close()
    const publisher = fakePublisher()
    const second = await build(file, fakeHost(), storage, { publisher })
    await second.start()
    await vi.waitFor(() => expect(runOf(second, run.id).published).toBeDefined())
    expect(publisher.inputs).toHaveLength(1)
    expect(runOf(second, run.id)).toMatchObject({ state: 'failed', published: { version: 1 } })
    // A third life publishes it no second time: the SAME publisher counts.
    const third = await build(file, fakeHost(), storage, { publisher })
    await third.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(publisher.inputs).toHaveLength(1)
    expect(runOf(third, run.id).published?.version).toBe(1)
  })

  it('publishes at a start only the runs that start ended, oldest first, and never a routine turning publishing on (round 3)', async () => {
    const storage = memory()
    const host = fakeHost()
    // Three runs recorded while the routine did not publish: adopting the
    // feature must not push that history.
    const quiet = await build(workspace([routine('Health')]), host, storage)
    for (const sid of ['s1', 's2', 's3']) {
      const run = await quiet.runNow(key(quiet.list().routines[0].routine.file, 'Health'))
      await quiet.report({
        sessionId: sid,
        status: 'ok',
        headline: sid,
        summary: 's',
        data: { n: 1 }
      })
      host.emit(sid, { kind: 'event', event: { type: 'state_change', state: 'done' } })
      expect(runOf(quiet, run.id).deck).toBeTruthy()
    }
    await quiet.close()
    const publisher = fakePublisher()
    const file = workspace([published])
    const adopting = await build(file, fakeHost(), storage, { publisher })
    await adopting.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(publisher.inputs).toEqual([])

    // Two runs reported and cut off by the stop, the older first on Slideless;
    // a run whose publish already failed is not retried at a start.
    const live = fakeHost()
    const cutOff = await build(file, live, storage, { publisher: fakePublisher('refused') })
    const first = await cutOff.runNow(key(file, 'Health'))
    await cutOff.report({
      sessionId: 's1',
      status: 'ok',
      headline: 'first',
      summary: 's',
      data: { n: 1 }
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await cutOff.runNow(key(file, 'Health')).catch(() => null)
    // One run at a time per routine: the second run waits for the first to end,
    // so it is refused here; the first alone is the run the stop cuts off.
    expect(second).toBeNull()
    await cutOff.close()
    const next = fakePublisher()
    const restarted = await build(file, fakeHost(), storage, { publisher: next })
    await restarted.start()
    await vi.waitFor(() => expect(runOf(restarted, first.id).published).toBeDefined())
    expect(next.inputs).toHaveLength(1)
    // Its publish now on the record, a further start pushes nothing more.
    const again = fakePublisher()
    const later = await build(file, fakeHost(), storage, { publisher: again })
    await later.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(again.inputs).toEqual([])
  })

  it('a run whose publish failed is not retried at the next start (round 3, Gap)', async () => {
    const storage = memory()
    const host = fakeHost()
    const file = workspace([published])
    const failing = await build(file, host, storage, { publisher: fakePublisher('refused') })
    const id = await reportedRun(failing, host, file, 's1')
    await vi.waitFor(() => expect(runOf(failing, id).publishError).toBe('refused'))
    await failing.close()
    const publisher = fakePublisher()
    const next = await build(file, fakeHost(), storage, { publisher })
    await next.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(publisher.inputs).toEqual([])
  })

  it('a run cut off is not published at a start on a server the routine no longer names (round 3, Note 2)', async () => {
    const storage = memory()
    const host = fakeHost()
    const file = workspace([published])
    const before = await build(file, host, storage, { publisher: fakePublisher() })
    await before.runNow(key(file, 'Health'))
    await before.report({
      sessionId: 's1',
      status: 'ok',
      headline: 'h',
      summary: 's',
      data: { n: 1 }
    })
    await before.close()
    const publisher = fakePublisher()
    // The same file now pins the routine to another server: this server no
    // longer runs it, and the run it cut off is not its to publish.
    const pinnedFile = workspace([{ ...published, runsOn: 'Studio' }])
    const pinnedAway = await build(pinnedFile, fakeHost(), storage, { publisher })
    await pinnedAway.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(publisher.inputs).toEqual([])
  })

  it('a run interrupted after its report keeps the report and publishes once (round 2, Note 1)', async () => {
    const host = fakeHost()
    const file = workspace([published])
    const publisher = fakePublisher()
    const service = await build(file, host, memory(), { publisher })
    const run = await service.runNow(key(file, 'Health'))
    await service.report({
      sessionId: 's1',
      status: 'attention',
      headline: 'h',
      summary: 's',
      data: { n: 1 }
    })
    host.emit('s1', { kind: 'event', event: { type: 'turn_interrupted' } })
    host.emit('s1', { kind: 'event', event: { type: 'state_change', state: 'done' } })
    await vi.waitFor(() => expect(runOf(service, run.id).published).toBeDefined())
    expect(runOf(service, run.id).state).toBe('attention')
    expect(publisher.inputs).toHaveLength(1)
  })

  it('never calls the publisher for a routine that does not publish', async () => {
    const host = fakeHost()
    const file = workspace([routine('Health')])
    const publisher = fakePublisher()
    const service = await build(file, host, memory(), { publisher })
    const id = await reportedRun(service, host, file, 's1')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(publisher.inputs).toEqual([])
    expect(runOf(service, id).publishError).toBeUndefined()
    expect(runOf(service, id).published).toBeUndefined()
  })
})

describe('the deck read is confined and bounded (Gap 1)', () => {
  /** A run ended with a deck, its service, and the storage it records into. */
  async function endedRun(): Promise<{
    file: string
    runId: string
    deck: string
    storage: ReturnType<typeof memory>
  }> {
    const host = fakeHost()
    const file = workspace([routine('Health')])
    const storage = memory()
    const service = await build(file, host, storage)
    const run = await service.runNow(key(file, 'Health'))
    await service.report({
      sessionId: 's1',
      status: 'ok',
      headline: 'h',
      summary: 's',
      data: { n: 1 }
    })
    host.emit('s1', { kind: 'event', event: { type: 'state_change', state: 'done' } })
    const deck = service.list().routines[0].runs[0].deck!
    expect(deck).toEqual(expect.any(String))
    return { file, runId: run.id, deck, storage }
  }

  /** The record edited by hand, as a tampered or corrupted `routines.json` would be. */
  function rewriteDeck(storage: ReturnType<typeof memory>, runId: string, deck: string): void {
    const doc = JSON.parse(storage.docs.get(STORE_FILE)!) as {
      routines: Record<string, { runs: Array<{ id: string; deck: string | null }> }>
    }
    for (const state of Object.values(doc.routines))
      for (const run of state.runs) if (run.id === runId) run.deck = deck
    storage.docs.set(STORE_FILE, JSON.stringify(doc))
  }

  it('refuses a recorded deck path that leaves the decks folder, and never answers its text', async () => {
    const { file, runId, storage } = await endedRun()
    // Two levels above the decks root (`<root>/data/decks`): `<root>/outside.html`.
    writeFileSync(join(root, 'outside.html'), 'TOP-SECRET')
    for (const escape of ['../../outside.html', '/etc/hosts']) {
      rewriteDeck(storage, runId, escape)
      // A new service reads the record afresh (the store caches what it read).
      const service = await build(file, fakeHost(), storage)
      const answer = service.deck(runId)
      await expect(answer).rejects.toThrow(/decks folder/)
      const outcome = await answer.then(
        (r) => JSON.stringify(r),
        (e: unknown) => String(e)
      )
      expect(outcome).not.toContain('TOP-SECRET')
    }
  })

  it('refuses a deck page larger than 5 MiB', async () => {
    const { file, runId, deck, storage } = await endedRun()
    writeFileSync(join(root, 'data', DECKS_DIR, deck), 'x'.repeat(MAX_TEMPLATE_BYTES + 1))
    const service = await build(file, fakeHost(), storage)
    await expect(service.deck(runId)).rejects.toThrow(/5 MiB/)
  })
})

// ── PRDCT-4242: the routines a server keeps in its own store ──
describe('the routines a server creates in its own store (PRDCT-4242)', () => {
  const tpl = (): string => join(root, '.clave', 'routines', 'ok')
  const digest = (over: Record<string, unknown> = {}): Parameters<RoutineService['create']>[0] => ({
    workspaceId: 'ws',
    name: 'Digest',
    schedule: '0 0 31 2 *',
    prompt: 'Read @root_path and report.',
    ...over
  })

  it('creates a routine that runs here, on the built-in report page, and lists it beside the files’', async () => {
    const file = workspace([routine('FromFile')])
    const host = fakeHost()
    const service = await build(file, host, memory(), { defaultTemplate: tpl() })
    const view = await service.create(
      digest({ icon: 'bolt', launch: { model: 'm' }, schedule: '0 8 * * *' })
    )
    expect(view.routine).toMatchObject({
      name: 'Digest',
      origin: 'created',
      runsOn: 'TestMac',
      runsHere: true,
      paused: false,
      workspaceName: 'W',
      cwd: root,
      icon: 'bolt',
      invalid: null
    })
    expect(view.routine.key).toMatch(/^created::/)
    expect(view.routine.report.template).toBe(tpl())
    expect(view.routine.prompt).toBe(`Read ${root} and report.`)
    expect(view.nextRunAt).toEqual(expect.any(Number))
    const names = service.list().routines.map((v) => [v.routine.name, v.routine.origin ?? 'file'])
    expect(names).toEqual([
      ['FromFile', 'file'],
      ['Digest', 'created']
    ])
    // Run now starts it with the default page's schema, and a report lands a deck.
    const run = await service.runNow(view.routine.key)
    expect(run.state).toBe('running')
    expect(host.starts).toHaveLength(1)
    const reported = await service.report({
      sessionId: 's1',
      status: 'ok',
      headline: 'h',
      summary: 's',
      data: { n: 1 }
    })
    expect(reported.deck).toMatch(/index\.html$/)
  })

  it('refuses what could never run, at creation: the workspace, the folder, the schedule, the agent, a twin name', async () => {
    const file = workspace([])
    const service = await build(file, fakeHost(), memory(), { defaultTemplate: tpl() })
    await expect(service.create(digest({ workspaceId: 'nope' }))).rejects.toThrow(
      /No workspace "nope"/
    )
    await expect(service.create(digest({ cwd: 'gone' }))).rejects.toThrow(/is not on this machine/)
    await expect(service.create(digest({ schedule: 'daily' }))).rejects.toThrow(/does not parse/)
    await expect(service.create(digest({ launch: { agent: 'pi' } }))).rejects.toThrow(
      /cannot report/
    )
    await expect(service.create(digest({ name: '  ' }))).rejects.toThrow(/needs a name/)
    await service.create(digest())
    await expect(service.create(digest({ name: 'digest' }))).rejects.toThrow(/already exists/)
    expect(service.list().routines).toHaveLength(1)
  })

  it('a created routine without a default page must name a template of its own', async () => {
    const file = workspace([])
    const service = await build(file, fakeHost(), memory())
    await expect(service.create(digest())).rejects.toThrow(/built-in report page is missing/)
    const own = await service.create(digest({ report: { template: '.clave/routines/ok' } }))
    expect(own.routine.report.template).toBe(tpl())
  })

  it('a paused routine is listed, skipped by the tick and refused by Run now; resumed, it runs on Run now', async () => {
    const file = workspace([])
    const host = fakeHost()
    const storage = memory()
    const schedule = `${(new Date().getMinutes() + 30) % 60} * * * *`
    const first = await build(file, fakeHost(), storage, { defaultTemplate: tpl() })
    const view = await first.create(digest({ schedule }))
    const key = view.routine.key
    await first.close()
    // Due for hours, as the catch-up tests seed it: on the store before the
    // service that ticks reads it (the service caches its store).
    new RoutinesStore(storage).considered(key, Date.now() - 3 * 3_600_000, schedule)
    const service = await build(file, host, storage, { defaultTemplate: tpl() })
    expect(service.list().routines.map((v) => v.routine.key)).toEqual([key])
    const paused = await service.pause(key, true)
    expect(paused.routine.paused).toBe(true)
    await service.tick()
    expect(host.starts).toEqual([])
    await expect(service.runNow(key)).rejects.toThrow(/is paused/)
    const resumed = await service.pause(key, false)
    expect(resumed.routine.paused).toBe(false)
    // What was missed on hold is not caught up (verifier round 1, F5): the
    // next tick starts nothing, Run now starts it.
    await service.tick()
    expect(host.starts).toEqual([])
    const run = await service.runNow(key)
    expect(run.state).toBe('running')
    expect(host.starts).toHaveLength(1)
  })

  it('updates a created routine’s fields and refuses to touch a file’s, naming the file', async () => {
    const file = workspace([routine('FromFile')])
    const service = await build(file, fakeHost(), memory(), { defaultTemplate: tpl() })
    const view = await service.create(digest())
    const updated = await service.update(view.routine.key, {
      schedule: '30 8 * * 1-5',
      name: 'Morning digest',
      cwd: '.'
    })
    expect(updated.routine).toMatchObject({ schedule: '30 8 * * 1-5', name: 'Morning digest' })
    await expect(service.update(view.routine.key, { schedule: 'nope' })).rejects.toThrow(
      /does not parse/
    )
    await expect(service.update(key(file, 'FromFile'), { schedule: '0 9 * * *' })).rejects.toThrow(
      new RegExp(`comes from ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    )
    await expect(service.pause(key(file, 'FromFile'), true)).rejects.toThrow(/edit the file/)
  })

  it('a name taken by a file routine or another created one is refused, on create and on rename', async () => {
    const file = workspace([routine('FromFile')])
    const service = await build(file, fakeHost(), memory(), { defaultTemplate: tpl() })
    await expect(service.create(digest({ name: 'fromfile' }))).rejects.toThrow(/already exists/)
    const one = await service.create(digest({ name: 'One' }))
    await service.create(digest({ name: 'Two' }))
    await expect(service.update(one.routine.key, { name: 'two' })).rejects.toThrow(/already exists/)
    await expect(service.update(one.routine.key, { name: 'FROMFILE' })).rejects.toThrow(
      /already exists/
    )
    // Its own name, in another case, is not a clash.
    expect((await service.update(one.routine.key, { name: 'ONE' })).routine.name).toBe('ONE')
    await expect(service.create(digest({ prompt: '  ' }))).rejects.toThrow(/needs a prompt/)
  })

  it('a resumed routine catches nothing up from the time it was on hold', async () => {
    const file = workspace([])
    const host = fakeHost()
    const storage = memory()
    const schedule = `${(new Date().getMinutes() + 30) % 60} * * * *`
    const first = await build(file, fakeHost(), storage, { defaultTemplate: tpl() })
    const view = await first.create(digest({ schedule }))
    const key = view.routine.key
    await first.pause(key, true)
    await first.close()
    // Hours on hold, as the store would carry them.
    new RoutinesStore(storage).considered(key, Date.now() - 3 * 3_600_000, schedule)
    const service = await build(file, host, storage, { defaultTemplate: tpl() })
    await service.tick()
    expect(host.starts).toEqual([])
    await service.pause(key, false)
    await service.tick()
    expect(host.starts).toEqual([])
  })

  it('deletes a created routine with its runs and decks, never a file’s', async () => {
    const file = workspace([routine('FromFile')])
    const host = fakeHost()
    const storage = memory()
    const service = await build(file, host, storage, { defaultTemplate: tpl() })
    const view = await service.create(digest())
    const run = await service.runNow(view.routine.key)
    await service.report({
      sessionId: 's1',
      status: 'ok',
      headline: 'h',
      summary: 's',
      data: { n: 1 }
    })
    host.emit('s1', { kind: 'event', event: { type: 'state_change', state: 'done' } })
    expect(
      service.list().routines.find((v) => v.routine.key === view.routine.key)?.runs
    ).toHaveLength(1)
    await service.delete(view.routine.key)
    expect(service.list().routines.map((v) => v.routine.name)).toEqual(['FromFile'])
    expect(new RoutinesStore(storage).run(run.id)).toBeUndefined()
    await expect(service.delete(key(file, 'FromFile'))).rejects.toThrow(/edit the file to delete/)
    await expect(service.delete(view.routine.key)).rejects.toThrow(/No routine/)
  })

  it('a created routine whose workspace left the registry is listed as unable to run', async () => {
    const file = workspace([])
    const storage = memory()
    const first = await build(file, fakeHost(), storage, { defaultTemplate: tpl() })
    await first.create(digest())
    await first.close()
    const files = new WorkspaceFiles(memoryWorkspaceFilesStorage())
    files.trustRoot(root)
    const gone = createRoutineService({
      sessions: fakeHost(),
      files,
      workspaces: async () => [],
      identity: () => ({ id: 'server-test', name: 'TestMac' }),
      facts,
      storage,
      dataDir: join(root, 'data'),
      claimsDir: join(root, 'claims'),
      holder: 'test',
      pluginDir: join(root, 'plugin'),
      viewer: false,
      schedule: false,
      rehome: () => {},
      providerSessionIdOf: () => null,
      defaultTemplate: tpl()
    })
    await gone.start()
    const [listed] = gone.list().routines
    expect(listed.routine).toMatchObject({ origin: 'created', runsHere: false })
    expect(listed.routine.invalid).toMatch(/no longer registered/)
  })
})

// ── PRDCT-4243: a created routine moved into a file, in one step on the server ──
describe('a created routine moved into a file (verifier rounds 1 and 2, F1 and G1)', () => {
  const tpl = (): string => join(root, '.clave', 'routines', 'ok')
  const digest = (over: Record<string, unknown> = {}): Parameters<RoutineService['create']>[0] => ({
    workspaceId: 'ws',
    name: 'Morning digest',
    schedule: '30 8 * * 1-5',
    prompt: 'Read @root_path now',
    launch: { model: 'm', dangerousMode: true },
    icon: 'bolt',
    ...over
  })
  const profile = (): string => join(root, '.clave', 'workspaces', 'default.clave')
  const readFile = (): Record<string, unknown> => JSON.parse(readFileSync(profile(), 'utf8'))

  it('writes the routine into the profile file’s group with runsOn, the prompt as typed and a copied page, and forgets it in the store', async () => {
    const file = workspace([routine('FromFile')])
    const host = fakeHost()
    const storage = memory()
    const service = await build(file, host, storage, { defaultTemplate: tpl() })
    const view = await service.create(digest())
    const run = await service.runNow(view.routine.key)
    await service.report({
      sessionId: 's1',
      status: 'ok',
      headline: 'h',
      summary: 's',
      data: { n: 1 }
    })
    host.emit('s1', { kind: 'event', event: { type: 'state_change', state: 'done' } })
    const moved = await service.moveToFile(view.routine.key, {})
    expect(moved).toEqual({
      name: 'Morning digest',
      file: profile(),
      group: 'G',
      template: join(root, '.clave', 'routines', 'morning-digest'),
      runsOn: 'TestMac'
    })
    const written = readFile()
    const routines = written.routines as Array<Record<string, unknown>>
    expect(routines.map((r) => r.name)).toEqual(['FromFile', 'Morning digest'])
    expect(routines[1]).toMatchObject({
      runsOn: 'TestMac',
      prompt: 'Read @root_path now',
      model: 'm',
      dangerousMode: true,
      icon: 'bolt',
      schedule: '30 8 * * 1-5',
      report: { template: '.clave/routines/morning-digest' }
    })
    expect(routines[1]).not.toHaveProperty('server')
    expect(existsSync(join(root, '.clave', 'routines', 'morning-digest', 'index.html'))).toBe(true)
    // The store and the history: gone; the file's copy is listed, placed here, and runs.
    await service.refresh()
    const listed = service
      .list()
      .routines.map((v) => [v.routine.name, v.routine.origin, v.routine.runsHere])
    expect(listed).toEqual([
      ['FromFile', 'file', true],
      ['Morning digest', 'file', true]
    ])
    expect(new RoutinesStore(storage).run(run.id)).toBeUndefined()
  })

  it('a move refused while a run is in flight changes nothing: no file written, no page copied, the routine kept', async () => {
    const file = workspace([])
    const host = fakeHost()
    const service = await build(file, host, memory(), { defaultTemplate: tpl() })
    const view = await service.create(digest())
    await service.runNow(view.routine.key)
    const before = readFileSync(profile(), 'utf8')
    await expect(service.moveToFile(view.routine.key, {})).rejects.toThrow(/is running/)
    expect(readFileSync(profile(), 'utf8')).toBe(before)
    expect(existsSync(join(root, '.clave', 'routines', 'morning-digest'))).toBe(false)
    expect(service.list().routines.map((v) => v.routine.origin)).toEqual(['created'])
  })

  it('takes the next free folder for the page, keeps a template of the routine’s own, refuses a taken name and a file’s routine', async () => {
    const file = workspace([routine('FromFile')])
    const service = await build(file, fakeHost(), memory(), { defaultTemplate: tpl() })
    mkdirSync(join(root, '.clave', 'routines', 'morning-digest'), { recursive: true })
    writeFileSync(
      join(root, '.clave', 'routines', 'morning-digest', 'index.html'),
      'someone else’s'
    )
    const a = await service.create(digest())
    const movedA = await service.moveToFile(a.routine.key, { group: 'Jobs' })
    expect(movedA.template).toBe(join(root, '.clave', 'routines', 'morning-digest-2'))
    expect(
      readFileSync(join(root, '.clave', 'routines', 'morning-digest', 'index.html'), 'utf8')
    ).toBe('someone else’s')
    expect((readFile().groups as Array<Record<string, unknown>>).map((g) => g.name)).toEqual([
      'G',
      'Jobs'
    ])
    await service.refresh()
    // The same name again, into the same group: refused, the created one kept.
    const b = await service
      .create(digest({ name: 'Morning Digest', workspaceId: 'ws' }))
      .catch((e: Error) => e)
    expect(b).toBeInstanceOf(Error) // a name a file routine of the workspace holds (F8)
    const own = await service.create(
      digest({ name: 'Own page', report: { template: '.clave/routines/ok' } })
    )
    const movedOwn = await service.moveToFile(own.routine.key, { group: 'Jobs' })
    expect(movedOwn.template).toBe(tpl())
    await expect(service.moveToFile(key(file, 'FromFile'), {})).rejects.toThrow(
      /edit the file to move/
    )
  })

  it('two moves into one file at once both land, one after the other (round 3, H2)', async () => {
    const file = workspace([])
    const service = await build(file, fakeHost(), memory(), { defaultTemplate: tpl() })
    const a = await service.create(digest({ name: 'Alpha' }))
    const b = await service.create(digest({ name: 'Beta' }))
    const outcomes = await Promise.allSettled([
      service.moveToFile(a.routine.key, {}),
      service.moveToFile(b.routine.key, {})
    ])
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled'])
    const names = (readFile().routines as Array<{ name: string }>).map((r) => r.name)
    expect(names).toEqual(['Alpha', 'Beta'])
    expect(service.list().routines.map((v) => [v.routine.name, v.routine.origin])).toEqual([
      ['Alpha', 'file'],
      ['Beta', 'file']
    ])
  })

  it('a move and a delete of the same routine at once: exactly one lands (round 3, H3)', async () => {
    const file = workspace([])
    const service = await build(file, fakeHost(), memory(), { defaultTemplate: tpl() })
    const a = await service.create(digest({ name: 'Alpha' }))
    const outcomes = await Promise.allSettled([
      service.moveToFile(a.routine.key, {}),
      service.delete(a.routine.key)
    ])
    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected'])
    const inFile = ((readFile().routines as Array<{ name: string }> | undefined) ?? []).some(
      (r) => r.name === 'Alpha'
    )
    const listed = service.list().routines.filter((v) => v.routine.name === 'Alpha')
    // Moved: in the file once, listed once as a file's; deleted: nowhere.
    expect(inFile ? listed.map((v) => v.routine.origin) : listed).toEqual(inFile ? ['file'] : [])
  })

  it('a rewrite keeps a legacy server value another routine still says, and a one-group multi file stays multi (round 3, H5 and R7)', async () => {
    const legacy = { ...routine('Legacy pin'), runsOn: undefined, server: 'Studio' }
    const file = workspace([legacy])
    // The fixture writes a single group; make it a one-group multi file.
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ groups: [doc] }))
    const service = await build(file, fakeHost(), memory(), { defaultTemplate: tpl() })
    const view = await service.create(digest())
    await service.moveToFile(view.routine.key, {})
    const written = readFile()
    expect(written).toHaveProperty('groups')
    const groups = written.groups as Array<{ routines: Array<Record<string, unknown>> }>
    expect(groups).toHaveLength(1)
    expect(groups[0].routines[0]).toMatchObject({ name: 'Legacy pin', server: 'Studio' })
    expect(groups[0].routines[1]).toMatchObject({ name: 'Morning digest', runsOn: 'TestMac' })
  })

  it('a move forgets the routine’s decks (round 3, R8), and a resume with no tick on hold catches nothing up (N5)', async () => {
    const file = workspace([])
    const host = fakeHost()
    const storage = memory()
    const service = await build(file, host, storage, { defaultTemplate: tpl() })
    const view = await service.create(digest())
    await service.runNow(view.routine.key)
    await service.report({
      sessionId: 's1',
      status: 'ok',
      headline: 'h',
      summary: 's',
      data: { n: 1 }
    })
    host.emit('s1', { kind: 'event', event: { type: 'state_change', state: 'done' } })
    const decks = join(root, 'data', DECKS_DIR)
    const before = readdirSync(decks).filter((f) => f !== 'index.html')
    expect(before).toHaveLength(1)
    await service.moveToFile(view.routine.key, {})
    expect(readdirSync(decks).filter((f) => f !== 'index.html')).toHaveLength(0)
    // N5: paused, never ticked, the clock seeded hours back, resumed: nothing starts.
    const schedule = `${(new Date().getMinutes() + 30) % 60} * * * *`
    const paused = await service.create(digest({ name: 'Held', schedule }))
    await service.pause(paused.routine.key, true)
    await service.close()
    new RoutinesStore(storage).considered(paused.routine.key, Date.now() - 3 * 3_600_000, schedule)
    const second = await build(file, host, storage, { defaultTemplate: tpl() })
    await second.pause(paused.routine.key, false)
    await second.tick()
    expect(host.starts).toHaveLength(1) // the one run of Morning digest above, nothing new
  })

  it('a move during an in-flight refresh is listed once the refresh ends (round 4, K1)', async () => {
    const file = workspace([routine('Existing')])
    const service = await build(file, fakeHost(), memory(), { defaultTemplate: tpl() })
    const a = await service.create(digest({ name: 'Alpha' }))
    const racing = service.refresh()
    await service.moveToFile(a.routine.key, {})
    await racing
    expect(service.list().routines.map((v) => [v.routine.name, v.routine.origin])).toEqual([
      ['Existing', 'file'],
      ['Alpha', 'file']
    ])
  })

  it('a paused routine is not moved: resume it first (round 4, K2)', async () => {
    const file = workspace([])
    const service = await build(file, fakeHost(), memory(), { defaultTemplate: tpl() })
    const a = await service.create(digest())
    await service.pause(a.routine.key, true)
    await expect(service.moveToFile(a.routine.key, {})).rejects.toThrow(
      /is paused: a file routine cannot be paused/
    )
    expect(service.list().routines[0].routine).toMatchObject({ origin: 'created', paused: true })
  })

  it('the profile file that cannot be read is refused, nothing overwritten (round 3, H1)', async () => {
    const file = workspace([])
    const service = await build(file, fakeHost(), memory(), { defaultTemplate: tpl() })
    const view = await service.create(digest())
    writeFileSync(file, '{"groups": [,]}')
    await expect(service.moveToFile(view.routine.key, {})).rejects.toThrow(
      /cannot be read as a workspace file/
    )
    expect(readFileSync(file, 'utf8')).toBe('{"groups": [,]}')
    expect(service.list().routines.map((v) => v.routine.origin)).toEqual(['created'])
    expect(existsSync(join(root, '.clave', 'routines', 'morning-digest'))).toBe(false)
  })

  it('a write that fails leaves the routine in the store and no copied page behind (round 3, H4)', async () => {
    // The registered profile sits where no folder can be made: under a file.
    const blocked = join(root, '.clave', 'workspaces', 'blocked')
    mkdirSync(join(root, '.clave', 'workspaces'), { recursive: true })
    writeFileSync(blocked, 'not a folder')
    const file = workspace([])
    const service = await build(file, fakeHost(), memory(), {
      defaultTemplate: tpl(),
      workspaces: async () => [
        { id: 'ws', name: 'W', rootDir: root, profileFile: join(blocked, 'x.clave') }
      ]
    })
    const view = await service.create(digest())
    await expect(service.moveToFile(view.routine.key, {})).rejects.toThrow()
    expect(service.list().routines.map((v) => v.routine.origin)).toEqual(['created'])
    expect(existsSync(join(root, '.clave', 'routines', 'morning-digest'))).toBe(false)
  })

  it('a profile reached through a link is refused (rounds 4 and 5, K3 and L2)', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'elsewhere-'))
    try {
      const file = workspace([])
      symlinkSync(elsewhere, join(root, 'linkdir'))
      const service = await build(file, fakeHost(), memory(), {
        defaultTemplate: tpl(),
        workspaces: async () => [
          {
            id: 'ws',
            name: 'W',
            rootDir: root,
            profileFile: join(root, 'linkdir', 'sub', 'x.clave')
          }
        ]
      })
      const a = await service.create(digest({ name: 'Alpha' }))
      await expect(service.moveToFile(a.routine.key, {})).rejects.toThrow(/goes through a link/)
      expect(existsSync(join(elsewhere, 'sub', 'x.clave'))).toBe(false)
      expect(service.list().routines[0].routine.origin).toBe('created')
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('with no registered profile, the move lands in the file the scheduler discovers, never in a new default one (round 6, M2)', async () => {
    const romain = join(root, '.clave', 'workspaces', 'romain.clave')
    mkdirSync(join(root, '.clave', 'workspaces'), { recursive: true })
    mkdirSync(tpl(), { recursive: true })
    writeFileSync(join(tpl(), 'index.html'), INDEX)
    writeFileSync(join(tpl(), 'schema.json'), '{"type":"object"}')
    writeFileSync(
      romain,
      JSON.stringify({
        name: 'G',
        cwd: '.',
        sessions: [],
        terminals: [],
        routines: [routine('Mine')]
      })
    )
    const service = await build(romain, fakeHost(), memory(), {
      defaultTemplate: tpl(),
      workspaces: async () => [{ id: 'ws', name: 'W', rootDir: root, profileFile: null }]
    })
    expect(service.list().routines.map((v) => v.routine.name)).toEqual(['Mine'])
    const a = await service.create(digest({ name: 'Alpha' }))
    const moved = await service.moveToFile(a.routine.key, {})
    expect(moved.file).toBe(romain)
    expect(existsSync(join(root, '.clave', 'workspaces', 'default.clave'))).toBe(false)
    expect(service.list().routines.map((v) => [v.routine.name, v.routine.origin])).toEqual([
      ['Mine', 'file'],
      ['Alpha', 'file']
    ])
  })

  it('one failed refresh does not poison the extra pass: later moves land and answer ok (round 6, M3)', async () => {
    const file = workspace([])
    let fail = false
    const service = await build(file, fakeHost(), memory(), {
      defaultTemplate: tpl(),
      workspaces: async () => {
        if (fail) throw new Error('settings unreadable')
        await new Promise((resolve) => setTimeout(resolve, 10))
        return [{ id: 'ws', name: 'W', rootDir: root, profileFile: file }]
      }
    })
    const a = await service.create(digest({ name: 'Alpha' }))
    const b = await service.create(digest({ name: 'Beta' }))
    fail = true
    const failing = service.refresh()
    const overlapping = service.refresh()
    await expect(failing).rejects.toThrow(/settings unreadable/)
    await expect(overlapping).rejects.toThrow(/settings unreadable/)
    fail = false
    const racing = service.refresh()
    await service.moveToFile(a.routine.key, {})
    await racing
    await service.moveToFile(b.routine.key, {})
    expect(service.list().routines.map((v) => [v.routine.name, v.routine.origin])).toEqual([
      ['Alpha', 'file'],
      ['Beta', 'file']
    ])
  })

  it('many refreshes asked during one cost one more pass, not one each (round 5, L3)', async () => {
    const file = workspace([])
    let reads = 0
    const service = await build(file, fakeHost(), memory(), {
      defaultTemplate: tpl(),
      workspaces: async () => {
        reads++
        await new Promise((resolve) => setTimeout(resolve, 20))
        return [{ id: 'ws', name: 'W', rootDir: root, profileFile: file }]
      }
    })
    const before = reads
    await Promise.all(Array.from({ length: 10 }, () => service.refresh()))
    expect(reads - before).toBe(2)
  })

  it('two creates at once with one name land once (verifier round 2, G2)', async () => {
    const file = workspace([])
    const service = await build(file, fakeHost(), memory(), { defaultTemplate: tpl() })
    const outcomes = await Promise.allSettled([
      service.create(digest({ name: 'Race' })),
      service.create(digest({ name: 'race' }))
    ])
    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(service.list().routines).toHaveLength(1)
  })
})

import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const fixture = vi.hoisted(() => ({
  dir: '',
  runtimeIdentities: new Map<string, { claudeSessionId: string; model: string }>(),
  watcher: null as null | ((event: string, file: string) => void)
}))
vi.mock('electron', () => ({ app: { getPath: () => fixture.dir } }))
vi.mock('./ipc', () => ({ registerSessionIpc: vi.fn() }))
vi.mock('fs', async (original) => ({
  ...(await original<typeof import('fs')>()),
  watch: vi.fn((_dir, callback) => {
    fixture.watcher = callback
    return { close: vi.fn() }
  })
}))
vi.mock('../pty-manager', () => ({
  ptyManager: {
    getSession: (id: string) =>
      fixture.runtimeIdentities.get(id) ?? { claudeSessionId: 'conversation', model: 'opus' }
  }
}))
import { writeFileSync } from 'fs'
import { sessionManager } from './session-manager'
import { EchoAdapter } from './adapters/echo-adapter'
import { CaptureStore } from '../exchange-capture/store'
import {
  captureMessage,
  captureTabSpawn,
  captureSessionState,
  captureTabClosed
} from '../exchange-capture/service'
import { startWatching, stateFilePath } from '../agent-state-manager'
import type { SessionState, EndpointIdentity, CaptureEvent } from '../exchange-capture/types'
fixture.dir = mkdtempSync(join(tmpdir(), 'clave-2527-capture-'))
afterEach(() => {
  for (const session of sessionManager.list()) sessionManager.forget(session.id)
  fixture.runtimeIdentities.clear()
})
process.on('exit', () => rmSync(fixture.dir, { recursive: true, force: true }))
let n = 0
function adopt(
  provider = 'claude',
  id = `capture-${++n}`,
  transport: 'pty' | 'events' = 'events'
): string {
  const adapter = new EchoAdapter()
  Object.defineProperty(adapter, 'transports', { value: ['pty', 'events'] })
  const session = {
    id,
    provider,
    transport,
    cwd: '/project',
    windowKey: 'window',
    state: 'idle' as const,
    createdAt: Date.now(),
    adapterId: 'echo',
    title: 'Agent'
  }
  sessionManager.adopt(session, adapter.prepare(session), adapter)
  return id
}
function endpoint(id: string): EndpointIdentity {
  return {
    sessionId: id,
    name: 'Renamed',
    mode: 'claude' as const,
    cwd: '/project',
    claudeSessionId: 'conversation',
    groupId: 'group',
    groupName: 'Group'
  }
}
function report(id: string, state: SessionState, previous: SessionState | null = null): void {
  captureSessionState({
    ts: new Date().toISOString(),
    session: endpoint(id),
    state,
    previous,
    source: state === 'exited' ? 'pty' : 'hooks'
  })
}
function events(
  id: string
): (CaptureEvent & { session: EndpointIdentity; state?: SessionState })[] {
  return readFileSync(join(fixture.dir, 'exchange-capture/events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((e) => e.session?.sessionId === id)
}

it.each(['stale', null] as const)(
  'persists runtime identity at every events capture entry point with %s renderer identity',
  (rendererIdentity) => {
    const senderId = adopt()
    const targetId = adopt()
    const senderRuntime = { claudeSessionId: `runtime-${senderId}`, model: 'runtime-sender-model' }
    const targetRuntime = { claudeSessionId: `runtime-${targetId}`, model: 'runtime-target-model' }
    fixture.runtimeIdentities.set(senderId, senderRuntime)
    fixture.runtimeIdentities.set(targetId, targetRuntime)
    const sender = {
      ...endpoint(senderId),
      claudeSessionId: rendererIdentity,
      model: rendererIdentity
    }
    const target = {
      ...endpoint(targetId),
      claudeSessionId: rendererIdentity,
      model: rendererIdentity
    }
    const ts = new Date().toISOString()
    captureMessage({ ts, sender, target, text: 'hello', provenance: 'test', delivered: true })
    captureTabSpawn({ ts, spawner: sender, session: target, prompt: null, model: null })
    captureSessionState({ ts, session: target, state: 'working', previous: null, source: 'hooks' })
    captureTabClosed({ ts, session: target, by: 'user', closer: null })

    // Assert the durable record: a renderer payload alone cannot prove that
    // either identity field survives each capture entry point.
    const written: CaptureEvent[] = readFileSync(
      join(fixture.dir, 'exchange-capture/events.jsonl'),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const message = written.find(
      (event) => event.kind === 'message' && event.sender.sessionId === senderId
    )
    expect(message).toMatchObject({
      kind: 'message',
      sender: { ...sender, ...senderRuntime },
      target: { ...target, ...targetRuntime }
    })
    const sessionEvents = events(targetId)
    expect(sessionEvents.map((event) => event.kind)).toEqual([
      'tab_spawn',
      'session_state',
      'tab_closed'
    ])
    for (const event of sessionEvents) {
      expect(event.session).toEqual({ ...target, ...targetRuntime })
    }
    expect(sender.claudeSessionId).toBe(rendererIdentity)
    expect(sender.model).toBe(rendererIdentity)
    expect(target.claudeSessionId).toBe(rendererIdentity)
    expect(target.model).toBe(rendererIdentity)
  }
)
it('writes immediately, enriches from the last report, and preserves renderer-only transitions', () => {
  const id = adopt()
  sessionManager.setState(id, 'working')
  expect(events(id).map((e) => e.state)).toEqual(['working'])
  report(id, 'working')
  expect(events(id)).toHaveLength(1)
  sessionManager.setState(id, 'blocked')
  expect(events(id)[1].session).toMatchObject({ groupName: 'Group', model: 'opus' })
  report(id, 'blocked', 'working')
  report(id, 'idle', 'blocked')
  expect(events(id).map((e) => e.state)).toEqual(['working', 'blocked', 'idle'])
  sessionManager.kill(id)
  sessionManager.forget(id)
  report(id, 'exited', 'idle')
  expect(events(id).map((e) => e.state)).toEqual(['working', 'blocked', 'idle', 'exited'])
})
it('prunes identity, mapped state and acknowledgements independently on exit, close and removal', () => {
  for (const close of ['exit', 'close', 'remove']) {
    const id = adopt()
    sessionManager.setState(id, 'working')
    report(id, 'working')
    sessionManager.setState(id, 'blocked')
    if (close === 'close')
      captureTabClosed({
        ts: new Date().toISOString(),
        session: endpoint(id),
        by: 'user',
        closer: null
      })
    else if (close === 'exit') sessionManager.setState(id, 'ended')
    if (close === 'remove') {
      sessionManager.forget(id)
      adopt('claude', id)
    }
    // Starting another transition exposes stale caches without test-only APIs.
    // Exit/close are checked before forget(), so removal cannot mask a leak.
    sessionManager.setState(id, 'working')
    const last = events(id).at(-1)
    expect(last).toMatchObject({ state: 'working', previous: null, session: { groupName: null } })
    report(id, 'working')
    report(id, 'blocked', 'working')
    expect(events(id).at(-1)?.state).toBe('blocked')
  }
})
it('hook watcher drives the manager and a synchronous capture line for Claude; Pi keeps its contract exclusion', () => {
  startWatching(vi.fn())
  for (const provider of ['claude', 'pi']) {
    const id = adopt(provider, `hook-${++n}`, 'pty')
    const observed = vi.fn()
    sessionManager.subscribe(id, observed)
    writeFileSync(stateFilePath(id), 'working')
    fixture.watcher!('change', `${id}.state`)
    expect(sessionManager.get(id)?.state).toBe('working')
    expect(observed).toHaveBeenCalledWith({
      kind: 'event',
      event: { type: 'state_change', state: 'working' }
    })
    if (provider === 'claude')
      expect(events(id)).toMatchObject([
        { kind: 'session_state', state: 'working', source: 'hooks' }
      ])
    else expect(events(id)).toEqual([])
  }
})

it('matches the codex-glow capture from base 08ccc92, including both exits and append order', () => {
  const base = readFileSync(join(import.meta.dirname, 'fixtures/codex-glow-08ccc92.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const ids = new Map<string, string>()
  for (const line of base) {
    if (!ids.has(line.session.sessionId)) ids.set(line.session.sessionId, adopt('codex'))
    const id = ids.get(line.session.sessionId)!
    const payload = {
      ...line,
      ts: new Date().toISOString(),
      session: { ...line.session, sessionId: id }
    }
    if (line.kind === 'session_state') {
      // Plain PTY reaches the manager; tmux pane exit can be renderer-only.
      if (line.session.name === 'Codex plain PTY') sessionManager.setState(id, 'ended')
      captureSessionState(payload)
    } else {
      captureTabClosed(payload)
      sessionManager.kill(id)
      sessionManager.forget(id)
    }
  }
  const actual = [...ids.values()].flatMap((id) => events(id))
  expect(actual.map((e) => [e.kind, e.state])).toEqual(base.map((e) => [e.kind, e.state]))
  for (const id of ids.values()) {
    expect(events(id)).toHaveLength(2)
    expect(events(id).filter((e) => e.state === 'exited')).toHaveLength(1)
  }
  expect(actual.map((e) => e.ts)).toEqual(actual.map((e) => e.ts).sort())
})

it('deduplicates repeated exits without reading the append-only log', () => {
  const readAll = vi.spyOn(CaptureStore.prototype, 'readAll')
  try {
    for (const managerFirst of [false, true]) {
      const id = adopt()
      if (managerFirst) sessionManager.setState(id, 'ended')
      else report(id, 'exited')
      const first = events(id)
      report(id, 'exited')
      report(id, 'exited')
      expect(events(id)).toEqual(first)
      expect(first).toHaveLength(1)
      sessionManager.forget(id)
      report(id, 'exited')
      expect(events(id)).toEqual(first)
      adopt('claude', id)
      report(id, 'exited')
      expect(events(id)).toHaveLength(2)
    }
    expect(readAll).not.toHaveBeenCalled()
  } finally {
    readAll.mockRestore()
  }
})

it('ignores hook-file state for events sessions so it cannot overwrite stream state', () => {
  const onHook = vi.fn()
  startWatching(onHook)
  const id = adopt()
  sessionManager.setState(id, 'blocked')
  writeFileSync(stateFilePath(id), 'idle')
  fixture.watcher!('change', `${id}.state`)
  expect(sessionManager.get(id)?.state).toBe('blocked')
  expect(events(id).map((event) => event.state)).toEqual(['blocked'])
  expect(onHook).not.toHaveBeenCalled()
})

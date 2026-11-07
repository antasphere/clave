import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionHost } from '@clave/server'
import { expect, it } from 'vitest'
import type { Session, SessionStream } from '../../../shared/session-model'
import { standaloneSidebar } from '../../server/standalone-sidebar'
import { SessionManager } from '../session-manager'
import { serverOwnedSessionHost } from '../server-owned-host'
import { EchoAdapter } from './echo-adapter'

const session: Session = {
  id: 'echo-history',
  provider: 'echo',
  adapterId: 'echo',
  transport: 'events',
  cwd: '/tmp',
  windowKey: 'server',
  state: 'idle',
  createdAt: 1,
  title: 'Echo'
}
const missed: SessionStream = {
  kind: 'event',
  event: { type: 'assistant_text', delta: 'owner reply while disconnected', final: true }
}

it('owning history includes injected offline turns after a prior write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clave-echo-history-'))
  const manager = new SessionManager()
  const adapter = new EchoAdapter()
  manager.registerAdapter(adapter)
  manager.adopt(session, adapter.prepare(session), adapter)
  const owned = serverOwnedSessionHost({
    host: {
      ...SessionHost.none,
      list: () => manager.list(),
      get: (id) => manager.get(id),
      listAdoptableRecords: () => [],
      history: (id, before, limit) => manager.history(id, before, limit)
    },
    dataDir: dir,
    sidebar: standaloneSidebar(dir),
    subscribeAll: (listener) => manager.subscribeAll(listener),
    ready: (id) => manager.ready(id)
  })
  try {
    manager.write(session.id, { type: 'user_message', text: 'initial live turn' })
    const user: SessionStream = {
      kind: 'event',
      event: { type: 'user_message', text: 'missed while disconnected' }
    }
    adapter.inject(session.id, user)
    adapter.inject(session.id, missed)
    expect(readFileSync(join(dir, 'server-history', `${session.id}.json`), 'utf8')).toContain(
      'owner reply while disconnected'
    )
    expect(
      owned.host
        .history(session.id)
        .items.slice(-2)
        .map((item) => item.event)
    ).toEqual([user.event, missed.event])
  } finally {
    owned.close()
    manager.kill(session.id)
    rmSync(dir, { recursive: true, force: true })
  }
})

it('first injected frame is live once and repeated identical frames remain in history', () => {
  const adapter = new EchoAdapter()
  const handle = adapter.prepare(session)
  const prefixes: unknown[][] = []
  const live: SessionStream[] = []
  adapter.on(handle, 'stream', (stream) => {
    prefixes.push(adapter.history(handle).map((item) => item.event))
    live.push(stream)
  })
  adapter.inject(session.id, missed)
  adapter.inject(session.id, missed)
  expect(prefixes).toEqual([[], [missed.event]])
  expect(live).toEqual([missed, missed])
  expect(adapter.history(handle).map((item) => item.event)).toEqual([missed.event, missed.event])
  adapter.kill(handle)
})

it('history keeps emitted order when an injected frame triggers a reentrant write', () => {
  const adapter = new EchoAdapter()
  const handle = adapter.prepare(session)
  const live: SessionStream[] = []
  adapter.on(handle, 'stream', (stream) => {
    live.push(stream)
    if (stream === missed)
      adapter.write(handle, { type: 'user_message', text: 'reentrant desktop write' })
  })
  adapter.inject(session.id, missed)
  expect(adapter.history(handle).map((item) => item.event)).toEqual(
    live.flatMap((stream) => (stream.kind === 'event' ? [stream.event] : []))
  )
  adapter.kill(handle)
})

it('raw and transient frames stay live without becoming transcript history', () => {
  const adapter = new EchoAdapter()
  const handle = adapter.prepare(session)
  const live: SessionStream[] = []
  adapter.on(handle, 'stream', (stream) => live.push(stream))
  const frames: SessionStream[] = [
    { kind: 'pty', data: new Uint8Array([1]) },
    { kind: 'event', event: { type: 'provider_event', provider: 'echo', payload: {} } },
    { kind: 'event', event: { type: 'state_change', state: 'working' } },
    { kind: 'event', event: { type: 'background_tasks', tasks: [] } }
  ]
  frames.forEach((stream) => adapter.inject(session.id, stream))
  expect(live).toEqual(frames)
  expect(adapter.history(handle)).toEqual([])
  adapter.kill(handle)
})

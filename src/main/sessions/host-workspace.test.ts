import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, SessionRecord } from '@clave/contract/sessions'
import { EchoAdapter } from './adapters/echo-adapter'
import { SessionManager, sessionManager } from './session-manager'
import { serverOwnedSessionHost } from './server-owned-host'
import { standaloneSidebar } from '../server/standalone-sidebar'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect, Layer } from 'effect'
import { run, type FixtureError, type RunReport } from '@structure-ai/fixtures'
import { InMemoryAll } from '@structure-ai/eventsourcing'
import { CommandBus, HandlerRegistry, layer as buses } from '@structure-ai/cqrs'
import { SessionHost } from '../../../packages/server/src/sessions/port'
import {
  SessionWrites,
  WriteLedger,
  fileWriteLedgerStorage
} from '../../../packages/server/src/sessions/writes'
import { sessionHandlers } from '../../../packages/server/src/sessions/handlers'
import { ServerEvents } from '../../../packages/server/src/events'
import { writeFixtureCatalog } from '../../../packages/server/src/sessions/writes.fixtures'

const mocks = vi.hoisted(() => ({
  getSessionRecord: vi.fn(),
  setSessionDisplayName: vi.fn()
}))
vi.mock('electron', () => {
  throw new Error('the host imported electron')
})
vi.mock('../pty-manager', () => ({
  ptyManager: {
    getSessionRecord: mocks.getSessionRecord,
    getSession: () => ({ folderName: 'repo' }),
    setSessionDisplayName: mocks.setSessionDisplayName
  }
}))
vi.mock('./lifecycle', () => ({
  readScreen: vi.fn(),
  restartSession: vi.fn(),
  typeIntoSession: vi.fn(),
  resizeSession: vi.fn(),
  spawnSession: vi.fn(),
  stopSession: vi.fn(),
  writeTerminal: vi.fn()
}))
vi.mock('../title-generator', () => ({ notifyChatMessage: vi.fn() }))
vi.mock('./attachments', () => ({ preparePrompt: vi.fn() }))
vi.mock('./chat-model-default', () => ({ rememberChatEffort: vi.fn(), rememberChatModel: vi.fn() }))
vi.mock('./chat-view-default', () => ({ rememberChatView: vi.fn() }))
vi.mock('./records', () => ({ sessionRecords: {} }))
import { createSessionHost, getSessionHost, setSessionHost } from './host'

const session = (id: string): Session => ({
  id,
  provider: 'echo',
  adapterId: 'echo',
  transport: 'events',
  cwd: '/same/repo',
  windowKey: 'window',
  groupId: 'group',
  viewId: 'chat/view',
  title: `Title ${id}`,
  createdAt: 123,
  state: 'idle'
})
const record = (id: string, workspaceId?: string): SessionRecord => ({
  id,
  cwd: '/same/repo',
  folderName: 'repo',
  claudeMode: false,
  antigravityMode: false,
  codexMode: false,
  piMode: false,
  claudeAgentsMode: false,
  dangerousMode: false,
  configDir: '/private/config',
  codexAccountId: 'private-account',
  codexThreadId: 'private-thread',
  view: { url: 'https://private.example', title: 'Private' },
  ...(workspaceId !== undefined && { workspaceId })
})
const lifecycle = (): Parameters<typeof createSessionHost>[0]['lifecycle'] => ({
  spawn: vi.fn(),
  stop: vi.fn(),
  resize: vi.fn(),
  writeTerminal: vi.fn()
})

function fixture(): {
  manager: SessionManager
  adapter: EchoAdapter
  records: Map<string, SessionRecord>
  workspaceIdOf: ReturnType<typeof vi.fn<(id: string) => string | undefined>>
  listAdoptableRecords: ReturnType<typeof vi.fn<() => SessionRecord[]>>
  host: ReturnType<typeof createSessionHost>
} {
  const manager = new SessionManager()
  const adapter = new EchoAdapter()
  for (const id of ['one', 'two']) manager.adopt(session(id), adapter.prepare(session(id)), adapter)
  const records = new Map([
    ['one', record('one', 'workspace-one')],
    ['two', record('two', 'workspace-two')]
  ])
  const listAdoptableRecords = vi.fn(() => [] as SessionRecord[])
  const workspaceIdOf = vi.fn((id: string) => records.get(id)?.workspaceId)
  const host = createSessionHost({
    manager,
    lifecycle: lifecycle(),
    workspaceIdOf,
    records: { listAdoptableRecords, discardRecord: vi.fn(), release: vi.fn() }
  })
  return { manager, adapter, records, workspaceIdOf, listAdoptableRecords, host }
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  setSessionHost(null)
  for (const value of sessionManager.list()) sessionManager.forget(value.id)
  vi.restoreAllMocks()
})

describe('current workspace stamps on live sessions', () => {
  it('reads exact IDs even for unlisted records at the same cwd, and selects only workspaceId', () => {
    const f = fixture()
    expect(f.host.get('one')).toEqual({ ...session('one'), workspaceId: 'workspace-one' })
    expect(f.host.list('window')).toEqual([
      { ...session('one'), workspaceId: 'workspace-one' },
      { ...session('two'), workspaceId: 'workspace-two' }
    ])
    expect(f.host.list('other-window')).toEqual([])
    expect(f.host.get('missing')).toBeUndefined()
    expect(f.workspaceIdOf.mock.calls.map(([id]) => id)).toEqual(['one', 'one', 'two'])
    expect(f.listAdoptableRecords).not.toHaveBeenCalled()
    expect(f.manager.get('one')).toEqual(session('one'))
  })

  it('overrides stale snapshots per read and removes the field after move, clear or record loss', () => {
    const f = fixture()
    const get = f.manager.get.bind(f.manager)
    const list = f.manager.list.bind(f.manager)
    vi.spyOn(f.manager, 'get').mockImplementation((id) => {
      const value = get(id)
      return value && { ...value, workspaceId: 'stale-snapshot' }
    })
    vi.spyOn(f.manager, 'list').mockImplementation((window) =>
      list(window).map((value) => ({ ...value, workspaceId: 'stale-snapshot' }))
    )
    expect(f.host.get('one')?.workspaceId).toBe('workspace-one')
    f.records.set('one', record('one', 'moved'))
    expect(f.host.get('one')?.workspaceId).toBe('moved')
    expect(f.host.list()[0].workspaceId).toBe('moved')
    f.records.set('one', record('one'))
    expect(f.host.get('one')).toEqual(session('one'))
    expect(f.host.list()[0]).not.toHaveProperty('workspaceId')
    f.records.delete('one')
    expect(f.host.get('one')).toEqual(session('one'))
    expect(f.host.list()[0]).not.toHaveProperty('workspaceId')
    expect(f.manager.get('one')?.workspaceId).toBe('stale-snapshot')
  })

  it('keeps plain reads available without records or a workspace source, without consulting disk', () => {
    const f = fixture()
    const snapshot = { ...session('one'), workspaceId: 'stale-snapshot' }
    vi.spyOn(f.manager, 'get').mockReturnValue(snapshot)
    vi.spyOn(f.manager, 'list').mockReturnValue([snapshot])
    const host = createSessionHost({ manager: f.manager, lifecycle: lifecycle() })
    expect(host.get('one')).toEqual(session('one'))
    expect(host.list()).toEqual([session('one')])
    expect(host.history('one')).toEqual({ items: [], before: null })
    expect(host.timeline?.('one').items).toEqual([])
    expect(() => host.listAdoptableRecords()).toThrow('no session records')
    expect(mocks.getSessionRecord).not.toHaveBeenCalled()
    expect(snapshot.workspaceId).toBe('stale-snapshot')
  })

  it('applies the same current projection to view and rename responses', () => {
    const f = fixture()
    expect(f.host.setView('one', 'other/view')).toEqual({
      ...session('one'),
      viewId: 'other/view',
      workspaceId: 'workspace-one'
    })
    f.records.set('one', record('one', 'moved'))
    expect(f.host.rename('one', 'Renamed').workspaceId).toBe('moved')
    f.records.delete('one')
    expect(f.host.setView('one', null)).not.toHaveProperty('workspaceId')
    expect(f.host.rename('one', 'Renamed')).not.toHaveProperty('workspaceId')
  })

  it('preserves the empty opaque string allowed by both public session schemas', () => {
    const f = fixture()
    f.records.set('one', record('one', ''))
    expect(f.host.get('one')?.workspaceId).toBe('')
    expect(f.host.list()[0].workspaceId).toBe('')
  })

  it('does not ready a provider or seed, change or reset history/timeline while projecting metadata', () => {
    const f = fixture()
    const history = vi.spyOn(f.adapter, 'history')
    const ready = vi.spyOn(f.adapter, 'ready')
    const write = vi.spyOn(f.adapter, 'write')
    const attach = vi.spyOn(f.adapter, 'attach')
    const adopt = vi.spyOn(f.manager, 'adopt')
    const streams: unknown[] = []
    f.manager.subscribe('one', (value) => streams.push(value))
    f.host.get('one')
    f.host.list()
    expect(history).not.toHaveBeenCalled()
    f.adapter.inject('one', {
      kind: 'event',
      event: { type: 'assistant_text', delta: 'same', final: true }
    })
    const legacy = f.host.history('one')
    const timeline = f.host.timeline?.('one')
    const count = streams.length
    history.mockClear()
    for (const stamp of ['moved', undefined]) {
      f.records.set('one', record('one', stamp))
      f.host.get('one')
      f.host.list()
    }
    expect(history).not.toHaveBeenCalled()
    expect(f.host.history('one')).toEqual(legacy)
    expect(f.host.timeline?.('one')).toEqual(timeline)
    expect(streams).toHaveLength(count)
    for (const effect of [ready, write, attach, adopt]) expect(effect).not.toHaveBeenCalled()
  })

  it('wires the real host to exact current PTY records on every get/list read', () => {
    const adapter = new EchoAdapter()
    sessionManager.adopt(session('app-session'), adapter.prepare(session('app-session')), adapter)
    mocks.getSessionRecord.mockReturnValue(record('app-session', 'first'))
    const host = getSessionHost()
    expect(host.get('app-session')?.workspaceId).toBe('first')
    mocks.getSessionRecord.mockReturnValue(record('app-session', 'moved'))
    expect(host.list()[0].workspaceId).toBe('moved')
    mocks.getSessionRecord.mockReturnValue(null)
    expect(host.get('app-session')).not.toHaveProperty('workspaceId')
    expect(mocks.getSessionRecord.mock.calls).toEqual([
      ['app-session'],
      ['app-session'],
      ['app-session']
    ])
  })

  it('preserves live and stopped history/timeline pages through the server-owned composition', () => {
    const f = fixture()
    const stopped = { ...record('stopped', 'stopped-workspace') }
    f.listAdoptableRecords.mockReturnValue([stopped])
    const dataDir = mkdtempSync(join(tmpdir(), 'clave-workspace-host-'))
    const ready = vi.fn()
    const owned = serverOwnedSessionHost({
      host: f.host,
      dataDir,
      sidebar: standaloneSidebar(dataDir),
      ready,
      subscribeAll: (listener) => f.manager.subscribeAll(listener)
    })
    try {
      f.adapter.inject('one', {
        kind: 'event',
        event: { type: 'assistant_text', delta: 'kept', final: true }
      })
      const before = ['one', 'stopped'].map((id) => ({
        history: owned.host.history(id),
        timeline: owned.host.timeline?.(id)
      }))
      expect(owned.host.list().map(({ id, workspaceId }) => [id, workspaceId])).toEqual([
        ['one', 'workspace-one'],
        ['two', 'workspace-two'],
        ['stopped', 'stopped-workspace']
      ])
      expect(owned.host.get('stopped')?.workspaceId).toBe('stopped-workspace')
      delete stopped.workspaceId
      expect(owned.host.get('stopped')).not.toHaveProperty('workspaceId')
      expect(owned.host.list()[2]).not.toHaveProperty('workspaceId')
      expect(
        ['one', 'stopped'].map((id) => ({
          history: owned.host.history(id),
          timeline: owned.host.timeline?.(id)
        }))
      ).toEqual(before)
      expect(ready).not.toHaveBeenCalled()
    } finally {
      owned.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('keeps the current stamp when the write-once fixture dispatches through application commands', async () => {
    const f = fixture()
    const dataDir = mkdtempSync(join(tmpdir(), 'clave-workspace-fixture-'))
    try {
      const storage = fileWriteLedgerStorage(join(dataDir, 'writes'))
      new WriteLedger(storage).initialize('one')
      const fixtures = await Effect.runPromise(
        writeFixtureCatalog.prepare('mobile-notify/write-once', { sessionId: 'one' })
      )
      const layer = buses.pipe(
        Layer.provide(HandlerRegistry.layer(...sessionHandlers)),
        Layer.provide(SessionHost.layer(f.host)),
        Layer.provide(SessionWrites.layer(storage)),
        Layer.provide(ServerEvents.layer('workspace-fixture').pipe(Layer.provide(InMemoryAll)))
      )
      const report = await Effect.runPromise(
        (
          run({ fixtures, enabled: true, ready: () => Effect.void }) as Effect.Effect<
            RunReport<Readonly<Record<string, unknown>>>,
            FixtureError,
            CommandBus
          >
        ).pipe(Effect.provide(layer))
      )
      expect(report.completed).toEqual(['mobile-notify/write'])
      const write = report.values.write as { first: unknown; second: unknown }
      expect(write.second).toEqual(write.first)
      expect(f.host.get('one')).toMatchObject({ id: 'one', workspaceId: 'workspace-one' })
      expect(
        f.host.history('one').items.filter(({ event }) => event.type === 'user_message')
      ).toHaveLength(1)
      f.records.set('one', record('one', 'moved-after-write'))
      expect(f.host.list()[0].workspaceId).toBe('moved-after-write')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

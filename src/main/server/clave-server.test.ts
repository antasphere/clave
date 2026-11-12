import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient, PushClient, type PushSocketConstructor } from '@clave/client'
// The host's neighbours that reach the PTY backend and Electron: nothing here
// names a tab or looks a window up.
vi.mock('../title-generator', () => ({ notifyChatMessage: vi.fn() }))
vi.mock('../sessions/lifecycle', () => ({
  spawnSession: vi.fn(),
  stopSession: vi.fn(),
  resizeSession: vi.fn(),
  writeTerminal: vi.fn(),
  trackInput: vi.fn()
}))
import { WebSocket } from 'ws'
import type { Session } from '../../shared/session-model'
import { SessionManager } from '../sessions/session-manager'
import { EchoAdapter } from '../sessions/adapters/echo-adapter'
import { createSessionHost, type SessionLifecycle } from '../sessions/host'
import { getClaveServerEndpoint, startClaveServer, stopClaveServer } from './clave-server'
import { hasServerEventPublisher } from './session-events'

const Socket = WebSocket as unknown as PushSocketConstructor
const record = (id: string, windowKey = 'w1'): Session => ({
  id,
  provider: 'echo',
  transport: 'events' as const,
  cwd: '/project',
  windowKey,
  state: 'idle' as const,
  createdAt: 1,
  adapterId: 'echo',
  title: id
})
const lifecycle: SessionLifecycle = {
  spawn: async (_windowKey, cwd) => ({
    id: 'spawned',
    cwd,
    folderName: cwd.split('/').pop() ?? cwd,
    alive: true,
    claudeSessionId: null,
    piSessionId: null
  }),
  stop: async () => {},
  resize: () => {},
  writeTerminal: () => {}
}
const hostOver = (manager: SessionManager): ReturnType<typeof createSessionHost> =>
  createSessionHost({ manager, lifecycle })

afterEach(async () => {
  await stopClaveServer()
})

describe('the server started by the shell', () => {
  it('publishes its address over the endpoint, once, and never into the environment', async () => {
    const manager = new SessionManager()
    const before = { ...process.env }
    const options = { manager, ports: { sessions: hostOver(manager) } }
    const first = await startClaveServer(options)
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(getClaveServerEndpoint()).toEqual(first)
    expect(process.env.CLAVE_SERVER_URL).toBe(before.CLAVE_SERVER_URL)
    expect(process.env.CLAVE_SERVER_TOKEN).toBe(before.CLAVE_SERVER_TOKEN)
    expect(await startClaveServer(options)).toEqual(first)
    await stopClaveServer()
    expect(getClaveServerEndpoint()).toBeNull()
  })
  it('two concurrent starts share one server', async () => {
    const manager = new SessionManager()
    const options = { manager, ports: { sessions: hostOver(manager) } }
    const [a, b] = await Promise.all([startClaveServer(options), startClaveServer(options)])
    expect(a).toEqual(b)
    expect(getClaveServerEndpoint()).toEqual(a)
    await stopClaveServer()
    // Nothing listens there any more: the one server stopped is the one started.
    await expect(fetch(`${a.url}/health/live`)).rejects.toThrow()
  })
  it('a stop during a start in flight leaves nothing listening', async () => {
    const manager = new SessionManager()
    const starting = startClaveServer({ manager, ports: { sessions: hostOver(manager) } })
    await stopClaveServer()
    const started = await starting
    expect(getClaveServerEndpoint()).toBeNull()
    await expect(fetch(`${started.url}/health/live`)).rejects.toThrow()
  })
  it('stopping removes the listener it put on the manager, and the event publisher', async () => {
    const manager = new SessionManager()
    const listeners = (): number => (manager as unknown as { all: Set<unknown> }).all.size
    const idle = listeners()
    expect(hasServerEventPublisher()).toBe(false)
    await startClaveServer({ manager, ports: { sessions: hostOver(manager) } })
    // Two listeners on the manager's stream: the state publisher, and the
    // notifier's observation (the mobile wave, lane B); the stop takes both off.
    expect(listeners()).toBe(idle + 2)
    expect(hasServerEventPublisher()).toBe(true)
    await stopClaveServer()
    expect(listeners()).toBe(idle)
    expect(hasServerEventPublisher()).toBe(false)
  })
  it('answers the manager’s sessions over HTTP and their state changes over the push channel', async () => {
    const manager = new SessionManager()
    const adapter = new EchoAdapter()
    manager.registerAdapter(adapter)
    manager.adopt(record('a'), adapter.prepare(record('a')), adapter)
    const endpoint = await startClaveServer({ manager, ports: { sessions: hostOver(manager) } })
    const api = createApiClient(endpoint)
    expect((await api.sessions.list()).map((s) => s.id)).toEqual(['a'])
    const push = new PushClient({ ...endpoint, WebSocket: Socket }).connect()
    await push.whenOpen()
    const states: string[] = []
    const streamed: string[] = []
    push.onEvent((envelope) => {
      if (envelope.event._tag === 'session.state_changed') states.push(envelope.event.state)
    })
    push.subscribe('a', (stream) => {
      if (stream.kind === 'event') streamed.push(stream.event.type)
    })
    const subscribed = await push.subscribed('a')
    expect(subscribed.id).toBe('a')
    await api.sessions.write('a', { type: 'user_message', text: 'hello' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(states).toEqual(['working', 'done'])
    expect(streamed).toContain('assistant_text')
    push.close()
    await api.dispose()
    manager.kill('a')
  })
  it('starts and stops a session through the host it was given', async () => {
    const manager = new SessionManager()
    const stopped: string[] = []
    const host = createSessionHost({
      manager,
      lifecycle: {
        ...lifecycle,
        stop: async (id) => {
          stopped.push(id)
        }
      }
    })
    const endpoint = await startClaveServer({ manager, ports: { sessions: host } })
    const api = createApiClient(endpoint)
    const info = await api.sessions.start({ cwd: '/work/app', windowKey: 'w1' })
    expect(info).toMatchObject({ id: 'spawned', cwd: '/work/app', folderName: 'app', alive: true })
    await api.sessions.stop('spawned')
    expect(stopped).toEqual(['spawned'])
    await api.dispose()
  })
  it('hands a terminal’s size and its bytes to the lifecycle, where the journal and the /clear watch are', async () => {
    const manager = new SessionManager()
    const adapter = new EchoAdapter()
    manager.adopt(record('t1'), adapter.prepare({ id: 't1' } as never), adapter)
    const resized: Array<[string, number, number]> = []
    const written: Array<[string, string]> = []
    const host = createSessionHost({
      manager,
      lifecycle: {
        ...lifecycle,
        resize: (id, cols, rows) => {
          resized.push([id, cols, rows])
        },
        writeTerminal: (id, text) => {
          written.push([id, text])
        }
      }
    })
    const endpoint = await startClaveServer({ manager, ports: { sessions: host } })
    const api = createApiClient(endpoint)
    await api.sessions.resize('t1', 120, 40)
    await api.sessions.write('t1', { type: 'bytes', data: new TextEncoder().encode('ls -la\r') })
    expect(resized).toEqual([['t1', 120, 40]])
    expect(written).toEqual([['t1', 'ls -la\r']])
    await api.dispose()
    manager.kill('t1')
  })
})

describe('the version the in-process server reports (issue #266, V1-F6)', () => {
  it("answers the app's version and that it updates with the app, and names it in the welcome", async () => {
    const manager = new SessionManager()
    const endpoint = await startClaveServer({
      manager,
      ports: { sessions: hostOver(manager) },
      appVersion: '3.0.0-beta.9'
    })
    const api = createApiClient({ url: endpoint.url, token: endpoint.token })
    try {
      expect(await api.server.info()).toEqual({
        version: '3.0.0-beta.9',
        installRef: null,
        // The server's own name (PRDCT-4149): this machine's, whatever it is.
        name: expect.any(String),
        upgrade: {
          supported: false,
          reason: 'This server is run by the app; it updates with it',
          state: 'idle'
        }
      })
    } finally {
      await api.dispose()
    }
    const ws = new WebSocket(endpoint.url.replace('http', 'ws') + '/push')
    const welcome = await new Promise<unknown>((resolve, reject) => {
      ws.once('open', () => ws.send(JSON.stringify({ _tag: 'hello', token: endpoint.token })))
      ws.once('message', (data) => resolve(JSON.parse(data.toString())))
      ws.once('error', reject)
    })
    ws.close()
    expect(welcome).toMatchObject({ _tag: 'welcome', version: '3.0.0-beta.9' })
  })
})

describe('this Mac’s own name as a server (PRDCT-4241, verifier round 2 N10)', () => {
  it('is read from its store, set from Settings, and tells its listeners', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { configureOwnServerName, onOwnServerNameChanged, ownServerName, setOwnServerName } =
      await import('./clave-server')
    const dir = mkdtempSync(join(tmpdir(), 'own-name-'))
    const previous = process.env.CLAVE_SERVER_NAME
    process.env.CLAVE_SERVER_NAME = 'seeded'
    try {
      configureOwnServerName(dir)
      expect(ownServerName()).toBe('seeded')
      const heard: string[] = []
      const off = onOwnServerNameChanged((name) => heard.push(name))
      expect(setOwnServerName(' Studio ')).toBe('Studio')
      expect(ownServerName()).toBe('Studio')
      expect(heard).toEqual(['Studio'])
      off()
      setOwnServerName('Other')
      expect(heard).toEqual(['Studio'])
      expect(() => setOwnServerName('every')).toThrow()
    } finally {
      if (previous === undefined) delete process.env.CLAVE_SERVER_NAME
      else process.env.CLAVE_SERVER_NAME = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the write ledger’s first activation in the shell (PRDCT-4448)', () => {
  it('seeds the sessions its records name, read without pruning, and reads them at the first activation alone', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'clave-ledger-first-'))
    const manager = new SessionManager()
    const adapter = new EchoAdapter()
    manager.registerAdapter(adapter)
    manager.adopt(record('live-1'), adapter.prepare(record('live-1')), adapter)
    // The adoptable listing prunes what it cannot bring back: the first activation never
    // asks it. The read-only inventory names the records instead.
    const listAdoptableRecords = vi.fn(() => [])
    const records = { listAdoptableRecords, discardRecord: vi.fn(), release: vi.fn() }
    const recordedSessionIds = vi.fn(() => ['recorded-1'])
    const options = {
      manager,
      ports: { sessions: createSessionHost({ manager, lifecycle, records }) },
      dataDir: dir,
      recordedSessionIds
    }
    try {
      await startClaveServer(options)
      expect(listAdoptableRecords).not.toHaveBeenCalled()
      expect(recordedSessionIds).toHaveBeenCalledTimes(1)
      for (const id of ['live-1', 'recorded-1'])
        expect(
          JSON.parse(readFileSync(join(dir, 'write-ledger', `${id}.ledger.json`), 'utf8'))
        ).toMatchObject({ complete: true })
      await stopClaveServer()
      // A later boot: the activation is behind it, and nothing is read for it again.
      await startClaveServer(options)
      expect(recordedSessionIds).toHaveBeenCalledTimes(1)
      expect(listAdoptableRecords).not.toHaveBeenCalled()
    } finally {
      await stopClaveServer()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the app’s own records for it by default, and prunes none of them', async () => {
    const {
      mkdirSync,
      mkdtempSync,
      readFileSync,
      readdirSync,
      realpathSync,
      rmSync,
      writeFileSync
    } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { installTerminalPorts, resetTerminalPorts } = await import('../ports/terminals')
    const { installSettingsPorts, resetSettingsPorts } = await import('../ports/registry')
    const { electronTestPorts } = await import('../ports/testing')
    const { fileStorage } = await import('../ports/storage')
    const { sessionRecords } = await import('../sessions/records')
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'clave-ledger-records-')))
    const data = join(dir, 'data')
    const folder = join(dir, 'session-records')
    mkdirSync(data)
    mkdirSync(folder)
    const kept = '44444444-4444-4444-8444-444444444444'
    const gone = '55555555-5555-4555-8555-555555555555'
    const plain = (id: string, cwd: string): string =>
      JSON.stringify({ id, cwd, folderName: 'project', claudeMode: false })
    writeFileSync(join(folder, `${kept}.json`), plain(kept, dir))
    writeFileSync(join(folder, `${gone}.json`), plain(gone, join(dir, 'gone')))
    writeFileSync(join(folder, '66666666-6666-4666-8666-666666666666.json'), '{not json')
    installSettingsPorts(electronTestPorts(dir))
    installTerminalPorts({ storage: fileStorage(dir) })
    const before = readdirSync(folder).sort()
    const manager = new SessionManager()
    try {
      await startClaveServer({
        manager,
        ports: { sessions: createSessionHost({ manager, lifecycle, records: sessionRecords }) },
        dataDir: data
      })
      expect(readdirSync(folder).sort()).toEqual(before)
      for (const id of [kept, gone])
        expect(
          JSON.parse(readFileSync(join(data, 'write-ledger', `${id}.ledger.json`), 'utf8'))
        ).toMatchObject({ complete: true })
    } finally {
      await stopClaveServer()
      resetTerminalPorts()
      resetSettingsPorts()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

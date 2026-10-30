import { describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../api/client'
import type { PushSocketConstructor } from '../api/push'
import { Drafts, MemoryKeyValueStore } from '../chat/drafts'
import { MemorySecureStore, SecureCredentialStore } from '../machines/credentials'
import type { Machine, MachineSource } from '../machines/types'
import { createStore, mintMessageId, orderProfiles, startPayload } from './store'

/** A stub server behind `fetch`: the requests list and the resolve route,
 *  with one request another client settles first. */
function stubServer(): { fetch: FetchLike; calls: string[]; settleElsewhere: () => void } {
  const calls: string[] = []
  let pending = [
    {
      id: 'req-1',
      sessionId: 's1',
      kind: 'permission',
      description: 'May I?',
      createdAt: 1,
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'deny', label: 'Deny' }
      ]
    }
  ]
  let settled = false
  const json = (status: number, body: unknown): ReturnType<FetchLike> =>
    Promise.resolve({ status, ok: status < 300, text: async () => JSON.stringify(body) })
  return {
    calls,
    settleElsewhere: () => {
      settled = true
      pending = []
    },
    fetch: async (url, init) => {
      const path = new URL(url).pathname
      calls.push(`${init.method} ${path}`)
      if (path === '/requests/pending') return json(200, { revision: settled ? 2 : 1, pending })
      if (path === '/requests/resolve') {
        // The server's first-valid-answer rule: a settled request answers accepted: false.
        if (settled) return json(200, { accepted: false })
        settled = true
        pending = []
        return json(200, { accepted: true })
      }
      return json(404, { error: 'no such route' })
    }
  }
}

const NoSocket = class {
  onopen = null
  onmessage = null
  onclose = null
  onerror = null
  send(): void {
    /* a stub */
  }
  close(): void {
    /* a stub */
  }
} as unknown as PushSocketConstructor

const machine: Machine = {
  id: 'dev:127.0.0.1:1',
  name: 'Dev',
  platform: 'unknown',
  version: '',
  online: true,
  lastSeen: null,
  baseUrl: 'http://127.0.0.1:1',
  pushUrl: 'http://127.0.0.1:1/push'
}

async function storeWith(
  server: ReturnType<typeof stubServer>,
  drafts = new Drafts(new MemoryKeyValueStore())
): Promise<ReturnType<typeof createStore>> {
  const credentials = new SecureCredentialStore(new MemorySecureStore())
  await credentials.set(machine.id, { serverUrl: machine.baseUrl, bearer: 't' })
  const source: MachineSource = { list: async () => [machine] }
  const kv = new MemoryKeyValueStore()
  const store = createStore({
    build: 'development',
    credentials,
    sources: { relay: source, developer: null },
    kv,
    drafts,
    clientOptions: { fetch: server.fetch, build: 'development' },
    pushOptions: { WebSocket: NoSocket, build: 'development' },
    clientName: 'test'
  })
  await store.getState().loadMachines()
  return store
}

describe('the store and the requests', () => {
  it('a resolution the server refuses is answered accepted: false and the request is gone on reload', async () => {
    const server = stubServer()
    const store = await storeWith(server)
    await store.getState().loadRequests(machine.id)
    expect(store.getState().requests[machine.id]?.snapshot?.pending.map((r) => r.id)).toEqual([
      'req-1'
    ])
    // Another client answers first.
    server.settleElsewhere()
    const outcome = await store.getState().resolveRequest(machine.id, 'req-1', {
      type: 'permission',
      optionId: 'approve'
    })
    expect(outcome).toEqual({ accepted: false })
    // The resolve reloads the list: the settled request is no longer there.
    await new Promise((r) => setTimeout(r, 10))
    expect(store.getState().requests[machine.id]?.snapshot?.pending).toEqual([])
    expect(server.calls.filter((c) => c === 'POST /requests/resolve')).toHaveLength(1)
  })
  it('an accepted resolution is answered accepted: true', async () => {
    const server = stubServer()
    const store = await storeWith(server)
    await store.getState().loadRequests(machine.id)
    expect(
      await store
        .getState()
        .resolveRequest(machine.id, 'req-1', { type: 'permission', optionId: 'approve' })
    ).toEqual({ accepted: true })
  })
})

describe('the start payload and the profile order', () => {
  it('carries the family boolean, the id, the full definition and the workspace, never an account', () => {
    const payload = startPayload(
      { id: 'ws', name: 'scratch', rootDir: '/tmp/scratch', profileFile: null, createdAt: 1 },
      {
        id: 'codex-chat',
        name: 'Codex (chat)',
        family: 'codex',
        command: ['codex'],
        additionalArgs: ['--yolo'],
        sourceProfileId: 'codex'
      }
    )
    expect(payload).toEqual({
      cwd: '/tmp/scratch',
      options: {
        codexMode: true,
        launchProfileId: 'codex-chat',
        launchProfile: {
          id: 'codex-chat',
          name: 'Codex (chat)',
          family: 'codex',
          command: ['codex'],
          additionalArgs: ['--yolo'],
          sourceProfileId: 'codex'
        },
        workspaceId: 'ws'
      }
    })
    expect(JSON.stringify(payload)).not.toMatch(/claudeProfileId|codexAccountId/)
  })
  it('lists the chat profiles first, each group by name', () => {
    const ordered = orderProfiles([
      {
        id: 'custom-b',
        name: 'Zed terminal',
        family: 'claude',
        command: ['claude'],
        additionalArgs: []
      },
      {
        id: 'codex-chat',
        name: 'Codex (chat)',
        family: 'codex',
        command: ['codex'],
        additionalArgs: []
      },
      {
        id: 'custom-a',
        name: 'Alpha terminal',
        family: 'claude',
        command: ['claude'],
        additionalArgs: []
      },
      {
        id: 'dev-echo-adapter',
        name: 'Echo (development)',
        family: 'claude',
        command: ['echo'],
        additionalArgs: []
      },
      {
        id: 'claude-chat',
        name: 'Claude (chat)',
        family: 'claude',
        command: ['claude'],
        additionalArgs: []
      }
    ])
    expect(ordered.map((p) => p.id)).toEqual([
      'claude-chat',
      'codex-chat',
      'dev-echo-adapter',
      'custom-a',
      'custom-b'
    ])
  })
  it('mints an id of 8 to 64 characters', () => {
    const id = mintMessageId()
    expect(id.length).toBeGreaterThanOrEqual(8)
    expect(id.length).toBeLessThanOrEqual(64)
    expect(id).toMatch(/^m-[0-9a-f]{24}$/)
    expect(mintMessageId()).not.toBe(id)
  })
})

describe('HTTP write outcomes preserve drafts', () => {
  it('a pending write retains the draft until the status is accepted, without another write', async () => {
    vi.useFakeTimers()
    try {
      let accepted = false
      let writes = 0
      const server = stubServer()
      server.fetch = async (url) => {
        const path = new URL(url).pathname
        if (path === '/sessions/write') writes++
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify({
              status: path === '/sessions/write' || !accepted ? 'pending' : 'accepted'
            })
        }
      }
      const drafts = new Drafts(new MemoryKeyValueStore())
      const store = await storeWith(server, drafts)
      await drafts.set(machine.id, 's1', 'keep me')
      const clear = vi.spyOn(Drafts.prototype, 'clear')
      let settled = false
      const send = store
        .getState()
        .send(machine.id, 's1', 'keep me', 'message-pending')
        .then((outcome) => {
          settled = true
          return outcome
        })
      await vi.advanceTimersByTimeAsync(500)
      expect(settled).toBe(false)
      expect(await drafts.get(machine.id, 's1')).toBe('keep me')
      expect(clear).not.toHaveBeenCalled()
      accepted = true
      await vi.advanceTimersByTimeAsync(1000)
      expect((await send).kind).toBe('sent')
      expect(writes).toBe(1)
      expect(clear).toHaveBeenCalledWith(machine.id, 's1')
      expect(await drafts.get(machine.id, 's1')).toBe('')
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })
  it('pending for a minute ends unknown and malformed 2xx never clears the draft', async () => {
    vi.useFakeTimers()
    try {
      for (const body of [{ status: 'pending' }, {}]) {
        const server = stubServer()
        let writes = 0
        server.fetch = async (url) => {
          const path = new URL(url).pathname
          if (path === '/sessions/write') writes++
          return {
            status: 200,
            ok: true,
            text: async () =>
              JSON.stringify(path === '/sessions/write' ? body : { status: 'pending' })
          }
        }
        const drafts = new Drafts(new MemoryKeyValueStore())
        await drafts.set(machine.id, 's1', 'keep me')
        const store = await storeWith(server, drafts)
        const clear = vi.spyOn(Drafts.prototype, 'clear')
        const send = store.getState().send(machine.id, 's1', 'keep me', 'message-pending')
        await vi.advanceTimersByTimeAsync(60_001)
        expect((await send).kind).toBe('unknown')
        expect(await drafts.get(machine.id, 's1')).toBe('keep me')
        expect(clear).not.toHaveBeenCalled()
        expect(writes).toBe(1)
        clear.mockRestore()
      }
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })
})

it('an accepted send keeps a draft edited after dispatch', async () => {
  let accept!: (response: Awaited<ReturnType<FetchLike>>) => void
  const server = stubServer()
  server.fetch = () =>
    new Promise((resolve) => {
      accept = resolve
    })
  const drafts = new Drafts(new MemoryKeyValueStore())
  await drafts.set(machine.id, 's1', 'first')
  const store = await storeWith(server, drafts)
  const send = store.getState().send(machine.id, 's1', 'first', 'message-first')
  await vi.waitFor(() => expect(accept).toBeTypeOf('function'))
  await drafts.set(machine.id, 's1', 'second')
  accept({ status: 200, ok: true, text: async () => JSON.stringify({ status: 'accepted' }) })
  expect((await send).kind).toBe('sent')
  expect(await drafts.get(machine.id, 's1')).toBe('second')
})

it('rejected and unknown writes keep the stored draft', async () => {
  for (const status of ['rejected', 'unknown'] as const) {
    const server = stubServer()
    server.fetch = async () => ({
      status: 422,
      ok: false,
      text: async () =>
        JSON.stringify({
          _tag: status === 'unknown' ? 'SessionWriteUnknown' : 'SessionWriteRefused',
          message: 'Not accepted.'
        })
    })
    const drafts = new Drafts(new MemoryKeyValueStore())
    await drafts.set(machine.id, 's1', 'keep me')
    const store = await storeWith(server, drafts)
    expect((await store.getState().send(machine.id, 's1', 'keep me', 'message-test')).kind).toBe(
      status
    )
    expect(await drafts.get(machine.id, 's1')).toBe('keep me')
  }
})

it('ignores a stale requests query that arrives after a newer settled snapshot', async () => {
  const server = stubServer()
  const answers: Array<(r: Awaited<ReturnType<FetchLike>>) => void> = []
  server.fetch = () => new Promise((resolve) => answers.push(resolve))
  const store = await storeWith(server)
  const old = store.getState().loadRequests(machine.id)
  await vi.waitFor(() => expect(answers).toHaveLength(1))
  const recent = store.getState().loadRequests(machine.id)
  await vi.waitFor(() => expect(answers).toHaveLength(2))
  const response = (revision: number, pending: unknown[]): Awaited<ReturnType<FetchLike>> => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({ revision, pending })
  })
  answers[1]!(response(2, []))
  await recent
  answers[0]!(
    response(1, [
      { id: 'old', sessionId: 's1', kind: 'permission', description: 'Settled', createdAt: 1 }
    ])
  )
  await old
  expect(store.getState().requests[machine.id]?.snapshot).toEqual({ revision: 2, pending: [] })
})

it('parallel machine reads share one socket and disconnect closes it', async () => {
  const server = stubServer()
  const store = await storeWith(server)
  const [a, b] = await Promise.all([
    store.getState().connect(machine.id),
    store.getState().connect(machine.id)
  ])
  expect(a).toBe(b)
  const close = vi.spyOn(a.push, 'close')
  store.getState().disconnectAll()
  expect(close).toHaveBeenCalledTimes(1)
})

it('queries authoritative status after gateway and malformed 2xx responses without another send', async () => {
  for (const response of [
    { status: 504, body: { error: 'gateway timeout' } },
    { status: 502, body: '' },
    { status: 500, body: {} },
    { status: 200, body: {} }
  ]) {
    for (const status of ['accepted', 'unknown'] as const) {
      let writes = 0
      let asks = 0
      const server = stubServer()
      server.fetch = async (url) => {
        if (new URL(url).pathname === '/sessions/write') {
          writes++
          return {
            status: response.status,
            ok: response.status < 300,
            text: async () => JSON.stringify(response.body)
          }
        }
        asks++
        return { status: 200, ok: true, text: async () => JSON.stringify({ status }) }
      }
      const drafts = new Drafts(new MemoryKeyValueStore())
      await drafts.set(machine.id, 's1', 'possibly delivered')
      const store = await storeWith(server, drafts)
      expect(
        (await store.getState().send(machine.id, 's1', 'possibly delivered', 'message-gateway'))
          .kind
      ).toBe(status === 'accepted' ? 'sent' : 'unknown')
      expect(writes).toBe(1)
      expect(asks).toBe(1)
      expect(await drafts.get(machine.id, 's1')).toBe(
        status === 'accepted' ? '' : 'possibly delivered'
      )
    }
  }
})

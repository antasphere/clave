import { describe, expect, it } from 'vitest'
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

async function storeWith(server: ReturnType<typeof stubServer>) {
  const credentials = new SecureCredentialStore(new MemorySecureStore())
  await credentials.set(machine.id, { serverUrl: machine.baseUrl, bearer: 't' })
  const source: MachineSource = { list: async () => [machine] }
  const kv = new MemoryKeyValueStore()
  const store = createStore({
    build: 'development',
    credentials,
    sources: { relay: source, developer: null },
    kv,
    drafts: new Drafts(kv),
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

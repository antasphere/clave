import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, Peer } from '../test-support'
import { SidebarLayouts } from './layouts'
import { memorySidebarStorage, noWindowsHost } from './ports'

let server: EmbeddedServer
const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json'
})
const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: headers(server.token),
    body: JSON.stringify(body)
  })

beforeEach(async () => {
  const storage = memorySidebarStorage()
  storage.documents.set('w1', {
    groups: [{ id: 'g1', name: 'Api', sessionIds: ['s1'] }],
    displayOrder: ['g1']
  })
  server = await startEmbedded({
    ports: { sessions: new FakeSource(), sidebar: new SidebarLayouts(storage, noWindowsHost) },
    helloTimeoutMs: 200
  })
})
afterEach(async () => {
  await server.stop()
})

describe('the sidebar over HTTP', () => {
  it('answers a window’s layout at revision 0 with its stored groups', async () => {
    const response = await fetch(`${server.url}/sidebar/layout?windowKey=w1`, {
      headers: headers(server.token)
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      windowKey: 'w1',
      revision: 0,
      groups: [
        { id: 'g1', name: 'Api', sessionIds: ['s1'], collapsed: false, cwd: null, terminals: [] }
      ],
      displayOrder: ['g1']
    })
  })
  it('refuses a save on a stale revision with the current snapshot', async () => {
    expect(
      (await post('/sidebar/layout', { windowKey: 'w1', groups: [], displayOrder: ['a'] })).status
    ).toBe(200)
    const stale = await post('/sidebar/layout', {
      windowKey: 'w1',
      baseRevision: 0,
      groups: [],
      displayOrder: ['b']
    })
    expect(stale.status).toBe(422)
    expect(await stale.json()).toMatchObject({
      _tag: 'LayoutConflict',
      windowKey: 'w1',
      current: { revision: 1, displayOrder: ['a'] }
    })
  })
  it('answers GroupNotFound for an unknown group, declared', async () => {
    const missing = await post('/sidebar/groups/rename', {
      windowKey: 'w1',
      groupId: 'nope',
      name: 'x'
    })
    expect(missing.status).toBe(422)
    expect(await missing.json()).toMatchObject({ _tag: 'GroupNotFound', groupId: 'nope' })
  })
  it('refuses a request without the token', async () => {
    expect((await fetch(`${server.url}/sidebar/layout?windowKey=w1`)).status).toBe(401)
  })
})

describe('the sidebar on the push channel', () => {
  it('tells a welcomed peer of a group created by a command', async () => {
    const peer = new Peer(server.url.replace('http', 'ws') + '/push')
    await peer.opened
    peer.send({ _tag: 'hello', token: server.token, client: 'test' })
    expect(await peer.next()).toMatchObject({ _tag: 'welcome' })
    const created = await post('/sidebar/groups', {
      windowKey: 'w1',
      group: { name: 'Web', sessionIds: ['s2'] }
    })
    expect(created.status).toBe(200)
    const body = (await created.json()) as { group: { id: string }; layout: { revision: number } }
    expect(body.layout.revision).toBe(1)
    const frame = await peer.next()
    expect(frame).toMatchObject({
      _tag: 'event',
      event: {
        _tag: 'sidebar.layout_changed',
        cause: 'command',
        layout: { windowKey: 'w1', revision: 1, displayOrder: ['g1', body.group.id] }
      }
    })
    // Told once: the layer that subscribes is built once, whoever provides it.
    expect(await peer.silence()).toBe(true)
    peer.ws.close()
  })
})

describe('a move on a server without windows', () => {
  it('answers 422 CapabilityUnavailable naming the sidebar', async () => {
    const res = await fetch(`${server.url}/sidebar/windows/move-sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: ['s1'], targetWindowKey: 'w2' })
    })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ _tag: 'CapabilityUnavailable', capability: 'sidebar' })
  })
})

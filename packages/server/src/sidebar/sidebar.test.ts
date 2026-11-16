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
    // The change, and the phone's payload-free notice beside it, in either order.
    const events = [await peer.next(), await peer.next()].map((frame) =>
      frame._tag === 'event' ? frame.event : frame
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        _tag: 'sidebar.layout_changed',
        cause: 'command',
        layout: expect.objectContaining({
          windowKey: 'w1',
          revision: 1,
          displayOrder: ['g1', body.group.id]
        })
      })
    )
    expect(events).toContainEqual({ _tag: 'sidebar.overview_changed' })
    // Told once each: the layers that subscribe are built once, whoever provides them.
    expect(await peer.silence()).toBe(true)
    peer.ws.close()
  })
})

describe('the overview a phone reads', () => {
  it('answers every window’s groups without their terminals, prompts, folders or views', async () => {
    await post('/sidebar/groups/prompt', { windowKey: 'w1', groupId: 'g1', prompt: 'secret plan' })
    await post('/sidebar/groups/color', { windowKey: 'w1', groupId: 'g1', color: 'green' })
    await post('/sidebar/groups/terminals', {
      windowKey: 'w1',
      groupId: 'g1',
      terminal: { command: 'TOKEN=abc npm run dev', commandMode: 'auto', color: 'blue' }
    })
    await post('/sidebar/groups', { windowKey: 'w2', group: { id: 'g2', name: 'Docs' } })
    const response = await fetch(`${server.url}/sidebar/overview`, {
      headers: headers(server.token)
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({
      windows: [
        {
          windowKey: 'w1',
          displayOrder: ['g1'],
          groups: [{ id: 'g1', name: 'Api', color: 'green', collapsed: false, sessionIds: ['s1'] }]
        },
        {
          windowKey: 'w2',
          displayOrder: ['g2'],
          groups: [{ id: 'g2', name: 'Docs', collapsed: false, sessionIds: [] }]
        }
      ]
    })
    for (const leaked of ['secret plan', 'TOKEN', 'npm run dev', 'terminals', 'cwd', 'prompt'])
      expect(text, leaked).not.toContain(leaked)
  })
  it('names an entry’s own source over the layouts when it is given one', async () => {
    const other = await startEmbedded({
      ports: {
        sessions: new FakeSource(),
        sidebarOverview: {
          read: () => ({
            windows: [{ windowKey: 'kA', workspaceId: 'ws-a', displayOrder: [], groups: [] }]
          }),
          onChange: () => () => {}
        }
      }
    })
    try {
      const response = await fetch(`${other.url}/sidebar/overview`, {
        headers: headers(other.token)
      })
      expect(await response.json()).toEqual({
        windows: [{ windowKey: 'kA', workspaceId: 'ws-a', displayOrder: [], groups: [] }]
      })
    } finally {
      await other.stop()
    }
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

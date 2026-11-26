import { afterEach, describe, expect, it } from 'vitest'
import type { TabProjects } from '@clave/contract/tab-projects-rules'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, Peer } from '../test-support'
import type { DecisionsService, TabProjectsReadOnHost } from './port'

/**
 * The decisions domain (PRDCT-5179): a client asks the server a tab runs on,
 * behind the bearer token; the ids reach the port as sent; a tab that got no
 * reading is an answer with its reason; every tab whose record the host
 * wrote is told to the peers as `session.projects_read`, once the host
 * wrote and never before; a server with nothing behind the port says so.
 */
let server: EmbeddedServer | undefined
afterEach(async () => {
  await server?.stop()
  server = undefined
})

const call = (body: unknown, token = server!.token): Promise<Response> =>
  fetch(`${server!.url}/decisions/tab-projects`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

async function welcomed(): Promise<Peer> {
  const peer = new Peer(`${server!.url.replace(/^http/, 'ws')}/push`)
  await peer.opened
  peer.send({ _tag: 'hello', token: server!.token, client: 'test' })
  expect(await peer.next()).toMatchObject({ _tag: 'welcome' })
  return peer
}
const eventOf = async (peer: Peer): Promise<unknown> => {
  const frame = await peer.next()
  expect(frame._tag).toBe('event')
  return (frame as { event: unknown }).event
}

const quill: TabProjects = {
  status: 'decided',
  picks: [{ file: '/w/quill/.clave/workspaces/default.clave', name: 'Quill', p: 0.95 }],
  fits: 0.92,
  readAt: 1,
  model: 'jev-1.14.0',
  basis: 'basis-quill'
}

describe('the decisions over HTTP', () => {
  it('reads the tabs named, answers each, and tells the peers of each record written once it was', async () => {
    const asked: Array<ReadonlyArray<string>> = []
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    const answers: TabProjectsReadOnHost[] = [
      { sessionId: 'read', projects: quill, written: true },
      { sessionId: 'kept', projects: quill, written: false },
      { sessionId: 'failed', projects: null, reason: 'unreachable', written: false },
      { sessionId: 'other', projects: null, reason: 'nothing', written: false }
    ]
    const port: DecisionsService = {
      readTabProjects: async (ids) => {
        asked.push(ids)
        await held
        return answers
      }
    }
    server = await startEmbedded({
      ports: { sessions: new FakeSource(), decisions: port },
      helloTimeoutMs: 500
    })
    const peer = await welcomed()
    const pending = call({ sessionIds: ['read', 'kept', 'failed', 'other'], extra: 1 })
    // The host has not written yet: nothing is told.
    expect(await peer.silence()).toBe(true)
    release!()
    const answer = await pending
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({
      tabs: [
        { sessionId: 'read', projects: quill },
        { sessionId: 'kept', projects: quill },
        { sessionId: 'failed', projects: null, reason: 'unreachable' },
        { sessionId: 'other', projects: null, reason: 'nothing' }
      ]
    })
    expect(asked).toEqual([['read', 'kept', 'failed', 'other']])
    expect(await eventOf(peer)).toEqual({
      _tag: 'session.projects_read',
      id: 'read',
      projects: quill
    })
    expect(await peer.silence()).toBe(true)
    peer.ws.close()
  })

  it('refuses, before the port, no id, an empty one, or more than fifty', async () => {
    const asked: unknown[] = []
    const port: DecisionsService = {
      readTabProjects: async (ids) => {
        asked.push(ids)
        return []
      }
    }
    server = await startEmbedded({ ports: { sessions: new FakeSource(), decisions: port } })
    expect((await call({ sessionIds: [] })).status).toBe(400)
    expect((await call({ sessionIds: [''] })).status).toBe(400)
    expect((await call({ sessionIds: Array.from({ length: 51 }, (_, i) => `s${i}`) })).status).toBe(
      400
    )
    expect(asked).toEqual([])
  })

  it('refuses without the token, and says so on a server with no decisions', async () => {
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    expect((await call({ sessionIds: ['s1'] }, 'wrong')).status).toBe(401)
    const answer = await call({ sessionIds: ['s1'] })
    expect(answer.status).toBe(422)
    expect(await answer.json()).toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'decisions'
    })
  })
})

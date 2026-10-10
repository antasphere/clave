import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, Peer, aSession } from '../test-support'

/**
 * The sessions commands the last agent tools need (wave 4, lane D,
 * PRDCT-3377): a tab's rename, the page on its row, a screen read, a message
 * typed in, a restart on another account. Each answers what the host did,
 * as the contract declares it, and tells every peer on the push channel.
 */
let server: EmbeddedServer
let source: FakeSource
const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json'
})
const get = (path: string): Promise<Response> =>
  fetch(`${server.url}${path}`, { headers: headers(server.token) })
const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: headers(server.token),
    body: JSON.stringify(body)
  })
const pushUrl = (): string => `${server.url.replace(/^http/, 'ws')}/push`

/** A welcomed peer, whose next frames are the events published after it. */
async function welcomed(): Promise<Peer> {
  const peer = new Peer(pushUrl())
  await peer.opened
  peer.send({ _tag: 'hello', token: server.token, client: 'test' })
  expect(await peer.next()).toMatchObject({ _tag: 'welcome' })
  return peer
}
const eventOf = async (peer: Peer): Promise<unknown> => {
  const frame = await peer.next()
  expect(frame._tag).toBe('event')
  return (frame as { event: unknown }).event
}

beforeEach(async () => {
  source = new FakeSource(aSession('s1'), aSession('s2', 'w2'))
  server = await startEmbedded({ ports: { sessions: source }, helloTimeoutMs: 500 })
})
afterEach(async () => {
  await server.stop()
})

describe('a tab’s name', () => {
  it('renames through the host, answers the record, and tells the peers', async () => {
    const peer = await welcomed()
    const response = await post('/sessions/rename', { id: 's1', name: ' Lane D ' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 's1', title: 'Lane D' })
    expect(source.renames).toEqual([{ id: 's1', name: ' Lane D ' }])
    expect(await eventOf(peer)).toEqual({ _tag: 'session.renamed', id: 's1', name: 'Lane D' })
    peer.ws.close()
  })
  it('answers the declared failure for an unknown tab, and publishes nothing', async () => {
    const peer = await welcomed()
    const response = await post('/sessions/rename', { id: 'zz', name: 'x' })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ _tag: 'SessionNotFound', id: 'zz' })
    expect(source.renames).toEqual([])
    expect(await peer.silence()).toBe(true)
    peer.ws.close()
  })
})

describe('the page on a tab’s row', () => {
  it('puts a page on, with the session serving it, and takes it off', async () => {
    const peer = await welcomed()
    const page = { url: 'http://127.0.0.1:4814', title: 'Lane D', command: 'exos open', cwd: '/w' }
    // A command with nothing to answer is a 204.
    expect(
      (await post('/sessions/page', { id: 's1', page, servingSessionId: 'srv-1' })).status
    ).toBe(204)
    expect(source.pages).toEqual([{ id: 's1', page }])
    expect(await eventOf(peer)).toEqual({
      _tag: 'session.page_changed',
      id: 's1',
      page,
      servingSessionId: 'srv-1'
    })
    expect(
      (await post('/sessions/page', { id: 's1', page: null, servingSessionId: null })).status
    ).toBe(204)
    expect(source.pages.at(-1)).toEqual({ id: 's1', page: null })
    expect(await eventOf(peer)).toEqual({
      _tag: 'session.page_changed',
      id: 's1',
      page: null,
      servingSessionId: null
    })
    peer.ws.close()
  })
  it('refuses an unknown tab, and a page with no url', async () => {
    expect(
      (await post('/sessions/page', { id: 'zz', page: null, servingSessionId: null })).status
    ).toBe(422)
    const malformed = await post('/sessions/page', {
      id: 's1',
      page: { title: 'x' },
      servingSessionId: null
    })
    expect(malformed.status).toBe(400)
    expect(source.pages).toEqual([])
  })
})

describe('a screen read', () => {
  it('answers the host’s lines, the count decoded from the query', async () => {
    const response = await get('/sessions/screen?id=s1&lines=2')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ lines: ['$ ls', 'a  b'], cols: 80, rows: 24 })
  })
  it('refuses a count out of range before the host, and an unknown tab', async () => {
    expect((await get('/sessions/screen?id=s1&lines=0')).status).toBe(400)
    expect((await get('/sessions/screen?id=s1&lines=501')).status).toBe(400)
    const unknown = await get('/sessions/screen?id=zz')
    expect(unknown.status).toBe(422)
    expect(await unknown.json()).toMatchObject({ _tag: 'SessionNotFound' })
  })
  it('says a tab has no screen as the declared failure', async () => {
    source.screenOf = null
    const response = await get('/sessions/screen?id=s1')
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ _tag: 'SessionScreenUnavailable', id: 's1' })
  })
})

describe('a message typed in', () => {
  it('types through the host, answers the outcome, and tells the peers who typed', async () => {
    const peer = await welcomed()
    source.typeOutcome = { submitted: true, draftHandling: 'stashed-restored' }
    const response = await post('/sessions/type', {
      id: 's1',
      text: '[hdr]\nhello',
      from: 'Lane D'
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ submitted: true, draftHandling: 'stashed-restored' })
    expect(source.typed).toEqual([{ id: 's1', text: '[hdr]\nhello' }])
    expect(await eventOf(peer)).toEqual({ _tag: 'session.typed', id: 's1', from: 'Lane D' })
    peer.ws.close()
  })
  it('a refused write is the declared failure with the host’s words, and no event', async () => {
    const peer = await welcomed()
    source.refuse = new Error('the input is closed')
    const response = await post('/sessions/type', { id: 's1', text: 'x' })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      _tag: 'SessionWriteRefused',
      id: 's1',
      message: 'the input is closed'
    })
    expect(await peer.silence()).toBe(true)
    peer.ws.close()
  })
})

describe('a restart on another account', () => {
  it('restarts through the host, saying restarting first and restarted after', async () => {
    const peer = await welcomed()
    const account = { claudeProfileId: 'acc-2', claudeProfileLabel: 'Second' }
    const response = await post('/sessions/restart', { id: 's1', account, resendRejected: true })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 's1', resumed: true, alive: true })
    expect(source.restarts).toEqual([{ id: 's1', account, resendRejected: true }])
    expect(await eventOf(peer)).toEqual({ _tag: 'session.restarting', id: 's1' })
    expect(await eventOf(peer)).toEqual({
      _tag: 'session.restarted',
      id: 's1',
      resumed: true,
      account
    })
    peer.ws.close()
  })
  it('a restart the host cannot make is the declared failure', async () => {
    source.refuse = new Error('This session cannot be restarted from here.')
    const response = await post('/sessions/restart', { id: 's1', account: {} })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      _tag: 'SessionStartFailed',
      message: 'This session cannot be restarted from here.'
    })
  })
  it('refuses an unknown tab before anything is said', async () => {
    const peer = await welcomed()
    expect((await post('/sessions/restart', { id: 'zz', account: {} })).status).toBe(422)
    expect(source.restarts).toEqual([])
    expect(await peer.silence()).toBe(true)
    peer.ws.close()
  })
})

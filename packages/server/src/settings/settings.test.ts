import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, Peer } from '../test-support'
import { FakeSettingsSource } from './test-support'

let server: EmbeddedServer
let fake: FakeSettingsSource

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

beforeEach(async () => {
  fake = new FakeSettingsSource()
  server = await startEmbedded({
    ports: { sessions: new FakeSource(), settings: fake },
    helloTimeoutMs: 200
  })
})
afterEach(async () => {
  await server.stop()
})

describe('the settings group of the HTTP API', () => {
  it('lists the Claude accounts, and adds one', async () => {
    const empty = await get('/accounts/claude')
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual([])
    const added = await post('/accounts/claude', { label: 'Work' })
    expect([200, 201]).toContain(added.status)
    const account = (await added.json()) as { id: string }
    expect(account).toMatchObject({ label: 'Work', hasToken: false })
    const listed = await get('/accounts/claude')
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual([account])
  })

  it('hands the token to the source and to no answer', async () => {
    const { id } = (await (await post('/accounts/claude', { label: 'Work' })).json()) as {
      id: string
    }
    const set = await post('/accounts/claude/token', {
      id,
      token: 'sk-ant-oat01-secret-for-the-test'
    })
    expect(set.status).toBe(200)
    const text = await set.text()
    expect(text).not.toContain('sk-ant')
    expect(Array.isArray((JSON.parse(text) as { windows: unknown }).windows)).toBe(true)
    expect(fake.secrets).toEqual(['sk-ant-oat01-secret-for-the-test'])
    const listed = await get('/accounts/claude')
    const listedText = await listed.text()
    expect(listedText).not.toContain('sk-ant')
    expect(JSON.parse(listedText)).toEqual([expect.objectContaining({ id, hasToken: true })])
  })

  it('passes the usage parameters through, decoded', async () => {
    expect((await get('/usage/claude?accountId=a&force=true')).status).toBe(200)
    expect(fake.calls.at(-1)).toEqual({ method: 'usage.readClaude', args: ['a', true] })
    expect((await get('/usage/claude')).status).toBe(200)
    expect(fake.calls.at(-1)).toEqual({ method: 'usage.readClaude', args: [undefined, false] })
    const pi = await get('/usage/pi?range=7d')
    expect(pi.status).toBe(200)
    expect(fake.calls.at(-1)).toEqual({ method: 'usage.readPi', args: ['7d'] })
    expect(await pi.json()).toMatchObject({ range: '7d' })
    expect((await get('/usage/pi?range=never')).status).toBe(400)
  })

  it('answers a refused capability as the declared failure, the secret in no answer', async () => {
    fake.refuse.login = true
    const login = await post('/accounts/login', { provider: 'claude', accountId: 'a' })
    expect(login.status).toBe(422)
    const body = (await login.json()) as { message: string }
    expect(body).toMatchObject({ _tag: 'CapabilityUnavailable', capability: 'login' })
    expect(body.message.length).toBeGreaterThan(0)

    const apiKey = await post('/accounts/login/api-key', { accountId: 'a', apiKey: 'sk-test-key' })
    expect(apiKey.status).toBe(422)
    const apiKeyText = await apiKey.text()
    expect(apiKeyText).not.toContain('sk-test-key')
    expect(JSON.parse(apiKeyText)).toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'login'
    })
    expect(fake.secrets).toContain('sk-test-key')

    // Typing into or cancelling a login a server does not run is refused the same way.
    expect((await post('/accounts/login/input', { jobId: 'j', text: 'code' })).status).toBe(422)
    expect((await post('/accounts/login/cancel', { jobId: 'j' })).status).toBe(422)

    fake.refuse.appIcon = true
    const icon = await post('/preferences/app-icon', { icon: 'light' })
    expect(icon.status).toBe(422)
    expect(await icon.json()).toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'appIcon'
    })

    fake.refuse = {}
    const started = await post('/accounts/login', { provider: 'claude', accountId: 'a' })
    expect([200, 201]).toContain(started.status)
    expect(await started.json()).toMatchObject({ status: 'running', provider: 'claude' })
    const iconSet = await post('/preferences/app-icon', { icon: 'light' })
    expect([200, 204]).toContain(iconSet.status)
  })

  it('recognises a plain tagged refusal, and only where the definition declares it', async () => {
    Object.assign(fake.usage, {
      readPi: () => {
        throw { _tag: 'CapabilityUnavailable', capability: 'usage', message: 'nope' }
      }
    })
    // ReadPiUsage declares no failure: a refusal there is a defect.
    expect((await get('/usage/pi?range=7d')).status).toBe(500)

    Object.assign(fake.preferences, {
      setAppIcon: () => {
        throw { _tag: 'CapabilityUnavailable', capability: 'appIcon', message: 'plain' }
      }
    })
    const icon = await post('/preferences/app-icon', { icon: 'light' })
    expect(icon.status).toBe(422)
    expect(await icon.json()).toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'appIcon',
      message: 'plain'
    })
  })

  it('answers a manager’s refusal as the declared failure with its sentence, on a command only', async () => {
    const { id } = (await (await post('/accounts/claude', { label: 'Work' })).json()) as {
      id: string
    }
    const refused = await post('/accounts/claude/token', { id, token: 'not-a-token' })
    expect(refused.status).toBe(422)
    expect(await refused.json()).toEqual({
      _tag: 'SettingsRefused',
      message: 'That does not look like a Claude Code token (expected sk-ant-…).'
    })
    // A subclass of Error is not a refusal: a TypeError in the source is a defect.
    Object.assign(fake.claudeAccounts, {
      clearToken: () => {
        throw new TypeError('bug')
      }
    })
    expect((await post('/accounts/claude/token/clear', { id })).status).toBe(500)
    // A query never refuses: a plain Error there is a defect too.
    Object.assign(fake.claudeAccounts, {
      migrated: () => {
        throw new Error('no')
      }
    })
    expect((await get('/accounts/claude/migrated')).status).toBe(500)
  })

  it('answers a source that throws as a defect, never an empty list', async () => {
    Object.assign(fake.claudeAccounts, {
      list: () => {
        throw new Error('boom')
      }
    })
    expect((await get('/accounts/claude')).status).toBe(500)
  })

  it('refuses a payload the bus cannot decode', async () => {
    expect((await post('/accounts/claude', {})).status).toBe(400)
  })
})

describe('the settings events on the push channel', () => {
  const welcomed = async (): Promise<Peer> => {
    const peer = new Peer(server.url.replace('http', 'ws') + '/push')
    await peer.opened
    peer.send({ _tag: 'hello', token: server.token, client: 'test' })
    expect(await peer.next()).toMatchObject({ _tag: 'welcome', serverId: server.serverId })
    return peer
  }

  it('republishes every source event, and nothing for a write that changed nothing', async () => {
    const peer = await welcomed()
    fake.emit({ _tag: 'accounts.claude_changed', accounts: [] })
    expect(await peer.next()).toMatchObject({
      _tag: 'event',
      event: { _tag: 'accounts.claude_changed', accounts: [] }
    })

    const pins = await post('/workspaces/pins', { scope: null, pins: [{ a: 1 }], origin: 'w1' })
    expect(pins.status).toBe(200)
    expect(await pins.json()).toEqual({ ok: true })
    expect(await peer.next()).toMatchObject({
      _tag: 'event',
      event: { _tag: 'workspaces.state_changed', origin: 'w1', pins: [{ a: 1 }] }
    })

    const refused = await post('/workspaces/pins', { scope: 'bad', pins: [] })
    expect(refused.status).toBe(200)
    expect(await refused.json()).toEqual({ ok: false, reason: 'invalid-key' })
    expect(await peer.silence()).toBe(true)
  })

  it('holds one subscription while the server runs and releases it on stop', async () => {
    expect(fake.listenerCount()).toBe(1)
    await server.stop()
    expect(fake.listenerCount()).toBe(0)
    // afterEach stops it again; restart one so that stays harmless.
    server = await startEmbedded({ ports: { sessions: new FakeSource(), settings: fake } })
  })
})

describe('a server with no settings behind it', () => {
  it('refuses every settings call, never answering an empty store', async () => {
    const bare = await startEmbedded({ ports: { sessions: new FakeSource() } })
    try {
      const auth = headers(bare.token)
      const list = await fetch(`${bare.url}/accounts/claude`, { headers: auth })
      expect(list.status).toBeGreaterThanOrEqual(500)
      const login = await fetch(`${bare.url}/accounts/login`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ provider: 'claude', accountId: 'a' })
      })
      expect(login.status).toBe(422)
      expect(await login.json()).toMatchObject({
        _tag: 'CapabilityUnavailable',
        capability: 'login'
      })
    } finally {
      await bare.stop()
    }
  })
})

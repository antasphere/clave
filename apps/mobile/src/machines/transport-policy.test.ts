import { describe, expect, it } from 'vitest'
import { ClaveServerClient, type FetchLike } from '../api/client'
import { ClavePushClient, type PushSocketConstructor } from '../api/push'
import { RelayMachineSource } from './relay'
import { credentialMayTravelTo } from './transport-policy'

describe('where a credential may travel', () => {
  it('https and wss, always', () => {
    expect(credentialMayTravelTo('https://relay.example/m/x', 'release')).toEqual({ ok: true })
    expect(credentialMayTravelTo('wss://relay.example/m/x/push', 'release')).toEqual({ ok: true })
    expect(credentialMayTravelTo('https://192.168.1.5:43201', 'release')).toEqual({ ok: true })
  })
  it('plain http to the loopback in a development build only', () => {
    expect(credentialMayTravelTo('http://127.0.0.1:43201', 'development')).toEqual({ ok: true })
    expect(credentialMayTravelTo('ws://localhost:43201/push', 'development')).toEqual({ ok: true })
    expect(credentialMayTravelTo('http://[::1]:43201', 'development')).toEqual({ ok: true })
    expect(credentialMayTravelTo('http://192.168.1.5:43201', 'development').ok).toBe(false)
    expect(credentialMayTravelTo('http://127.0.0.1:43201', 'release').ok).toBe(false)
    expect(credentialMayTravelTo('ws://127.0.0.1:43201/push', 'release').ok).toBe(false)
    expect(credentialMayTravelTo('http://100.64.0.2:43127', 'release').ok).toBe(false)
  })
  it('anything else never', () => {
    expect(credentialMayTravelTo('ftp://x', 'development').ok).toBe(false)
    expect(credentialMayTravelTo('not an address', 'release').ok).toBe(false)
  })
})

describe('a release-configured client', () => {
  it('refuses a plain-http address before any request, and sends nothing to it', async () => {
    const calls: string[] = []
    const fetch: FetchLike = async (url) => {
      calls.push(url)
      return { status: 200, ok: true, text: async () => '[]' }
    }
    expect(
      () =>
        new ClaveServerClient(
          { serverUrl: 'http://192.168.1.5:43201', bearer: 'device-session' },
          { fetch, build: 'release' }
        )
    ).toThrow(/never travels over plain http/)
    expect(
      () => new ClaveServerClient({ serverUrl: 'http://127.0.0.1:43201', bearer: 'x' }, { fetch })
    ).toThrow(/plain http/)
    expect(calls).toEqual([])
    const over = new ClaveServerClient(
      { serverUrl: 'https://relay.example/m/mac-1', bearer: 'x' },
      { fetch, build: 'release' }
    )
    await over.sessions.list()
    expect(calls).toEqual(['https://relay.example/m/mac-1/sessions'])
  })
  it('refuses a plain ws push address before opening a socket', () => {
    const opened: string[] = []
    const Ctor = class {
      onopen = null
      onmessage = null
      onclose = null
      onerror = null
      constructor(url: string) {
        opened.push(url)
      }
      send(): void {
        /* a stub: nothing goes anywhere */
      }
      close(): void {
        /* a stub */
      }
    } as unknown as PushSocketConstructor
    expect(
      () =>
        new ClavePushClient({
          url: 'http://192.168.1.5:43201',
          token: 'x',
          WebSocket: Ctor,
          build: 'release'
        })
    ).toThrow(/never travels over plain ws/)
    expect(
      () => new ClavePushClient({ url: 'http://127.0.0.1:43201', token: 'x', WebSocket: Ctor })
    ).toThrow()
    expect(opened).toEqual([])
    const client = new ClavePushClient({
      url: 'https://relay.example/m/mac-1',
      token: 'x',
      WebSocket: Ctor,
      build: 'release'
    })
    client.connect()
    expect(opened).toEqual(['wss://relay.example/m/mac-1/push'])
    client.close()
  })
  it('refuses a plain-http relay, and ignores the direct addresses a record carries', async () => {
    expect(
      () => new RelayMachineSource('http://relay.local', async () => 't', { build: 'release' })
    ).toThrow()
    const calls: string[] = []
    const fetch: FetchLike = async (url) => {
      calls.push(url)
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            machines: [
              {
                id: 'mac-1',
                name: 'Mac',
                platform: 'macos',
                version: '2.4.0',
                online: true,
                lastSeen: null,
                direct: [{ url: 'http://192.168.1.5:43201' }, { url: 'http://100.64.0.2:43127' }]
              }
            ]
          })
      }
    }
    const source = new RelayMachineSource('https://relay.example', async () => 't', {
      fetch,
      build: 'release'
    })
    const [machine] = await source.list()
    expect(machine?.baseUrl).toBe('https://relay.example/m/mac-1')
    expect(machine?.pushUrl).toBe('https://relay.example/m/mac-1/push')
    expect(calls).toEqual(['https://relay.example/machines'])
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { MemoryKeyValueStore } from '../chat/drafts'
import { MemorySecureStore, SecureCredentialStore } from './credentials'
import { DeveloperMachineSource, developerMachineId, normalizeServerUrl } from './developer'
import { RelayMachineSource, machineBaseUrl, machinePushUrl } from './relay'

/** A stub of the relay's wire, as lane E's brief states it. */
let relay: Server
let relayUrl = ''
let clave: Server
let claveUrl = ''
const HUB_TOKEN = 'hub-access-token'
const SERVER_TOKEN = 'server-token'

beforeAll(async () => {
  relay = createServer((req, res) => {
    const auth = req.headers.authorization
    if (req.url !== '/machines') {
      res.writeHead(404).end()
      return
    }
    if (auth !== `Bearer ${HUB_TOKEN}`) {
      res
        .writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'Unauthenticated' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        machines: [
          {
            id: 'mac-1',
            name: "Valentin's Mac",
            platform: 'macos',
            version: '2.4.0',
            online: true,
            lastSeen: '2026-10-29T15:00:00Z',
            direct: [{ url: 'http://100.64.0.2:43127' }]
          },
          {
            id: 'vps 1',
            name: 'VPS',
            platform: 'linux',
            version: '2.3.0',
            online: false,
            lastSeen: null,
            direct: []
          },
          { id: 'odd', platform: 'windows', online: 'yes' }
        ]
      })
    )
  })
  clave = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${SERVER_TOKEN}`) {
      res
        .writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'Unauthenticated' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        version: 1,
        customProfiles: [],
        globalDefaults: {},
        workspaceOverrides: {}
      })
    )
  })
  for (const [server, set] of [
    [relay, (u: string): void => void (relayUrl = u)],
    [clave, (u: string): void => void (claveUrl = u)]
  ] as const) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    set(`http://127.0.0.1:${address.port}`)
  }
})
afterAll(async () => {
  await Promise.all([relay, clave].map((s) => new Promise<void>((r) => s.close(() => r()))))
})

describe('RelayMachineSource', () => {
  it("lists the machines of the token's subject with the relay road as base", async () => {
    const source = new RelayMachineSource(`${relayUrl}/`, async () => HUB_TOKEN, {
      build: 'development'
    })
    const machines = await source.list()
    expect(machines).toHaveLength(3)
    expect(machines[0]).toEqual({
      id: 'mac-1',
      name: "Valentin's Mac",
      platform: 'macos',
      version: '2.4.0',
      online: true,
      lastSeen: Date.parse('2026-10-29T15:00:00Z'),
      baseUrl: `${relayUrl}/m/mac-1`,
      pushUrl: `${relayUrl}/m/mac-1/push`
    })
    expect(machines[1]).toMatchObject({
      id: 'vps 1',
      online: false,
      lastSeen: null,
      baseUrl: `${relayUrl}/m/vps%201`
    })
    expect(machines[2]).toMatchObject({
      id: 'odd',
      name: 'odd',
      platform: 'unknown',
      online: false,
      version: ''
    })
  })
  it('a bad hub token is unauthenticated', async () => {
    const source = new RelayMachineSource(relayUrl, async () => 'stale', { build: 'development' })
    await expect(source.list()).rejects.toMatchObject({ kind: 'unauthenticated' })
  })
  it('builds the road URLs', () => {
    expect(machineBaseUrl('https://relay.example/', 'abc')).toBe('https://relay.example/m/abc')
    expect(machinePushUrl('https://relay.example', 'abc')).toBe('https://relay.example/m/abc/push')
  })
})

describe('SecureCredentialStore', () => {
  it('keeps one credential per machine, the first paired as main', async () => {
    const secure = new MemorySecureStore()
    const store = new SecureCredentialStore(secure)
    expect(await store.get('m1')).toBeNull()
    await store.set('m1', { serverUrl: 'http://a', bearer: 'x' })
    await store.set('m 2', { serverUrl: 'http://b', bearer: 'y' })
    expect(await store.get('m1')).toEqual({ serverUrl: 'http://a', bearer: 'x' })
    expect(await store.get('m 2')).toEqual({ serverUrl: 'http://b', bearer: 'y' })
    expect(await store.mainMachineId()).toBe('m1')
    for (const key of secure.map.keys()) expect(key).toMatch(/^[A-Za-z0-9._-]+$/)
    await store.remove('m1')
    expect(await store.get('m1')).toBeNull()
    expect(await store.mainMachineId()).toBeNull()
  })
})

describe('DeveloperMachineSource', () => {
  it('normalizes the address', () => {
    expect(normalizeServerUrl(' 127.0.0.1:43201/ ')).toBe('http://127.0.0.1:43201')
    expect(normalizeServerUrl('https://relay.example/m/x/')).toBe('https://relay.example/m/x')
    expect(() => normalizeServerUrl('ftp://x')).toThrow()
    expect(developerMachineId('http://127.0.0.1:43201')).toBe('dev:127.0.0.1:43201')
  })
  it('tries the token once, keeps it in the credential store and lists the machine', async () => {
    const kv = new MemoryKeyValueStore()
    const credentials = new SecureCredentialStore(new MemorySecureStore())
    const source = new DeveloperMachineSource(kv, credentials)
    await expect(source.add(claveUrl, 'wrong', 'Dev')).rejects.toMatchObject({
      kind: 'unauthenticated'
    })
    expect(await source.list()).toEqual([])
    const machine = await source.add(claveUrl, SERVER_TOKEN, 'Dev')
    expect(machine).toMatchObject({
      id: `dev:${new URL(claveUrl).host}`,
      name: 'Dev',
      baseUrl: claveUrl,
      pushUrl: `${claveUrl}/push`,
      online: true
    })
    expect(await credentials.get(machine.id)).toEqual({ serverUrl: claveUrl, bearer: SERVER_TOKEN })
    expect(await source.list()).toHaveLength(1)
    await source.remove(machine.id)
    expect(await source.list()).toEqual([])
    expect(await credentials.get(machine.id)).toBeNull()
  })
})

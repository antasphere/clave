import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import {
  resolveServerLaunch,
  startServer,
  readDiscovery,
  ServerBootError,
  DISCOVERY_FILE,
  type InProcessServer
} from './server-boot'
import { startStubServer, type StubServer } from './server-stub'

const identity = { kind: 'shell' as const, name: 'clave-shell 2.0.0', pid: 777 }

describe('resolveServerLaunch', () => {
  it('is in-process when CLAVE_SERVER_URL is unset or blank', () => {
    expect(resolveServerLaunch({})).toEqual({ mode: 'in-process' })
    expect(resolveServerLaunch({ CLAVE_SERVER_URL: '  ' })).toEqual({ mode: 'in-process' })
  })
  it('attaches when the url is set, with the token when given, trailing slash dropped', () => {
    expect(
      resolveServerLaunch({ CLAVE_SERVER_URL: 'http://127.0.0.1:4790/', CLAVE_SERVER_TOKEN: 'abc' })
    ).toEqual({ mode: 'attached', url: 'http://127.0.0.1:4790', token: 'abc' })
    expect(resolveServerLaunch({ CLAVE_SERVER_URL: 'http://127.0.0.1:4790' })).toEqual({
      mode: 'attached',
      url: 'http://127.0.0.1:4790',
      token: null
    })
  })
})

describe('startServer', () => {
  let userData: string
  let stub: StubServer | null
  beforeEach(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'clave-server-boot-'))
    stub = null
  })
  afterEach(async () => {
    await stub?.stop()
    rmSync(userData, { recursive: true, force: true })
  })

  /** An in-process starter that records whether it was asked. */
  const inProcess = (): { start: () => Promise<InProcessServer>; calls: number } => {
    const rec = {
      calls: 0,
      start: async (): Promise<InProcessServer> => {
        rec.calls++
        stub = await startStubServer({ port: 0 })
        return stub
      }
    }
    return rec
  }

  it('in-process: starts the server, registers the app on it, writes the discovery file', async () => {
    const starter = inProcess()
    const handle = await startServer({ env: {}, userData, identity, startInProcess: starter.start })
    expect(starter.calls).toBe(1)
    expect(handle.mode).toBe('in-process')
    expect(handle.url).toBe(stub!.url)
    expect(handle.clientId).toBeTruthy()
    expect(stub!.clients().map((c) => c.pid)).toEqual([777])

    const disc = readDiscovery(userData)
    expect(disc).toMatchObject({
      url: stub!.url,
      token: stub!.token,
      mode: 'in-process',
      ok: true,
      pid: 777,
      clientId: handle.clientId
    })
    // The file carries the token: owner-only.
    expect(statSync(path.join(userData, DISCOVERY_FILE)).mode & 0o777).toBe(0o600)

    await handle.stop()
    expect(stub!.clients()).toEqual([])
    await expect(fetch(`${stub!.url}/health/live`)).rejects.toThrow()
    await handle.stop() // idempotent
  })

  it('attached: uses the server given, never starts one of its own', async () => {
    const other = await startStubServer({ port: 0 })
    try {
      const starter = inProcess()
      const handle = await startServer({
        env: { CLAVE_SERVER_URL: other.url, CLAVE_SERVER_TOKEN: other.token },
        userData,
        identity,
        startInProcess: starter.start
      })
      expect(starter.calls).toBe(0)
      expect(handle.mode).toBe('attached')
      expect(handle.url).toBe(other.url)
      expect(other.clients().map((c) => c.pid)).toEqual([777])
      expect(readDiscovery(userData)).toMatchObject({ url: other.url, mode: 'attached', ok: true })

      // Stopping an attached handle deregisters and leaves the server up.
      await handle.stop()
      expect(other.clients()).toEqual([])
      expect((await fetch(`${other.url}/health/live`)).status).toBe(200)
    } finally {
      await other.stop()
    }
  })

  it('attached to a dead url: rejects, writes ok:false, and does NOT fall back in-process', async () => {
    // A port nobody listens on: bind one, read it, release it.
    const probe = await startStubServer({ port: 0 })
    const dead = probe.url
    await probe.stop()

    const starter = inProcess()
    await expect(
      startServer({
        env: { CLAVE_SERVER_URL: dead, CLAVE_SERVER_TOKEN: 'x' },
        userData,
        identity,
        startInProcess: starter.start,
        timeoutMs: 1500
      })
    ).rejects.toBeInstanceOf(ServerBootError)
    expect(starter.calls).toBe(0)
    const disc = readDiscovery(userData)
    expect(disc).toMatchObject({ url: dead, mode: 'attached', ok: false, token: null })
    expect(disc?.error).toMatch(/nothing answers/)
  })

  it('attached with a wrong token: rejects naming the token, nothing registered', async () => {
    const other = await startStubServer({ port: 0 })
    try {
      const starter = inProcess()
      await expect(
        startServer({
          env: { CLAVE_SERVER_URL: other.url, CLAVE_SERVER_TOKEN: 'wrong' },
          userData,
          identity,
          startInProcess: starter.start
        })
      ).rejects.toThrow(/refused the token/)
      expect(starter.calls).toBe(0)
      expect(other.clients()).toEqual([])
      expect(readDiscovery(userData)).toMatchObject({ ok: false, mode: 'attached' })
    } finally {
      await other.stop()
    }
  })

  it('in-process whose registration fails: stops what it started and reports', async () => {
    let started: StubServer | null = null
    const starter = async (): Promise<InProcessServer> => {
      started = await startStubServer({ port: 0, token: 'real' })
      // Hand back a handle whose token is wrong: the registration is refused.
      return { url: started.url, token: 'not-the-token', stop: started.stop }
    }
    await expect(
      startServer({ env: {}, userData, identity, startInProcess: starter })
    ).rejects.toThrow(/refused the token/)
    expect(started).not.toBeNull()
    await expect(fetch(`${started!.url}/health/live`)).rejects.toThrow()
    expect(JSON.parse(readFileSync(path.join(userData, DISCOVERY_FILE), 'utf-8')).ok).toBe(false)
  })
})

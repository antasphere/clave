import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { startEmbedded, SessionHost, type EmbeddedServer } from '@clave/server'
import {
  resolveServerLaunch,
  takeServerLaunch,
  startServer,
  readDiscovery,
  markServerGone,
  serverFlag,
  ServerBootError,
  DISCOVERY_FILE,
  PACKAGED_DEFAULT,
  type InProcessServer,
  type OwnServer
} from './server-boot'
import { getClaveServerEndpoint, setClaveServerEndpoint } from './server/endpoint'

const identity = { kind: 'shell' as const, name: 'clave-shell 2.0.0', pid: 777 }

/** The real server, over no sessions: what the standalone entry runs too. */
const aServer = (token?: string): Promise<EmbeddedServer> =>
  startEmbedded({
    ports: { sessions: SessionHost.none },
    port: 0,
    ...(token !== undefined && { token })
  })

/** Who the server lists, through its own API. */
const clientsOf = async (server: { url: string; token: string }): Promise<{ pid?: number }[]> => {
  const res = await fetch(`${server.url}/clients`, {
    headers: { authorization: `Bearer ${server.token}` }
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { pid?: number }[]
}

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

describe('resolveServerLaunch, the --server flag (wave 5)', () => {
  it('reads --server=x and --server x', () => {
    expect(serverFlag(['a', '--server=separate'])).toBe('separate')
    expect(serverFlag(['a', '--server', 'in-process', 'b'])).toBe('in-process')
    expect(serverFlag(['a', '--server-x=1'])).toBeUndefined()
    expect(serverFlag([])).toBeUndefined()
  })
  it('given twice, the first occurrence wins', () => {
    expect(serverFlag(['--server=separate', '--server=in-process'])).toBe('separate')
  })
  it('picks the flag’s mode, packaged or not', () => {
    expect(resolveServerLaunch({}, { argv: ['--server=separate'] })).toEqual({ mode: 'separate' })
    expect(resolveServerLaunch({}, { argv: ['--server=separate'], packaged: true })).toEqual({
      mode: 'separate'
    })
    expect(resolveServerLaunch({}, { argv: ['--server=in-process'], packaged: true })).toEqual({
      mode: 'in-process'
    })
  })
  it('the environment’s url wins over the flag', () => {
    expect(
      resolveServerLaunch(
        { CLAVE_SERVER_URL: 'http://127.0.0.1:4790', CLAVE_SERVER_TOKEN: 't' },
        { argv: ['--server=separate'] }
      )
    ).toEqual({ mode: 'attached', url: 'http://127.0.0.1:4790', token: 't' })
  })
  it('a flag with a value that is not a mode throws, naming the values', () => {
    expect(() => resolveServerLaunch({}, { argv: ['--server=standalone'] })).toThrow(
      /--server must be in-process or separate, got "standalone"/
    )
    expect(() => resolveServerLaunch({}, { argv: ['--server'] })).toThrow(/got ""/)
    expect(() => resolveServerLaunch({}, { argv: ['--server', '--test-no-activate'] })).toThrow(
      /got "--test-no-activate"/
    )
  })
  it('with no flag a development run is in-process and a packaged app runs the packaged default', () => {
    expect(resolveServerLaunch({}, { argv: [], packaged: false })).toEqual({ mode: 'in-process' })
    expect(resolveServerLaunch({}, { argv: [], packaged: true, platform: 'darwin' })).toEqual({
      mode: PACKAGED_DEFAULT
    })
    // Elsewhere the separate server has no Keychain to keep its secrets in.
    for (const platform of ['win32', 'linux'] as const)
      expect(resolveServerLaunch({}, { argv: [], packaged: true, platform })).toEqual({
        mode: 'in-process'
      })
    // The flag still names the mode on any platform.
    expect(
      resolveServerLaunch({}, { argv: ['--server=separate'], packaged: true, platform: 'win32' })
    ).toEqual({ mode: 'separate' })
    // Flipped by the second pull request of PRDCT-3434.
    expect(PACKAGED_DEFAULT).toBe('separate')
  })
})

describe('takeServerLaunch', () => {
  it('reads the pair and removes it from the environment, so nothing spawned inherits it', () => {
    const env: NodeJS.ProcessEnv = {
      CLAVE_SERVER_URL: 'http://127.0.0.1:4790',
      CLAVE_SERVER_TOKEN: 'abc',
      PATH: '/usr/bin'
    }
    expect(takeServerLaunch(env)).toEqual({
      mode: 'attached',
      url: 'http://127.0.0.1:4790',
      token: 'abc'
    })
    expect('CLAVE_SERVER_URL' in env).toBe(false)
    expect('CLAVE_SERVER_TOKEN' in env).toBe(false)
    expect(env.PATH).toBe('/usr/bin')
  })
  it('is in-process on a bare environment, which it leaves as it is', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    expect(takeServerLaunch(env)).toEqual({ mode: 'in-process' })
    expect(env).toEqual({ PATH: '/usr/bin' })
  })
})

describe('startServer', () => {
  let userData: string
  const owned: EmbeddedServer[] = []
  beforeEach(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'clave-server-boot-'))
    setClaveServerEndpoint(null)
  })
  afterEach(async () => {
    for (const s of owned.splice(0)) await s.stop().catch(() => undefined)
    rmSync(userData, { recursive: true, force: true })
    setClaveServerEndpoint(null)
  })

  /** An in-process starter that records whether it was asked, on the real server. */
  const inProcess = (): {
    start: () => Promise<InProcessServer>
    calls: number
    server: () => EmbeddedServer
  } => {
    let started: EmbeddedServer | null = null
    const rec = {
      calls: 0,
      server: () => started!,
      start: async (): Promise<InProcessServer> => {
        rec.calls++
        started = await aServer()
        owned.push(started)
        return started
      }
    }
    return rec
  }

  it('takes the decision over the environment when both are given', async () => {
    const starter = inProcess()
    const handle = await startServer({
      launch: { mode: 'in-process' },
      env: { CLAVE_SERVER_URL: 'http://127.0.0.1:1', CLAVE_SERVER_TOKEN: 'x' },
      userData,
      identity,
      startInProcess: starter.start
    })
    expect(handle.mode).toBe('in-process')
    await handle.stop()
  })

  it('in-process: starts the server, registers the app on it, writes the discovery file', async () => {
    const starter = inProcess()
    const handle = await startServer({ env: {}, userData, identity, startInProcess: starter.start })
    expect(starter.calls).toBe(1)
    expect(handle.mode).toBe('in-process')
    expect(handle.url).toBe(starter.server().url)
    expect(handle.clientId).toBeTruthy()
    expect((await clientsOf(starter.server())).map((c) => c.pid)).toEqual([777])

    const disc = readDiscovery(userData)
    expect(disc).toMatchObject({
      url: starter.server().url,
      token: starter.server().token,
      mode: 'in-process',
      ok: true,
      pid: 777,
      clientId: handle.clientId
    })
    // The file carries the token: owner-only.
    expect(statSync(path.join(userData, DISCOVERY_FILE)).mode & 0o777).toBe(0o600)
    // The in-process start publishes its own address (clave-server.ts does);
    // the boot leaves the endpoint store alone in this mode.
    expect(getClaveServerEndpoint()).toBeNull()

    await handle.stop()
    await expect(fetch(`${starter.server().url}/health/live`)).rejects.toThrow()
    await handle.stop() // idempotent
  })

  it('a start that throws writes ok:false over any previous file and rejects', async () => {
    writeFileSync(
      path.join(userData, DISCOVERY_FILE),
      JSON.stringify({
        url: 'http://127.0.0.1:59999',
        token: 'STALE',
        mode: 'in-process',
        ok: true
      })
    )
    const starter = async (): Promise<InProcessServer> => {
      throw new Error('EADDRINUSE: the listener could not bind')
    }
    await expect(
      startServer({ env: {}, userData, identity, startInProcess: starter })
    ).rejects.toThrow(/did not start: EADDRINUSE/)
    const disc = readDiscovery(userData)
    expect(disc).toMatchObject({ ok: false, mode: 'in-process', token: null, url: '' })
    expect(disc?.error).toMatch(/EADDRINUSE/)
  })

  it('separate: starts the child through its starter, attaches to it, writes its pid, stops it with the handle', async () => {
    // The "child" is the real server started in this process: what the boot
    // does with the starter's answer is the same whatever process it runs in.
    const own = await aServer()
    owned.push(own)
    let stopped = 0
    const starter = inProcess()
    const handle = await startServer({
      launch: { mode: 'separate' },
      userData,
      identity,
      startInProcess: starter.start,
      startSeparate: async (): Promise<OwnServer> => ({
        url: own.url,
        token: own.token,
        pid: 31337,
        stop: async () => {
          stopped += 1
          await own.stop()
        }
      })
    })
    expect(starter.calls).toBe(0)
    expect(handle.mode).toBe('separate')
    expect(handle.serverPid).toBe(31337)
    expect(handle.url).toBe(own.url)
    expect((await clientsOf(own)).map((c) => c.pid)).toEqual([777])
    expect(readDiscovery(userData)).toMatchObject({
      url: own.url,
      mode: 'separate',
      ok: true,
      pid: 777,
      serverPid: 31337,
      clientId: handle.clientId
    })
    // The boot publishes nothing itself: index.ts does, as for attached.
    expect(getClaveServerEndpoint()).toBeNull()
    await handle.stop()
    expect(stopped).toBe(1)
    await expect(fetch(`${own.url}/health/live`)).rejects.toThrow()
    await handle.stop()
    expect(stopped).toBe(1)
  })

  it('separate: a child gone while the app runs is marked in the file, the token out, the url and the pid kept', async () => {
    const own = await aServer()
    owned.push(own)
    const handle = await startServer({
      launch: { mode: 'separate' },
      userData,
      identity,
      startInProcess: inProcess().start,
      startSeparate: async (): Promise<OwnServer> => ({
        url: own.url,
        token: own.token,
        pid: 4242,
        stop: async () => {}
      })
    })
    const marked = markServerGone(
      userData,
      'the separate server exited (SIGKILL) while the app was running'
    )
    expect(marked).toMatchObject({
      url: own.url,
      mode: 'separate',
      ok: false,
      error: 'the separate server exited (SIGKILL) while the app was running',
      token: null,
      serverPid: 4242,
      clientId: null,
      pid: 777
    })
    expect(readDiscovery(userData)).toEqual(marked)
    expect(statSync(path.join(userData, DISCOVERY_FILE)).mode & 0o777).toBe(0o600)
    await handle.stop()
  })

  it('marking a folder with no discovery file writes nothing and answers null', () => {
    expect(markServerGone(userData, 'gone')).toBeNull()
    expect(readDiscovery(userData)).toBeNull()
  })

  it('separate: a child that does not start writes ok:false with the reason and rejects, nothing in its place', async () => {
    const starter = inProcess()
    await expect(
      startServer({
        launch: { mode: 'separate' },
        userData,
        identity,
        startInProcess: starter.start,
        startSeparate: async () => {
          throw new Error('the separate server exited (2) before announcing itself')
        }
      })
    ).rejects.toThrow(/the separate server did not start: .*exited \(2\)/)
    expect(starter.calls).toBe(0)
    expect(readDiscovery(userData)).toMatchObject({ ok: false, mode: 'separate', url: '' })
    expect(readDiscovery(userData)?.error).toMatch(/exited \(2\)/)
  })

  it('separate: a boot with no starter for it refuses rather than running in-process', async () => {
    const starter = inProcess()
    await expect(
      startServer({
        launch: { mode: 'separate' },
        userData,
        identity,
        startInProcess: starter.start
      })
    ).rejects.toThrow(/the separate server did not start: the shell has no starter/)
    expect(starter.calls).toBe(0)
  })

  it('separate: a child that answers but refuses the registration is stopped and the boot rejects', async () => {
    const own = await aServer('right-token')
    owned.push(own)
    let stopped = 0
    await expect(
      startServer({
        launch: { mode: 'separate' },
        userData,
        identity,
        startInProcess: inProcess().start,
        startSeparate: async (): Promise<OwnServer> => ({
          url: own.url,
          token: 'wrong-token',
          pid: 1,
          stop: async () => {
            stopped += 1
          }
        })
      })
    ).rejects.toThrow(/refused the token/)
    expect(stopped).toBe(1)
    expect(readDiscovery(userData)).toMatchObject({ ok: false, mode: 'separate', url: own.url })
  })

  it('attached: uses the server given, never starts one of its own, publishes nothing to the windows', async () => {
    const other = await aServer()
    owned.push(other)
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
    expect((await clientsOf(other)).map((c) => c.pid)).toEqual([777])
    expect(readDiscovery(userData)).toMatchObject({ url: other.url, mode: 'attached', ok: true })
    // A standalone server has no sessions in this wave: the windows stay on
    // IPC, so nothing is published for them to route to.
    expect(getClaveServerEndpoint()).toBeNull()

    // Stopping an attached handle deregisters and leaves the server up.
    await handle.stop()
    expect(await clientsOf(other)).toEqual([])
    expect(getClaveServerEndpoint()).toBeNull()
    expect((await fetch(`${other.url}/health/live`)).status).toBe(200)
  })

  it('attached to a dead url: rejects, writes ok:false, and does NOT fall back in-process', async () => {
    // A port nobody listens on: bind one, read it, release it.
    const probe = await aServer()
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
    expect(getClaveServerEndpoint()).toBeNull()
  })

  it('attached with a wrong token: rejects naming the token, nothing registered', async () => {
    const other = await aServer()
    owned.push(other)
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
    expect(await clientsOf(other)).toEqual([])
    expect(readDiscovery(userData)).toMatchObject({ ok: false, mode: 'attached' })
    expect(getClaveServerEndpoint()).toBeNull()
  })

  it('in-process whose registration fails: stops what it started and reports', async () => {
    let started: EmbeddedServer | null = null
    const starter = async (): Promise<InProcessServer> => {
      started = await aServer('real')
      owned.push(started)
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

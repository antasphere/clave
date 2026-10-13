/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test of a plain JS script */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, execFileSync, spawn } from 'node:child_process'
import {
  bunBinary,
  readServerDiscovery,
  serverCommand,
  startServerProcess,
  startTerminalProcess,
  terminalProcessBundle,
  terminalProcessCommand
} from './server-process.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The terminal process runs from the bundle electron-vite writes; without
// one (the Linux unit-test job builds nothing) the cases that need it are
// skipped and the CI's e2e job runs them after its build.
const BUNDLE = terminalProcessBundle(REPO)
const built = existsSync(BUNDLE)

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const untilDead = async (pid, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !alive(pid)
}

describe('the server as its own process', () => {
  it('announces itself, writes an owner-only discovery file, and takes both away when stopped', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'clave-server-process-'))
    try {
      const server = await startServerProcess({ repo: REPO, dataDir, terminals: 'none' })
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(server.token).toMatch(/^[0-9a-f]{64}$/)
      const file = path.join(dataDir, 'clave-server.json')
      expect(existsSync(file)).toBe(true)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect((await fetch(`${server.url}/health/live`)).status).toBe(200)

      await server.stop()
      expect(await untilDead(server.pid)).toBe(true)
      expect(existsSync(file)).toBe(false)
      await expect(fetch(`${server.url}/health/live`)).rejects.toThrow()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('registers the test fixture route only under --test-no-activate, and never by default', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'clave-server-process-gate-'))
    try {
      const evaluate = (server) =>
        fetch(`${server.url}/e2e/evaluate`, {
          method: 'POST',
          headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ source: '() => 1' })
        })
      // The entry as the dev script starts it: no test flag, no route.
      const bare = await startServerProcess({ repo: REPO, dataDir, terminals: 'none' })
      try {
        expect((await evaluate(bare)).status).toBe(404)
      } finally {
        await bare.stop()
      }
      // The entry as the harness starts it: the flag, the route, behind the token.
      const testing = await startServerProcess({
        repo: REPO,
        dataDir,
        terminals: 'none',
        args: ['--test-no-activate']
      })
      try {
        expect((await evaluate(testing)).status).toBe(200)
        expect(await (await evaluate(testing)).json()).toEqual({ ok: true, value: 1 })
        const noToken = await fetch(`${testing.url}/e2e/evaluate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: '() => 1' })
        })
        expect(noToken.status).toBe(401)
      } finally {
        await testing.stop()
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('takes ELECTRON_RUN_AS_NODE out of its own environment at boot, so nothing it spawns inherits it', async () => {
    // The packaged app starts the entry under its own binary with the
    // variable set (server-child.ts); the entry deletes it before anything
    // spawns, or a login shell, a chat's CLI and a Clave started from a tab
    // would carry it. Under Bun the variable is harmless, so the deletion is
    // read back through the test-only evaluate route rather than inferred.
    const dataDir = mkdtempSync(path.join(tmpdir(), 'clave-server-process-asnode-'))
    const server = await startServerProcess({
      repo: REPO,
      dataDir,
      terminals: 'none',
      args: ['--test-no-activate'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAVE_E2E_CONTROL: 'kept' }
    })
    try {
      const evaluate = async (source) =>
        (
          await fetch(`${server.url}/e2e/evaluate`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${server.token}`,
              'content-type': 'application/json'
            },
            body: JSON.stringify({ source })
          })
        ).json()
      expect(await evaluate('() => process.env.ELECTRON_RUN_AS_NODE ?? null')).toEqual({
        ok: true,
        value: null
      })
      // The rest of the environment is kept: the deletion is one name, not a wipe.
      expect(await evaluate('() => process.env.CLAVE_E2E_CONTROL ?? null')).toEqual({
        ok: true,
        value: 'kept'
      })
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('publishes a session’s state on its push channel and stops the session with the server', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'clave-server-process-states-'))
    const server = await startServerProcess({
      repo: REPO,
      dataDir,
      terminals: 'none',
      args: ['--test-no-activate', '--dev-echo-adapter']
    })
    try {
      const { connectThroughNode } = await import('../packages/client/src/node')
      const backing = await connectThroughNode(
        { url: server.url, token: server.token },
        { client: 'server-process-test' }
      )
      const events = []
      backing.push.onEvent((envelope) => events.push(envelope.event))
      backing.push.connect()
      await backing.push.whenOpen()
      const info = await backing.api.sessions.start({
        cwd: dataDir,
        windowKey: 'w1',
        options: { launchProfileId: 'dev-echo-adapter' }
      })
      backing.push.subscribe(info.id, () => {})
      await backing.push.subscribed(info.id)
      await backing.api.sessions.write(info.id, { type: 'user_message', text: 'hello' })
      const until = async (pred, ms = 5000) => {
        const end = Date.now() + ms
        while (Date.now() < end) {
          if (pred()) return true
          await new Promise((r) => setTimeout(r, 50))
        }
        return pred()
      }
      expect(
        await until(() =>
          events.some((e) => e._tag === 'session.state_changed' && e.id === info.id)
        )
      ).toBe(true)
      // The session is listed while the server runs and goes with it: a
      // chat's CLI is a child of this process and must not outlive it.
      expect((await backing.api.sessions.list('w1')).map((s) => s.id)).toEqual([info.id])
      backing.push.close()
      await backing.api.dispose()
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('stops the CLI a chat started when the server stops, as the app’s quit does', async () => {
    // A chat's CLI is a detached child of the server process (the adapter
    // spawns it so a quit cannot take it down by accident); the entry's stop
    // must kill it on purpose, or every stop of the standalone server leaves
    // an agent running (the verifier's round 1, Major 1). The CLI here is a
    // script that records its pid and sleeps.
    const dataDir = mkdtempSync(path.join(tmpdir(), 'clave-server-process-orphan-'))
    const fake = path.join(dataDir, 'fake-claude')
    const pidFile = path.join(dataDir, 'fake.pid')
    // The chat's CLI is the invocation on the stream protocol; the title
    // generator runs the same binary once for the tab's name (a one-shot job
    // of its own, not this session's) and must not be mistaken for it.
    writeFileSync(
      fake,
      `#!/bin/sh\ncase "$*" in *stream-json*) echo $$ > ${pidFile} ;; esac\nexec sleep 300\n`,
      { mode: 0o755 }
    )
    writeFileSync(
      path.join(dataDir, 'agent-launch-profiles.json'),
      JSON.stringify({
        version: 1,
        customProfiles: [
          { id: 'fake', name: 'Fake', family: 'claude', command: [fake], additionalArgs: [] }
        ],
        globalDefaults: {},
        workspaceOverrides: {}
      })
    )
    const server = await startServerProcess({
      repo: REPO,
      dataDir,
      terminals: 'none',
      args: ['--test-no-activate']
    })
    let cliPid = null
    try {
      const { connectThroughNode } = await import('../packages/client/src/node')
      const backing = await connectThroughNode(
        { url: server.url, token: server.token },
        { client: 'server-process-test' }
      )
      backing.push.connect()
      await backing.push.whenOpen()
      const chat = await backing.api.sessions.start({
        cwd: dataDir,
        windowKey: 'w1',
        options: { launchProfileId: 'chat:claude:fake' }
      })
      backing.push.subscribe(chat.id, () => {})
      await backing.push.subscribed(chat.id)
      // The CLI starts on the first message.
      await backing.api.sessions.write(chat.id, { type: 'user_message', text: 'hello' })
      const started = async () => {
        const end = Date.now() + 10_000
        while (Date.now() < end) {
          if (existsSync(pidFile)) {
            const n = Number(readFileSync(pidFile, 'utf8').trim())
            if (n > 0) return n
          }
          await new Promise((r) => setTimeout(r, 100))
        }
        return null
      }
      cliPid = await started()
      expect(cliPid, 'the fake CLI started').not.toBeNull()
      expect(alive(cliPid)).toBe(true)
      const tree = () =>
        execFileSync('ps', ['-o', 'pid,ppid,pgid,sess,command', '-p', `${server.pid},${cliPid}`], {
          encoding: 'utf8'
        }).trim()
      const before = tree()
      backing.push.close()
      await backing.api.dispose()
      await server.stop()
      expect(await untilDead(server.pid)).toBe(true)
      const died = await untilDead(cliPid)
      expect(
        died,
        `the CLI died with the server\nbefore:\n${before}\nafter:\n${died ? '' : tree()}\nserver stderr:\n${server
          .stderr()
          .split('\n')
          .filter(Boolean)
          .slice(-8)
          .join('\n')}`
      ).toBe(true)
    } finally {
      if (cliPid && alive(cliPid)) {
        try {
          process.kill(cliPid, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('a server that misses its announce timeout is killed, not left running', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'clave-server-process-late-'))
    try {
      const err = await startServerProcess({
        repo: REPO,
        dataDir,
        timeoutMs: 1,
        terminals: 'none'
      }).catch((e) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/did not announce itself/)
      expect(typeof err.pid).toBe('number')
      // Gone AT the rejection, not some time after: a caller that removes its
      // data directory on the rejection must find nothing still writing there.
      expect(alive(err.pid)).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

const ready = async (url) => (await fetch(`${url}/health/ready`)).json()

describe('the commands the starter names', () => {
  it.skipIf(!built)(
    'the terminal process is told its parent and its port, and the token never rides the command line',
    () => {
      const { cmd, args } = terminalProcessCommand({ repo: REPO, port: 0, parent: 4242 })
      expect(cmd).toBe(process.execPath)
      expect(args).toEqual([BUNDLE, '--port', '0', '--parent', '4242'])
    }
  )

  it('the server is told the terminal process address and nothing of its token', () => {
    const { args } = serverCommand({
      repo: REPO,
      dataDir: '/tmp/x',
      terminals: '127.0.0.1:5',
      env: { PATH: '', CLAVE_BUN: '/usr/bin/true' }
    })
    expect(args.slice(-2)).toEqual(['--terminals', '127.0.0.1:5'])
    expect(args.join(' ')).not.toMatch(/token/i)
    expect(
      serverCommand({
        repo: REPO,
        dataDir: '/tmp/x',
        env: { PATH: '', CLAVE_BUN: '/usr/bin/true' }
      }).args
    ).not.toContain('--terminals')
  })

  it.skipIf(!built)(
    'the server is told the terminal process bundle to start, the Node to run it under, and its parent',
    () => {
      const { args } = serverCommand({
        repo: REPO,
        dataDir: '/tmp/x',
        terminalProcess: BUNDLE,
        parent: 4242,
        env: { PATH: '', CLAVE_BUN: '/usr/bin/true' }
      })
      expect(args).toContain('--terminal-process')
      expect(args[args.indexOf('--terminal-process') + 1]).toBe(BUNDLE)
      // Bun cannot run node-pty: the server is told this process's Node.
      expect(args[args.indexOf('--node') + 1]).toBe(process.execPath)
      expect(args[args.indexOf('--parent') + 1]).toBe('4242')
      expect(args.join(' ')).not.toMatch(/token/i)
    }
  )

  it('a terminal process bundle that is not there is refused before anything starts, naming the build', () => {
    expect(() =>
      serverCommand({
        repo: REPO,
        dataDir: '/tmp/x',
        terminalProcess: '/nowhere/terminal-process.js',
        env: { PATH: '', CLAVE_BUN: '/usr/bin/true' }
      })
    ).toThrow(/electron-vite build/)
  })
})

/** Wait until `fn` answers something truthy, at most `ms`; the last answer otherwise. */
const untilTruthy = async (fn, ms = 10_000) => {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    last = await fn()
    if (last) return last
    await new Promise((r) => setTimeout(r, 100))
  }
  return last
}

// Each start is two processes (Bun, which starts the Node terminal process)
// announcing themselves: under a loaded suite that is seconds, so every case
// here gets twenty.
describe.skipIf(!built)('the terminal process beside the server (from the built bundle)', () => {
  it('the server starts its terminal process, reports it ready, and stops both', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'clave-server-terminals-'))
    let server
    let tpPid
    try {
      server = await startServerProcess({ repo: REPO, dataDir })
      expect(server.terminalProcess.address()).toMatch(/^127\.0\.0\.1:\d+$/)
      tpPid = server.terminalProcess.pid()
      expect(tpPid).toBeGreaterThan(0)
      expect(alive(tpPid)).toBe(true)
      expect(await ready(server.url)).toEqual({
        ready: true,
        checks: [{ name: 'terminals', ok: true }]
      })
      // The process was started by the server, with the server as its parent.
      const ppid = Number(
        execFileSync('ps', ['-o', 'ppid=', '-p', String(tpPid)], { encoding: 'utf8' }).trim()
      )
      expect(ppid).toBe(server.pid)
    } finally {
      // Stopped whatever the assertions said: a failing test must leave no
      // Bun server behind.
      await server?.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
    expect(await untilDead(server.pid)).toBe(true)
    expect(await untilDead(tpPid)).toBe(true)
  }, 20_000)

  // Wave 5, lane C (PRDCT-3433): the plugins are the server's. The entry
  // builds its service over the checkout's plugins/ and forks each plugin's
  // main under Node IPC; this is the one unit check of that wiring (the
  // port handed to the server, the runner path, the runner's first message),
  // which the suite otherwise only reached through the app.
  it('answers its bundled plugins, the chat view and the GitHub panel active in forked runners', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'clave-server-plugins-'))
    let server
    try {
      // Test mode keeps the plugins under the data dir, never in ~/.clave.
      server = await startServerProcess({ repo: REPO, dataDir, args: ['--test-no-activate'] })
      const headers = { authorization: `Bearer ${server.token}` }
      let records = []
      const end = Date.now() + 15_000
      while (Date.now() < end) {
        const response = await fetch(`${server.url}/plugins`, { headers })
        expect(response.status).toBe(200)
        records = await response.json()
        if (records.filter((r) => r.status === 'active').length >= 2) break
        await new Promise((r) => setTimeout(r, 250))
      }
      const byId = Object.fromEntries(records.map((r) => [r.id, r]))
      expect(Object.keys(byId).sort()).toEqual([
        'clave.chat-view',
        'clave.echo-provider',
        'clave.github',
        'clave.hello'
      ])
      expect(byId['clave.chat-view']).toMatchObject({
        enabled: true,
        status: 'active',
        source: 'bundled'
      })
      expect(byId['clave.github']).toMatchObject({ enabled: true, status: 'active' })
      expect(byId['clave.hello']).toMatchObject({ enabled: false, status: 'disabled' })
      expect(byId['clave.chat-view'].error).toBeUndefined()
    } finally {
      await server?.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
    expect(await untilDead(server.pid)).toBe(true)
  }, 30_000)

  it('a terminal process killed under the server is started again: not ready in between, ready after, a new pid', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'clave-server-terminals-killed-'))
    let server
    let second
    try {
      server = await startServerProcess({ repo: REPO, dataDir })
      const first = server.terminalProcess.pid()
      const firstAddress = server.terminalProcess.address()
      process.kill(first, 'SIGKILL')
      expect(await untilDead(first)).toBe(true)
      // The new process: a new pid in the discovery file, generation 2.
      second = await untilTruthy(() => {
        const pid = server.terminalProcess.pid()
        return pid && pid !== first ? pid : null
      })
      expect(second, `a new terminal process after the kill\n${server.stderr()}`).toBeTruthy()
      expect(alive(second)).toBe(true)
      expect(readServerDiscovery(dataDir).terminalProcessGeneration).toBe(2)
      expect(server.terminalProcess.address()).not.toBe(firstAddress)
      // Readiness answers ready again on the new process.
      const readyAgain = await untilTruthy(async () => {
        const answer = await ready(server.url)
        return answer.ready ? answer : null
      })
      expect(readyAgain).toEqual({ ready: true, checks: [{ name: 'terminals', ok: true }] })
      expect(server.stderr()).toMatch(/terminal process \d+ lost: it exited/)
      expect(server.stderr()).toMatch(/starting a new terminal process/)
      // The server itself kept answering throughout.
      expect((await fetch(`${server.url}/health/live`)).status).toBe(200)
    } finally {
      await server?.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
    expect(await untilDead(server.pid)).toBe(true)
    if (second) expect(await untilDead(second)).toBe(true)
  }, 20_000)

  it('the server ends on its own when the parent it was given is gone, and its terminal process with it', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'clave-server-parent-gone-'))
    // A parent that lives 500 ms: the server, told its pid, must stop once
    // it is gone (polled every two seconds), and the terminal process must
    // follow (it polls the server).
    const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)'])
    const parentGone = new Promise((resolve) => parent.once('exit', resolve))
    const { cmd, args } = serverCommand({
      repo: REPO,
      dataDir,
      terminalProcess: BUNDLE,
      parent: parent.pid
    })
    const child = spawn(cmd, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d
    })
    try {
      const announced = await new Promise((resolve) =>
        child.stdout.once('data', (d) => resolve(JSON.parse(String(d).split('\n')[0])))
      )
      expect(announced.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const tpPid = readServerDiscovery(dataDir)?.terminalProcessPid
      expect(tpPid).toBeGreaterThan(0)
      await parentGone
      expect(await untilDead(child.pid, 8_000)).toBe(true)
      expect(stderr).toMatch(new RegExp(`parent ${parent.pid} is gone, stopping`))
      expect(await untilDead(tpPid, 8_000)).toBe(true)
    } finally {
      if (alive(child.pid)) child.kill('SIGKILL')
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 20_000)

  it('the terminal process ends on its own when the parent it was given is gone', async () => {
    // A parent that lives 200 ms; the process, told its pid, must stop
    // once it is gone (polled every two seconds), with nobody to tell it.
    const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)'])
    // The parent is gone before the process has announced itself: its
    // exit is awaited from here, not from after the announcement.
    const parentGone = new Promise((resolve) => parent.once('exit', resolve))
    const child = spawn(process.execPath, [BUNDLE, '--port', '0', '--parent', String(parent.pid)], {
      env: { ...process.env, CLAVE_TERMINALS_TOKEN: 'a-token' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d
    })
    const announced = await new Promise((resolve) =>
      child.stdout.once('data', (d) => resolve(JSON.parse(String(d).split('\n')[0])))
    )
    expect(announced.address).toMatch(/^127\.0\.0\.1:\d+$/)
    await parentGone
    expect(await untilDead(child.pid, 8_000)).toBe(true)
    expect(stderr).toMatch(new RegExp(`parent ${parent.pid} is gone, stopping`))
  }, 15_000)

  it('a terminal spawned from Bun through the port streams its bytes, takes a write, and carries its exit', async () => {
    const started = await startTerminalProcess({ repo: REPO })
    try {
      const line = await new Promise((resolve, reject) => {
        execFile(
          bunBinary(process.env, REPO),
          [
            path.join(REPO, 'src', 'main', 'terminal-process', 'probe.ts'),
            '--address',
            started.address,
            '--token',
            started.token
          ],
          { cwd: REPO, timeout: 20_000 },
          (err, stdout, stderr) =>
            err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)
        )
      })
      const answer = JSON.parse(line)
      expect(answer.pid).toBeGreaterThan(0)
      expect(answer.output).toContain('got:ping')
      expect(answer.exit).toEqual({ exitCode: 7 })
    } finally {
      await started.stop()
    }
  }, 20_000)
})

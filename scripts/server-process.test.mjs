/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test of a plain JS script */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import {
  bunBinary,
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
    writeFileSync(fake, `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 300\n`, { mode: 0o755 })
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
      backing.push.close()
      await backing.api.dispose()
      await server.stop()
      expect(await untilDead(server.pid)).toBe(true)
      expect(await untilDead(cliPid), 'the CLI died with the server').toBe(true)
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
})

// Each start is two processes (Node, then Bun) announcing themselves: under
// a loaded suite that is seconds, so every case here gets twenty.
describe.skipIf(!built)('the terminal process beside the server (from the built bundle)', () => {
  it('the server starts after its terminal process, reports it ready, and stops both', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'clave-server-terminals-'))
    let server
    try {
      server = await startServerProcess({ repo: REPO, dataDir })
      expect(server.terminalProcess.address).toMatch(/^127\.0\.0\.1:\d+$/)
      expect(alive(server.terminalProcess.pid)).toBe(true)
      expect(await ready(server.url)).toEqual({
        ready: true,
        checks: [{ name: 'terminals', ok: true }]
      })
    } finally {
      // Stopped whatever the assertions said: a failing test must leave no
      // Bun server behind (the server has no parent watch of its own).
      await server?.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
    expect(await untilDead(server.pid)).toBe(true)
    expect(await untilDead(server.terminalProcess.pid)).toBe(true)
  }, 20_000)

  it('a terminal process killed under the server is reported by the server as not ready', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'clave-server-terminals-killed-'))
    let server
    try {
      server = await startServerProcess({ repo: REPO, dataDir })
      process.kill(server.terminalProcess.pid, 'SIGKILL')
      await server.terminalProcess.exited
      expect(await ready(server.url)).toEqual({
        ready: false,
        checks: [{ name: 'terminals', ok: false }]
      })
      expect(server.stderr()).toMatch(/the terminal process at 127\.0\.0\.1:\d+ is gone/)
      // The server itself is still answering.
      expect((await fetch(`${server.url}/health/live`)).status).toBe(200)
    } finally {
      await server?.stop()
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

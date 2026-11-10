/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by vitest */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DAEMON_FLAGS,
  MANIFEST_NAME,
  OWNER,
  REDIRECTS,
  RUN_FOLDER_MARKER,
  RUN_FOLDER_OWNER,
  proveFixture,
  proveNoProvider,
  recorderLines,
  startFixture
} from './scripts/fixture-server.mjs'

/* The fixture server both native phones are tested against, BOOTED here on
   free ports in a folder of this run's own: the two pre-boot checks, then the
   provider on the port the test named, the relay and this checkout's daemon
   under Bun with the three flags that keep it off every provider, the three
   post-boot checks, the daemon signed in as the fixture owner and listed by
   the relay, the Echo chat seeded. Then the same proof `--check` runs:
   nothing reached a provider for the seeded chat (the recorders silent, no
   title event, no transcript, no usage event), the explicit usage reads kept
   off (Claude) and caught (Codex), a fixture-issued token pairs and reaches
   the sessions directly and through the relay, five tampered tokens are
   refused by the check's name, both redirect schemes register. The manifest
   and the printed lines carry the token's path and never the token. More
   boots, one per mutation, prove the proof goes red, none of them with the
   usage flags dropped: without the title opt-out the first and third checks
   fail and the recorder catches the one-shot; with the guard bypassed through
   the test hook the daemon still announces titles off and the recorder alone
   catches it; with the usage clock started the recorder and the push channel
   catch the reads; with a PATH without the recorders the second check aborts
   before any process; a daemon handed another PATH, or another home of the
   fixture's own, is refused by the fifth or the seventh check before any
   chat.

   Every case here starts this checkout's daemon, a relay and the provider,
   and most seed an Echo chat, so they run only on purpose: with
   CLAVE_FIXTURE_BOOT=1, which the CI steps set. A name filter that widens, a
   run of the folder or of the whole suite never boots them by accident; on CI
   without the variable, the first case fails rather than let them skip. The
   parts that start nothing are in fixture-server.test.mjs. */

const SCRIPT = fileURLToPath(new URL('./scripts/fixture-server.mjs', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

/** The booted cases run only on purpose: CLAVE_FIXTURE_BOOT=1. */
const BOOT = process.env.CLAVE_FIXTURE_BOOT === '1'

describe('the fixture server, booted only on purpose', () => {
  it('runs on CI: a CI step without CLAVE_FIXTURE_BOOT=1 fails here rather than skip the boots', () => {
    expect(BOOT || process.env.CI !== 'true', 'set CLAVE_FIXTURE_BOOT=1 on this CI step').toBe(true)
  })
})

describe.runIf(BOOT)('the fixture server', () => {
  const folders = []
  const fixtures = []
  const tmp = (name) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `clave-native-fixture-${name}-`))
    folders.push(dir)
    return dir
  }
  afterAll(async () => {
    for (const fixture of fixtures) await fixture.stop()
    for (const dir of folders) rmSync(dir, { recursive: true, force: true })
  })

  it('passes its two pre-boot checks, boots the provider on the named port, passes its five post-boot checks, signs the daemon in, lists it on the relay, seeds the chat, and the whole proof passes', async () => {
    const lines = []
    const tmpdir = tmp('test')
    const issuerPort = await freePort()
    const fixture = await startFixture({
      ports: { server: 0, relay: 0, issuer: issuerPort },
      tmpdir,
      log: (line) => lines.push(line)
    })
    fixtures.push(fixture)
    expect(fixture.provider.port).toBe(issuerPort)
    expect(fixture.provider.issuer).toBe(`http://127.0.0.1:${issuerPort}`)
    expect(fixture.machine.online).toBe(true)
    expect(fixture.seed.text).toMatch(/^seeded-[0-9a-f]{8}$/)
    expect(fixture.checks.map((c) => [c.stage, c.kind, c.ok])).toEqual([
      ['preflight', 'argv', true],
      ['preflight', 'observed', true],
      ['boot', 'announced', true],
      ['boot', 'announced', true],
      ['boot', 'observed', true],
      ['boot', 'observed', true],
      ['boot', 'observed', true]
    ])
    // The daemon's environment, by key names: the allowlist's that this shell
    // had, the fixture's own, nothing else (the sixth check compares the lists).
    expect(fixture.checks[5].detail).toMatch(/^\d+ keys: /)
    for (const key of [
      'HOME',
      'SHELL',
      'PATH',
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'CLAVE_ANTASPHERE_ISSUER'
    ])
      expect(fixture.checks[5].detail).toContain(key)
    // Its home, asked of the daemon itself: the fixture's folder.
    expect(fixture.checks[6].detail).toBe('os.homedir() and HOME are stubs/home')
    expect(fixture.server.env.HOME).toBe(fixture.stubs.home)
    expect(readFileSync(path.join(tmpdir, RUN_FOLDER_MARKER), 'utf8')).toBe(RUN_FOLDER_OWNER)
    expect(fixture.server.discovery).toMatchObject({
      titles: 'off',
      testMode: true,
      machineUsage: false
    })
    expect(fixture.server.env.CLAVE_ANTASPHERE_ISSUER).toBe(fixture.provider.issuer)

    const printed = fixture.lines()
    expect(Object.keys(printed)).toEqual([
      'CLAVE_FIXTURE_SERVER_URL',
      'CLAVE_FIXTURE_TOKEN_FILE',
      'CLAVE_FIXTURE_RELAY_URL',
      'CLAVE_FIXTURE_ISSUER_URL',
      'CLAVE_FIXTURE_MACHINE_ID',
      'CLAVE_FIXTURE_WORKSPACE_ID',
      'CLAVE_FIXTURE_SESSION_ID',
      'CLAVE_FIXTURE_NONCE',
      'CLAVE_FIXTURE_RECORDER_LOG',
      'CLAVE_FIXTURE_FILE'
    ])
    const token = readFileSync(printed.CLAVE_FIXTURE_TOKEN_FILE, 'utf8').trim()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(printed)).not.toContain(token)
    const manifest = readFileSync(path.join(tmpdir, MANIFEST_NAME), 'utf8')
    expect(manifest).not.toContain(token)
    expect(JSON.parse(manifest)).toMatchObject({
      v: 1,
      machineId: fixture.machine.id,
      issuer: { owner: { sub: OWNER.sub }, redirects: REDIRECTS },
      session: { id: fixture.seed.id, nonce: fixture.seed.nonce },
      server: {
        flags: DAEMON_FLAGS,
        announces: { titles: 'off', testMode: true, machineUsage: false }
      },
      stubs: { home: fixture.stubs.home },
      mutation: null
    })
    expect(lines.join('\n')).not.toContain(token)

    const results = await proveFixture(fixture, { log: (line) => lines.push(line) })
    const failed = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)
    expect(failed).toEqual([])
    expect(results.length).toBe(24)
    expect(results.slice(0, 6).map((r) => r.kind)).toEqual([
      'recorder',
      'wire',
      'owned-folders',
      'wire',
      'wire',
      'recorder'
    ])
    expect(results.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        'the recorders saw no claude and no codex since the boot, the seeded chat included',
        'an explicit Codex usage read reaches the codex recorder, exactly one line, and answers an error',
        'a token tampered on the audience is refused by the check named audience',
        'a token tampered on the signature is refused by the check named signature',
        'a token tampered on the issuer is refused by the check named issuer',
        'a token tampered on the subject is refused by the check named subject',
        'a token tampered on the expired is refused by the check named expired'
      ])
    )
    // After the proof the recorder holds the one explicit Codex read and nothing else.
    const recorded = recorderLines(fixture.stubs)
    expect(recorded.length).toBe(1)
    expect(recorded[0]).toMatch(/ codex app-server /)
  }, 240_000)

  it('goes red without the title opt-out: the flags check and the announcement fail, and the recorder catches the one-shot', async () => {
    const fixture = await startFixture({
      ports: { server: 0, relay: 0, issuer: 0 },
      tmpdir: tmp('no-opt-out'),
      mutate: 'drop-title-opt-out',
      log: () => {}
    })
    fixtures.push(fixture)
    expect(fixture.checks[0]).toMatchObject({ stage: 'preflight', kind: 'argv', ok: false })
    expect(fixture.checks[0].detail).toMatch(/missing --no-titles/)
    expect(fixture.checks[2]).toMatchObject({ stage: 'boot', kind: 'announced', ok: false })
    expect(fixture.checks[2].detail).toMatch(/titles "on"/)
    expect(fixture.server.flags).toEqual(['--test-no-activate', '--test-no-machine-usage'])
    const results = await proveNoProvider(fixture, { log: () => {} })
    const recorder = results.find((r) => r.name.startsWith('the recorders saw no claude'))
    expect(recorder.ok).toBe(false)
    expect(recorder.detail).toMatch(/ claude -p /)
    const named = results.find((r) => r.name === 'the seeded chat was not named by a one-shot')
    expect(named.ok).toBe(false)
    expect(named.detail).toMatch(/named the chat "fixture chat"/)
  }, 240_000)

  it('goes red with the guard bypassed through the test hook: every check passes, the daemon still announces titles off, and the recorder alone catches the one-shot', async () => {
    const fixture = await startFixture({
      ports: { server: 0, relay: 0, issuer: 0 },
      tmpdir: tmp('bypass'),
      mutate: 'bypass-title-guard',
      log: () => {}
    })
    fixtures.push(fixture)
    expect(fixture.checks.every((c) => c.ok)).toBe(true)
    expect(fixture.server.flags).toEqual(DAEMON_FLAGS)
    expect(fixture.server.discovery.titles).toBe('off')
    const results = await proveNoProvider(fixture, { log: () => {} })
    const recorder = results.find((r) => r.name.startsWith('the recorders saw no claude'))
    expect(recorder.ok).toBe(false)
    expect(recorder.detail).toMatch(/ claude -p /)
    const named = results.find((r) => r.name === 'the seeded chat was not named by a one-shot')
    expect(named.ok).toBe(false)
    expect(named.detail).toMatch(/named the chat "fixture chat"/)
    // The owned folders stay empty: the one-shot reached the recorder, never a real claude.
    const owned = results.find((r) => r.kind === 'owned-folders')
    expect(owned.ok).toBe(true)
  }, 240_000)

  it('goes red with the usage clock running: the codex recorder and the push channel catch the reads, every flag kept', async () => {
    const fixture = await startFixture({
      ports: { server: 0, relay: 0, issuer: 0 },
      tmpdir: tmp('clock'),
      mutate: 'start-usage-clock',
      log: () => {}
    })
    fixtures.push(fixture)
    expect(fixture.checks.every((c) => c.ok)).toBe(true)
    expect(fixture.server.flags).toEqual(DAEMON_FLAGS)
    const results = await proveNoProvider(fixture, { log: () => {} })
    const clock = results.find((r) => r.name.startsWith('the usage clock did not run'))
    expect(clock.ok).toBe(false)
    // Both halves of the row are told: what the recorder saw and what the push channel heard.
    expect(clock.detail).toMatch(/codex invoked: .* codex app-server /)
    expect(clock.detail).toMatch(/usage events heard: /)
    // The Claude side stays off the machine login even with the clock running: no claude line.
    expect(recorderLines(fixture.stubs).some((l) => l.includes(' claude '))).toBe(false)
  }, 240_000)

  it('refuses to boot with a PATH without the recorders: the second check aborts before any process', async () => {
    let error = null
    try {
      await startFixture({
        ports: { server: 0, relay: 0, issuer: 0 },
        tmpdir: tmp('no-recorders'),
        mutate: 'drop-recorders',
        log: () => {}
      })
    } catch (e) {
      error = e
    }
    expect(error).not.toBeNull()
    expect(error.message).toMatch(/refuses to boot, before any daemon/)
    expect(error.checks).toHaveLength(2)
    expect(error.checks[1]).toMatchObject({ stage: 'preflight', kind: 'observed', ok: false })
    expect(error.checks[1].detail).toMatch(/claude resolves to/)
  }, 240_000)

  it('refuses to boot a daemon whose environment is not the one checked: the fifth check, asked of the daemon itself, fails before any chat', async () => {
    let error = null
    try {
      await startFixture({
        ports: { server: 0, relay: 0, issuer: 0 },
        tmpdir: tmp('divergent'),
        mutate: 'divergent-daemon-env',
        log: () => {}
      })
    } catch (e) {
      error = e
    }
    expect(error).not.toBeNull()
    expect(error.message).toMatch(/refuses to boot, before any chat/)
    expect(error.checks).toHaveLength(7)
    expect(error.checks.slice(0, 4).every((c) => c.ok)).toBe(true)
    expect(error.checks[4]).toMatchObject({ stage: 'boot', kind: 'observed', ok: false })
    // The login PATH comes from the stand-in, the same whatever the daemon is
    // handed: the divergent PATH shows in the daemon's own environment.
    expect(error.checks[4].detail).toMatch(/the daemon's own PATH does not start with/)
  }, 240_000)

  it('refuses to boot a daemon whose home is not the one checked: the seventh check, asked of the daemon itself, fails before any chat', async () => {
    let error = null
    try {
      await startFixture({
        ports: { server: 0, relay: 0, issuer: 0 },
        tmpdir: tmp('elsewhere-home'),
        mutate: 'divergent-home',
        log: () => {}
      })
    } catch (e) {
      error = e
    }
    expect(error).not.toBeNull()
    expect(error.message).toMatch(/refuses to boot, before any chat/)
    expect(error.checks).toHaveLength(7)
    expect(error.checks.slice(0, 6).every((c) => c.ok)).toBe(true)
    expect(error.checks[6]).toMatchObject({ stage: 'boot', kind: 'observed', ok: false })
    expect(error.checks[6].detail).toMatch(
      /os\.homedir\(\) inside the daemon is not the fixture's home/
    )
  }, 240_000)

  it('while running, the first recorder line stops the three processes with exit code 3: the recorder itself run with -p, never a CLI', async () => {
    const dir = tmp('running')
    const child = spawn(
      process.execPath,
      [SCRIPT, '--server', '0', '--relay', '0', '--issuer', '0', '--tmpdir', dir],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    const exited = new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve(code ?? signal))
    )
    try {
      const deadline = Date.now() + 180_000
      while (!out.includes('fixture: running') && child.exitCode === null && Date.now() < deadline)
        await sleep(200)
      expect(out, err.slice(-3000)).toContain('fixture: running')
      expect(err).toMatch(/check ok {4}inside the running daemon, the environment's keys/)
      const manifest = JSON.parse(readFileSync(path.join(dir, MANIFEST_NAME), 'utf8'))
      expect(alive(manifest.server.pid)).toBe(true)
      expect(alive(manifest.relay.pid)).toBe(true)
      // The negative: a foreign line in the recorder log, written by the recorder itself.
      execFileSync(path.join(dir, 'stubs', 'claude'), ['-p', 'a foreign line'], {
        input: 'a prompt the recorder drops',
        stdio: ['pipe', 'ignore', 'ignore']
      })
      const code = await exited
      expect(code).toBe(3)
      expect(err).toMatch(
        /the recorder caught an attempt while running; stopping: .* claude -p a foreign line/
      )
      expect(alive(manifest.server.pid)).toBe(false)
      expect(alive(manifest.relay.pid)).toBe(false)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGINT')
        await exited
      }
    }
  }, 240_000)
})

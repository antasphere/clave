/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by vitest */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DAEMON_FLAGS,
  MANIFEST_NAME,
  MUTATIONS,
  OWNER,
  REDIRECTS,
  flagsFor,
  parseArgs,
  proveFixture,
  proveNoProvider,
  POSIX_SHELL_NAMES,
  RECORDER_LOG_NAME,
  REPO,
  RUN_FOLDER_MARKER,
  RUN_FOLDER_OWNER,
  claimRunFolder,
  installStubs,
  recorderLines,
  shellStandsIn,
  startFixture,
  watchRecorder
} from './scripts/fixture-server.mjs'

/* The fixture server both native phones are tested against, booted here on
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
   and the printed lines carry the token's path and never the token. Four more
   boots, one per mutation, prove the proof goes red, none of them with the
   usage flags dropped: without the title opt-out the first and third checks
   fail and the recorder catches the one-shot; with the guard bypassed through
   the test hook the daemon still announces titles off and the recorder alone
   catches it; with the usage clock started the recorder and the push channel
   catch the reads; with a PATH without the recorders the second check aborts
   before any process. `--preflight` runs the two pre-boot checks alone. */

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
/** The files of a folder, one level deep, with their bytes and their mtimes: equal when nothing was rewritten. */
const snapshot = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const file = path.join(dir, entry.name)
      return entry.isDirectory()
        ? [entry.name, 'dir', readdirSync(file).sort()]
        : [entry.name, readFileSync(file, 'utf8'), statSync(file).mtimeMs]
    })

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

describe('parseArgs', () => {
  it('reads the band, the folder and the flags, and refuses what it does not know', () => {
    expect(
      parseArgs([
        '--server',
        '47301',
        '--relay=47302',
        '--issuer',
        '47303',
        '--tmpdir',
        '/tmp/x',
        '--approve',
        '--check',
        '--json'
      ])
    ).toEqual({
      ports: { server: 47301, relay: 47302, issuer: 47303 },
      tmpdir: '/tmp/x',
      timeoutMs: 90_000,
      approve: true,
      check: true,
      preflight: false,
      json: true,
      mutate: null
    })
    expect(parseArgs([]).ports).toEqual({ server: 0, relay: 0, issuer: 0 })
    expect(parseArgs(['--preflight']).preflight).toBe(true)
    expect(parseArgs(['--mutate', 'drop-recorders']).mutate).toBe('drop-recorders')
    expect(() => parseArgs(['--mutate', 'everything'])).toThrow(/--mutate takes one of/)
    expect(() => parseArgs(['--server', '70000'])).toThrow(/--server must be 0..65535/)
    expect(() => parseArgs(['--port', '1'])).toThrow(/unknown option --port/)
    expect(() => parseArgs(['--tmpdir'])).toThrow(/--tmpdir needs a value/)
  })

  it('names the three flags and the five mutations, and drops a flag for one mutation only', () => {
    expect(DAEMON_FLAGS).toEqual(['--no-titles', '--test-no-activate', '--test-no-machine-usage'])
    expect(MUTATIONS).toEqual([
      'drop-title-opt-out',
      'bypass-title-guard',
      'start-usage-clock',
      'divergent-daemon-env',
      'drop-recorders'
    ])
    expect(flagsFor(null)).toEqual(DAEMON_FLAGS)
    expect(flagsFor('drop-title-opt-out')).toEqual([
      '--test-no-activate',
      '--test-no-machine-usage'
    ])
    for (const m of [
      'bypass-title-guard',
      'start-usage-clock',
      'divergent-daemon-env',
      'drop-recorders'
    ])
      expect(flagsFor(m), m).toEqual(DAEMON_FLAGS)
  })
})

describe('--preflight', () => {
  it('runs the two pre-boot checks on the stubs and exits 0, no process started', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clave-native-preflight-'))
    try {
      const run = spawnSync(process.execPath, [SCRIPT, '--preflight', '--tmpdir', dir], {
        encoding: 'utf8'
      })
      expect(run.status, run.stderr).toBe(0)
      expect(run.stdout.trim()).toBe('preflight: 2 checks, 0 failed')
      expect(run.stderr).toMatch(/check ok {4}flags: the daemon's argv carries/)
      expect(run.stderr).toMatch(/check ok {4}the recorders stand in/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exits 2 when the recorders are not on the PATH the daemon would get', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clave-native-preflight-'))
    try {
      const run = spawnSync(
        process.execPath,
        [SCRIPT, '--preflight', '--tmpdir', dir, '--mutate', 'drop-recorders'],
        { encoding: 'utf8' }
      )
      expect(run.status).toBe(2)
      expect(run.stdout.trim()).toBe('preflight: 2 checks, 1 failed')
      expect(run.stderr).toMatch(/check FAIL {2}the recorders stand in/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a dry run on a folder it already owns rewrites nothing: same bytes, same mtimes, the recorder log kept', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clave-native-preflight-'))
    try {
      const first = spawnSync(process.execPath, [SCRIPT, '--preflight', '--tmpdir', dir], {
        encoding: 'utf8'
      })
      expect(first.status, first.stderr).toBe(0)
      expect(readFileSync(path.join(dir, RUN_FOLDER_MARKER), 'utf8')).toBe(RUN_FOLDER_OWNER)
      writeFileSync(path.join(dir, 'stubs', RECORDER_LOG_NAME), 'a line of an earlier run\n')
      const before = snapshot(path.join(dir, 'stubs'))
      const second = spawnSync(process.execPath, [SCRIPT, '--preflight', '--tmpdir', dir], {
        encoding: 'utf8'
      })
      expect(second.status, second.stderr).toBe(0)
      expect(second.stdout.trim()).toBe('preflight: 2 checks, 0 failed')
      expect(snapshot(path.join(dir, 'stubs'))).toEqual(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a folder it does not own, exit 2, before writing a byte', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clave-native-preflight-'))
    try {
      writeFileSync(path.join(dir, 'not-the-fixtures.txt'), 'x')
      const run = spawnSync(process.execPath, [SCRIPT, '--preflight', '--tmpdir', dir], {
        encoding: 'utf8'
      })
      expect(run.status).toBe(2)
      expect(run.stderr).toMatch(
        /refusing the run folder .*: it is not empty and carries no \.clave-native-fixture/
      )
      expect(readdirSync(dir)).toEqual(['not-the-fixtures.txt'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the run folder', () => {
  const dirs = []
  const scratch = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clave-native-runfolder-'))
    dirs.push(dir)
    return dir
  }
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('claims a missing or an empty folder and marks it: a regular file, mode 600, the exact stamp', () => {
    const root = path.join(scratch(), 'fresh')
    const claim = claimRunFolder(root)
    expect(claim.fresh).toBe(true)
    const marker = lstatSync(claim.marker)
    expect(marker.isFile()).toBe(true)
    expect(marker.isSymbolicLink()).toBe(false)
    expect(marker.mode & 0o777).toBe(0o600)
    expect(readFileSync(claim.marker, 'utf8')).toBe(RUN_FOLDER_OWNER)
    expect(RUN_FOLDER_OWNER).toMatch(/^clave-native-fixture-server\/1 \/.+\n$/)
    expect(claimRunFolder(root).fresh).toBe(false)
  })

  it('refuses a non-empty folder without the marker, touching nothing in it', () => {
    const root = scratch()
    writeFileSync(path.join(root, 'someone-elses-file'), 'x')
    expect(() => claimRunFolder(root)).toThrow(
      /refusing the run folder .*: it is not empty and carries no \.clave-native-fixture/
    )
    expect(readdirSync(root)).toEqual(['someone-elses-file'])
  })

  it('refuses a marker that is a symlink, even one pointing at a file holding the stamp', () => {
    const root = scratch()
    const stamp = path.join(scratch(), 'stamp')
    writeFileSync(stamp, RUN_FOLDER_OWNER)
    symlinkSync(stamp, path.join(root, RUN_FOLDER_MARKER))
    expect(() => claimRunFolder(root)).toThrow(/\.clave-native-fixture is not a regular file/)
  })

  it('refuses a marker naming another owner', () => {
    const root = scratch()
    writeFileSync(
      path.join(root, RUN_FOLDER_MARKER),
      'clave-native-fixture-server/1 /somewhere/else/entirely\n'
    )
    expect(() => claimRunFolder(root)).toThrow(/\.clave-native-fixture names another owner/)
  })

  it('refuses a root that is a symlink, even to a directory', () => {
    const real = scratch()
    const link = path.join(scratch(), 'link')
    symlinkSync(real, link)
    expect(() => claimRunFolder(link)).toThrow(/it is a symlink/)
    expect(readdirSync(real)).toEqual([])
  })

  it('an install reused is taken as it is, and a boot install starts the log and the owned folders over', () => {
    const root = scratch()
    claimRunFolder(root)
    const stubs = installStubs(path.join(root, 'stubs'))
    expect(readFileSync(stubs.log, 'utf8')).toBe('')
    expect((statSync(stubs.log).mode & 0o777).toString(8)).toBe('600')
    writeFileSync(stubs.log, 'a line of an earlier run\n')
    writeFileSync(path.join(stubs.claudeConfigDir, 'left-behind'), 'x')
    const before = snapshot(stubs.dir)
    expect(installStubs(path.join(root, 'stubs'), { reuse: true })).toEqual(stubs)
    expect(snapshot(stubs.dir)).toEqual(before)
    installStubs(path.join(root, 'stubs'))
    expect(readFileSync(stubs.log, 'utf8')).toBe('')
    expect(readdirSync(stubs.claudeConfigDir)).toEqual([])
  })

  it('a recorder log that is missing is a failure to read, never "no calls"', () => {
    const root = scratch()
    claimRunFolder(root)
    const stubs = installStubs(path.join(root, 'stubs'))
    expect(recorderLines(stubs)).toEqual([])
    rmSync(stubs.log)
    expect(() => recorderLines(stubs)).toThrow(/ENOENT/)
  })

  it('the running watch hands over the first recorder lines, or the failure of a read, once', async () => {
    const root = scratch()
    claimRunFolder(root)
    const stubs = installStubs(path.join(root, 'stubs'))
    const seen = []
    const watch = watchRecorder(
      stubs,
      (lines, error) => seen.push({ lines, error: error?.code ?? null }),
      20
    )
    await sleep(80)
    expect(seen).toEqual([])
    // The recorder itself, never a CLI: one line in the log.
    execFileSync(stubs.codex, ['app-server'])
    await sleep(120)
    expect(seen).toHaveLength(1)
    expect(seen[0].error).toBeNull()
    expect(seen[0].lines).toHaveLength(1)
    expect(seen[0].lines[0]).toMatch(/ codex app-server /)
    watch.stop()
    const other = installStubs(path.join(scratch(), 'stubs'))
    const failed = []
    const watching = watchRecorder(
      other,
      (lines, error) => failed.push({ lines, error: error?.code ?? null }),
      20
    )
    rmSync(other.log)
    await sleep(120)
    expect(failed).toEqual([{ lines: null, error: 'ENOENT' }])
    watching.stop()
  })
})

describe('the shell rule', () => {
  it('mirrors the names the host runs a command through, and refuses the stand-in under any other name', () => {
    const source = readFileSync(path.join(REPO, 'packages/host/src/shell-launch.ts'), 'utf8')
    const match = source.match(/const POSIX_SHELLS = new Set\(\[([^\]]*)\]\)/)
    expect(match, 'POSIX_SHELLS in packages/host/src/shell-launch.ts').not.toBeNull()
    expect(POSIX_SHELL_NAMES).toEqual(
      match[1].split(',').map((name) => name.trim().replace(/^'|'$/g, ''))
    )
    const root = mkdtempSync(path.join(os.tmpdir(), 'clave-native-shellrule-'))
    try {
      claimRunFolder(root)
      const stubs = installStubs(path.join(root, 'stubs'))
      expect(shellStandsIn(stubs.shell, stubs.shell)).toBe(true)
      const renamed = path.join(stubs.dir, 'clavesh')
      writeFileSync(renamed, readFileSync(stubs.shell))
      expect(shellStandsIn(renamed, renamed)).toBe(false)
      expect(shellStandsIn('/bin/zsh', stubs.shell)).toBe(false)
      expect(shellStandsIn(undefined, stubs.shell)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the fixture server', () => {
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

  it('passes its two pre-boot checks, boots the provider on the named port, passes its three post-boot checks, signs the daemon in, lists it on the relay, seeds the chat, and the whole proof passes', async () => {
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
      ['boot', 'observed', true]
    ])
    // The daemon's environment, by key names: the allowlist's that this shell
    // had, the fixture's own, nothing else (the sixth check compares the lists).
    expect(fixture.checks[5].detail).toMatch(/^\d+ keys: /)
    for (const key of [
      'SHELL',
      'PATH',
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'CLAVE_ANTASPHERE_ISSUER'
    ])
      expect(fixture.checks[5].detail).toContain(key)
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
    expect(error.checks).toHaveLength(6)
    expect(error.checks.slice(0, 4).every((c) => c.ok)).toBe(true)
    expect(error.checks[4]).toMatchObject({ stage: 'boot', kind: 'observed', ok: false })
    expect(error.checks[4].detail).toMatch(
      /the title one-shot would start|codex resolves to|the one-shot's PATH does not start with/
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

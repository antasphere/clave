/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by vitest */
import { execFileSync, spawnSync } from 'node:child_process'
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
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DAEMON_FLAGS,
  DAEMON_SETTINGS,
  ENV_ALLOWLIST,
  MUTATIONS,
  childEnv,
  flagsFor,
  loginEnvOf,
  loginShellEnvOf,
  parseArgs,
  POSIX_SHELL_NAMES,
  RECORDER_LOG_NAME,
  REPO,
  RUN_FOLDER_MARKER,
  RUN_FOLDER_OWNER,
  claimRunFolder,
  installStubs,
  recorderLines,
  shellStandsIn,
  watchRecorder
} from './scripts/fixture-server.mjs'

/* The fixture server's parts that start no daemon, no relay, no provider and
   no chat: the arguments, the two pre-boot checks run alone (`--preflight`),
   the run folder's ownership, the stubs and the recorder watch, the daemon's
   home and the stand-in login shell (which answers what was written into it,
   never what it is run with), and the shell rule. Every booted case is in
   fixture-server.boot.test.mjs, which runs only with CLAVE_FIXTURE_BOOT=1. */

const SCRIPT = fileURLToPath(new URL('./scripts/fixture-server.mjs', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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

  it('names the three flags and the six mutations, and drops a flag for one mutation only', () => {
    expect(DAEMON_FLAGS).toEqual(['--no-titles', '--test-no-activate', '--test-no-machine-usage'])
    expect(MUTATIONS).toEqual([
      'drop-title-opt-out',
      'bypass-title-guard',
      'start-usage-clock',
      'divergent-daemon-env',
      'divergent-home',
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
      'divergent-home',
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
    expect(readdirSync(stubs.home)).toEqual([])
    writeFileSync(stubs.log, 'a line of an earlier run\n')
    writeFileSync(path.join(stubs.claudeConfigDir, 'left-behind'), 'x')
    writeFileSync(path.join(stubs.home, '.claude.json'), '{}')
    const before = snapshot(stubs.dir)
    expect(installStubs(path.join(root, 'stubs'), { reuse: true })).toEqual(stubs)
    expect(snapshot(stubs.dir)).toEqual(before)
    installStubs(path.join(root, 'stubs'))
    expect(readFileSync(stubs.log, 'utf8')).toBe('')
    expect(readdirSync(stubs.claudeConfigDir)).toEqual([])
    expect(readdirSync(stubs.home)).toEqual([])
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

describe("the daemon's home and login shell", () => {
  const dirs = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })
  const install = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'clave-native-login-'))
    dirs.push(root)
    claimRunFolder(root)
    return { root, stubs: installStubs(path.join(root, 'stubs')) }
  }

  it("hands the daemon the fixture's home, never this shell's, and keeps the daemon's two settings out of the login environment", () => {
    const { root, stubs } = install()
    expect(ENV_ALLOWLIST).not.toContain('HOME')
    const env = childEnv('http://127.0.0.1:9', path.join(root, 'server'), stubs)
    expect(env.HOME).toBe(stubs.home)
    expect(env.HOME).not.toBe(process.env.HOME)
    expect(env.CLAVE_ANTASPHERE_ISSUER).toBe('http://127.0.0.1:9')
    const login = loginEnvOf(stubs)
    expect(login.HOME).toBe(stubs.home)
    expect(login.PATH.startsWith(stubs.dir + path.delimiter)).toBe(true)
    for (const key of DAEMON_SETTINGS) expect(Object.keys(login)).not.toContain(key)
    // The login environment is the daemon's own less its two settings, key for key.
    const less = Object.keys(env).filter((key) => !DAEMON_SETTINGS.includes(key))
    expect(Object.keys(login).sort()).toEqual(less.sort())
    // The one mutation of the PATH changes the daemon's environment, never the shell's.
    expect(childEnv('http://127.0.0.1:9', root, stubs, { recorders: false }).HOME).toBe(stubs.home)
  })

  it('the stand-in shell answers the environment written into it, whatever environment it is run with, and runs a -c command on that same one', () => {
    const { root, stubs } = install()
    // A caller's environment of its own, a sentinel among it: none of it may come back.
    const caller = { PATH: '/usr/bin:/bin', HOME: root, CLAVE_FIXTURE_SENTINEL: 'from-the-caller' }
    const answer = loginShellEnvOf(stubs.shell, caller)
    const fixed = loginEnvOf(stubs)
    expect(Object.keys(answer).sort()).toEqual(Object.keys(fixed).sort())
    expect(answer.CLAVE_FIXTURE_SENTINEL).toBeUndefined()
    expect(answer.PATH).toBe(fixed.PATH)
    expect(answer.HOME).toBe(stubs.home)
    expect(answer.SHELL).toBe(stubs.shell)
    // A command run through it, as the host runs one (`-l -c <command>`,
    // packages/host/src/shell-launch.ts), sees the written environment too.
    const seen = execFileSync(
      stubs.shell,
      [
        '-l',
        '-c',
        'if [ -n "$CLAVE_FIXTURE_SENTINEL" ]; then printf set; else printf unset; fi; printf "|%s" "$HOME"'
      ],
      { env: caller, encoding: 'utf8' }
    )
    expect(seen).toBe(`unset|${stubs.home}`)
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

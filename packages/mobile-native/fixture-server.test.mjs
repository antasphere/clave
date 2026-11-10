/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by vitest */
import { execFileSync, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
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
  INTERRUPTED_CHECK_EXIT,
  MUTATIONS,
  bootChecks,
  childEnv,
  flagsFor,
  loginEnvOf,
  loginShellEnvOf,
  parseArgs,
  preflight,
  POSIX_SHELL_NAMES,
  RECORDER_LOG_NAME,
  REPO,
  RUN_FOLDER_MARKER,
  RUN_FOLDER_OWNER,
  SUN_PATH_BYTES,
  TMUX_DECOY,
  TMUX_FOLDER_LEASE,
  TMUX_FOLDER_MARKER,
  TMUX_FOLDER_PREFIX,
  claimRunFolder,
  claimTmuxFolder,
  exitLatch,
  installStubs,
  keychainFileOf,
  recorderLines,
  releaseTmuxFolder,
  runCommand,
  shellStandsIn,
  startDaemon,
  superviseFixture,
  tmuxFallback,
  tmuxFolderContentsProblem,
  tmuxFolderFor,
  tmuxTmpdirProblem,
  tmuxTrace,
  watchRecorder
} from './scripts/fixture-server.mjs'

/* The fixture server's parts that start no daemon, no relay, no provider and
   no chat: the arguments, the two pre-boot checks run alone (`--preflight`),
   the run folder's ownership, the fixture's tmux folder (taken, refused, held
   to what tmux asks of a folder), the stubs and the recorder watch, the
   daemon's home, its TMUX_TMPDIR and the stand-in login shell (which answers
   what was written into it, never what it is run with), the daemon's start
   refusing a TMUX_TMPDIR before it makes anything, the checks asked of the
   daemon itself run in a stand-in Node process on an environment the test
   chose, the CLI's ways out driven with a fixture of the test's own, and the
   shell rule. No tmux is run here. Every booted case is in
   fixture-server.boot.test.mjs, which runs only with CLAVE_FIXTURE_BOOT=1. */

const SCRIPT = fileURLToPath(new URL('./scripts/fixture-server.mjs', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** A run folder removed with its tmux folder, the fixture's own under /tmp, named for its stubs. */
const removeRun = (dir) => {
  const stubs = path.join(dir, 'stubs')
  if (existsSync(stubs)) rmSync(tmuxFolderFor(stubs), { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
}
/** Everything under a folder, by path, each file with its bytes and mode, each link with its target. */
const tree = (dir) => {
  const out = []
  const walk = (rel) => {
    const where = path.join(dir, rel)
    const stat = lstatSync(where)
    if (stat.isSymbolicLink()) out.push([rel, 'link', readlinkSync(where)])
    else if (stat.isDirectory()) {
      out.push([rel, 'dir', stat.mode & 0o777])
      for (const name of readdirSync(where).sort()) walk(path.join(rel, name))
    } else out.push([rel, 'file', stat.mode & 0o777, readFileSync(where, 'utf8')])
  }
  walk('.')
  return out
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

  it('names the three flags and the eight mutations, and drops a flag for one mutation only', () => {
    expect(DAEMON_FLAGS).toEqual(['--no-titles', '--test-no-activate', '--test-no-machine-usage'])
    expect(MUTATIONS).toEqual([
      'drop-title-opt-out',
      'bypass-title-guard',
      'start-usage-clock',
      'divergent-daemon-env',
      'divergent-home',
      'divergent-tmux-tmpdir',
      'drop-recorders',
      'drop-tmux-tmpdir'
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
      'divergent-tmux-tmpdir',
      'drop-recorders',
      'drop-tmux-tmpdir'
    ])
      expect(flagsFor(m), m).toEqual(DAEMON_FLAGS)
  })
})

describe('--preflight', () => {
  it('runs the two pre-boot checks on the stubs and exits 0, no daemon, relay or provider started', () => {
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
      removeRun(dir)
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
      removeRun(dir)
    }
  })

  it('exits 2 when TMUX_TMPDIR is not in the environment the daemon would get, nothing started', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clave-native-preflight-'))
    try {
      const run = spawnSync(
        process.execPath,
        [SCRIPT, '--preflight', '--tmpdir', dir, '--mutate', 'drop-tmux-tmpdir'],
        { encoding: 'utf8' }
      )
      expect(run.status).toBe(2)
      expect(run.stdout.trim()).toBe('preflight: 2 checks, 1 failed')
      expect(run.stderr).toMatch(
        /check FAIL {2}the recorders stand in and tmux's sockets are the fixture's: .*: TMUX_TMPDIR in the daemon's environment is unset/
      )
    } finally {
      removeRun(dir)
    }
  })

  it('refuses a tmux folder it cannot take, exit 2, before writing a byte in it or in the stubs', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clave-native-preflight-'))
    try {
      claimRunFolder(dir)
      const stubs = path.join(dir, 'stubs')
      mkdirSync(stubs)
      const folder = tmuxFolderFor(stubs)
      mkdirSync(folder, { mode: 0o700 })
      writeFileSync(path.join(folder, 'someone-elses'), 'x')
      const run = spawnSync(process.execPath, [SCRIPT, '--preflight', '--tmpdir', dir], {
        encoding: 'utf8'
      })
      expect(run.status).toBe(2)
      expect(run.stderr).toMatch(
        /refusing the fixture's tmux folder .*: it carries no \.clave-native-fixture-tmux naming .*; nothing in it was touched/
      )
      expect(readdirSync(folder)).toEqual(['someone-elses'])
      expect(readdirSync(stubs)).toEqual([])
    } finally {
      removeRun(dir)
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
      const folder = tmuxFolderFor(path.join(dir, 'stubs'))
      const tmuxBefore = tree(folder)
      const second = spawnSync(process.execPath, [SCRIPT, '--preflight', '--tmpdir', dir], {
        encoding: 'utf8'
      })
      expect(second.status, second.stderr).toBe(0)
      expect(second.stdout.trim()).toBe('preflight: 2 checks, 0 failed')
      expect(snapshot(path.join(dir, 'stubs'))).toEqual(before)
      expect(tree(folder)).toEqual(tmuxBefore)
    } finally {
      removeRun(dir)
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
      removeRun(dir)
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
    for (const dir of dirs) removeRun(dir)
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

describe("the fixture's tmux folder", () => {
  const dirs = []
  afterAll(() => {
    for (const dir of dirs) removeRun(dir)
  })
  const stubsDir = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'clave-native-tmux-'))
    dirs.push(root)
    const stubs = path.join(root, 'stubs')
    mkdirSync(stubs)
    return stubs
  }
  const own = `tmux-${process.getuid()}`
  const refused = (fn, why) => {
    let error = null
    try {
      fn()
    } catch (e) {
      error = e
    }
    expect(error, 'a refusal').not.toBeNull()
    expect(error.refusedFolder).toBe(true)
    expect(error.message).toMatch(/^refusing the fixture's tmux folder /)
    expect(error.message).toMatch(why)
    expect(error.message).toMatch(/; nothing in it was touched$/)
  }

  it('is made under the real /tmp, named for its stubs folder, mode 700, with a marker naming that folder, and tmux takes it as it is', () => {
    const stubs = stubsDir()
    const folder = claimTmuxFolder(stubs)
    expect(path.dirname(folder)).toBe(tmuxFallback())
    expect(path.basename(folder)).toMatch(new RegExp(`^${TMUX_FOLDER_PREFIX}[0-9a-f]{12}$`))
    expect(folder).toBe(tmuxFolderFor(stubs))
    const stat = lstatSync(folder)
    expect(stat.isDirectory()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o700)
    expect(readdirSync(folder)).toEqual([TMUX_FOLDER_MARKER])
    expect(readFileSync(path.join(folder, TMUX_FOLDER_MARKER), 'utf8')).toBe(
      `clave-native-fixture-server/1 tmux ${realpathSync(stubs)}\n`
    )
    expect(tmuxTmpdirProblem(folder)).toBeNull()
    expect(tmuxFolderContentsProblem(folder, stubs)).toBeNull()
    expect(tmuxFolderFor(stubsDir())).not.toBe(folder)
  })

  it('taken again, it loses only what a past run left, one entry at a time, and its lease is given back by the process it names only', () => {
    const stubs = stubsDir()
    const folder = claimTmuxFolder(stubs)
    const dead = spawnSync(process.execPath, ['-e', '']).pid
    writeFileSync(path.join(folder, TMUX_FOLDER_LEASE), `${dead}\n`)
    mkdirSync(path.join(folder, own), { mode: 0o700 })
    mkdirSync(path.join(folder, TMUX_DECOY, own), { recursive: true, mode: 0o700 })
    expect(claimTmuxFolder(stubs)).toBe(folder)
    expect(readdirSync(folder)).toEqual([TMUX_FOLDER_MARKER])
    claimTmuxFolder(stubs, { lease: true })
    expect(readFileSync(path.join(folder, TMUX_FOLDER_LEASE), 'utf8')).toBe(`${process.pid}\n`)
    releaseTmuxFolder(folder)
    expect(readdirSync(folder)).toEqual([TMUX_FOLDER_MARKER])
    writeFileSync(path.join(folder, TMUX_FOLDER_LEASE), `${dead}\n`)
    releaseTmuxFolder(folder)
    expect(readFileSync(path.join(folder, TMUX_FOLDER_LEASE), 'utf8')).toBe(`${dead}\n`)
  })

  it('refuses, touching nothing, a symlink, a file, another mode, a missing or foreign marker, a live or a foreign lease, an entry it never makes, and anything inside a tmux client folder or the decoy', () => {
    // At its path, a symlink to a folder of this user's, then a file.
    const linked = stubsDir()
    const target = mkdtempSync(path.join(os.tmpdir(), 'clave-native-tmux-target-'))
    dirs.push(target)
    symlinkSync(target, tmuxFolderFor(linked))
    refused(() => claimTmuxFolder(linked), /: it is a symlink;/)
    expect(readlinkSync(tmuxFolderFor(linked))).toBe(target)
    expect(readdirSync(target)).toEqual([])
    const filed = stubsDir()
    writeFileSync(tmuxFolderFor(filed), 'x')
    refused(() => claimTmuxFolder(filed), /: it is not a folder;/)
    expect(readFileSync(tmuxFolderFor(filed), 'utf8')).toBe('x')
    // A folder of the fixture's, then each change to it.
    const cases = [
      [(f) => chmodSync(f, 0o755), /: its mode is 755, not 700;/],
      [
        (f) => rmSync(path.join(f, TMUX_FOLDER_MARKER)),
        /: it carries no \.clave-native-fixture-tmux naming /
      ],
      [
        (f) =>
          writeFileSync(
            path.join(f, TMUX_FOLDER_MARKER),
            'clave-native-fixture-server/1 tmux /another/run/folder/stubs\n'
          ),
        /: it carries no \.clave-native-fixture-tmux naming /
      ],
      [
        (f) => writeFileSync(path.join(f, TMUX_FOLDER_LEASE), `${process.pid}\n`),
        /: a live process holds its lease, pid \d+;/
      ],
      [
        (f) => writeFileSync(path.join(f, TMUX_FOLDER_LEASE), 'not a pid\n'),
        /: \.lease is not a lease the fixture writes;/
      ],
      [
        (f) => writeFileSync(path.join(f, 'someone-elses'), 'x'),
        /: it holds what the fixture never makes: someone-elses;/
      ],
      [
        (f) => {
          mkdirSync(path.join(f, own), { mode: 0o700 })
          writeFileSync(path.join(f, own, 'clave'), '')
        },
        /: tmux-\d+ is not empty: a tmux socket may live there/
      ],
      [(f) => symlinkSync(target, path.join(f, own)), /: tmux-\d+ is not a plain folder;/],
      [
        (f) => {
          mkdirSync(path.join(f, TMUX_DECOY), { mode: 0o700 })
          writeFileSync(path.join(f, TMUX_DECOY, 'x'), '')
        },
        /: decoy holds what the fixture never makes: x;/
      ],
      [
        (f) => {
          mkdirSync(path.join(f, TMUX_DECOY, own), { recursive: true, mode: 0o700 })
          writeFileSync(path.join(f, TMUX_DECOY, own, 'clave'), '')
        },
        /: decoy\/tmux-\d+ is not empty: a tmux socket may live there/
      ]
    ]
    for (const [change, why] of cases) {
      const stubs = stubsDir()
      const folder = claimTmuxFolder(stubs)
      change(folder)
      const before = tree(folder)
      refused(() => claimTmuxFolder(stubs), why)
      expect(tree(folder), String(why)).toEqual(before)
      chmodSync(folder, 0o700)
    }
  })

  it('is held to what tmux asks of a TMUX_TMPDIR: unset, empty, relative, missing, a symlink, a file, through a symlinked parent, /tmp itself, another owner, another mode or a socket name too long is a problem', () => {
    const stubs = stubsDir()
    const folder = claimTmuxFolder(stubs)
    expect(tmuxTmpdirProblem(folder)).toBeNull()
    expect(tmuxTmpdirProblem(undefined)).toBe(
      'TMUX_TMPDIR is unset or empty, so tmux would use /tmp'
    )
    expect(tmuxTmpdirProblem('')).toBe('TMUX_TMPDIR is unset or empty, so tmux would use /tmp')
    expect(tmuxTmpdirProblem('relative/folder')).toMatch(/is not an absolute path$/)
    expect(tmuxTmpdirProblem(path.join(folder, 'missing'))).toMatch(
      /does not exist, so tmux would use \/tmp$/
    )
    const link = path.join(path.dirname(stubs), 'tmux-link')
    symlinkSync(folder, link)
    expect(tmuxTmpdirProblem(link)).toMatch(/is a symlink$/)
    const file = path.join(path.dirname(stubs), 'a-file')
    writeFileSync(file, 'x')
    expect(tmuxTmpdirProblem(file)).toMatch(/is not a folder$/)
    const realParent = mkdtempSync(path.join(tmuxFallback(), 'clave-native-tmuxparent-'))
    dirs.push(realParent)
    mkdirSync(path.join(realParent, 'inner'), { mode: 0o700 })
    const linkParent = path.join(path.dirname(stubs), 'parent-link')
    symlinkSync(realParent, linkParent)
    expect(tmuxTmpdirProblem(path.join(linkParent, 'inner'))).toMatch(/is not its own real path, /)
    expect(tmuxTmpdirProblem(tmuxFallback())).toMatch(/is \/tmp itself$/)
    expect(tmuxTmpdirProblem(folder, { uid: process.getuid() + 1 })).toMatch(
      /belongs to uid \d+, not \d+$/
    )
    chmodSync(folder, 0o750)
    expect(tmuxTmpdirProblem(folder)).toMatch(/has mode 750, not 700$/)
    chmodSync(folder, 0o700)
    // The socket address's limit, at its edge for the longest name, then a real folder past it.
    const longest = Buffer.byteLength(path.join(folder, own, 'default'))
    expect(tmuxTmpdirProblem(folder, { sunPath: longest })).toMatch(
      /takes \d+ bytes, and a socket address holds \d+$/
    )
    expect(tmuxTmpdirProblem(folder, { sunPath: longest + 1 })).toBeNull()
    const deep = path.join(realParent, 'd'.repeat(SUN_PATH_BYTES - realParent.length))
    mkdirSync(deep, { mode: 0o700 })
    expect(tmuxTmpdirProblem(deep)).toMatch(/takes \d+ bytes, and a socket address holds \d+$/)
  })

  it('before a boot it holds only its marker and its lease, and the trace reads what a tmux client made in it', () => {
    const stubs = stubsDir()
    const folder = claimTmuxFolder(stubs, { lease: true })
    expect(tmuxFolderContentsProblem(folder, stubs)).toBeNull()
    expect(tmuxTrace(folder)).toEqual({ client: false, inside: [] })
    releaseTmuxFolder(folder)
    mkdirSync(path.join(folder, own), { mode: 0o700 })
    expect(tmuxFolderContentsProblem(folder, stubs)).toBe(
      `the tmux folder ${folder} already holds ${own}`
    )
    expect(tmuxTrace(folder)).toEqual({ client: true, inside: [] })
    writeFileSync(path.join(folder, own, 'clave'), '')
    expect(tmuxTrace(folder)).toEqual({ client: true, inside: ['clave'] })
    rmSync(path.join(folder, own, 'clave'))
    rmdirSync(path.join(folder, own))
    writeFileSync(
      path.join(folder, TMUX_FOLDER_MARKER),
      'clave-native-fixture-server/1 tmux /another/run/folder/stubs\n'
    )
    expect(tmuxFolderContentsProblem(folder, stubs)).toBe(
      `the tmux folder ${folder} carries no ${TMUX_FOLDER_MARKER} naming this run folder`
    )
  })
})

describe("the daemon's home and login shell", () => {
  const dirs = []
  afterAll(() => {
    for (const dir of dirs) removeRun(dir)
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
    // TMUX_TMPDIR, the fixture's tmux folder, in both; its one mutation takes
    // it out of the daemon's environment, never out of the shell's.
    expect(env.TMUX_TMPDIR).toBe(stubs.tmux)
    expect(login.TMUX_TMPDIR).toBe(stubs.tmux)
    expect(childEnv('http://127.0.0.1:9', root, stubs, { tmux: false }).TMUX_TMPDIR).toBeUndefined()
    expect(loginEnvOf(stubs).TMUX_TMPDIR).toBe(stubs.tmux)
  })

  it("refuses, before any daemon, an environment whose HOME is not the fixture's home", async () => {
    const { root, stubs } = install()
    const env = {
      ...childEnv('http://127.0.0.1:9', path.join(root, 'server'), stubs),
      HOME: path.join(root, 'elsewhere')
    }
    const checks = await preflight({ flags: DAEMON_FLAGS, stubs, env, log: () => {} })
    expect(checks[0].ok).toBe(true)
    expect(checks[1]).toMatchObject({ stage: 'preflight', kind: 'observed', ok: false })
    expect(checks[1].detail).toMatch(/HOME in the daemon's environment is not the fixture's home/)
  })

  it("refuses, before any daemon, a TMUX_TMPDIR that is unset, empty or another folder, and the fixture's folder in a shape tmux would not take as it is", async () => {
    const { root, stubs } = install()
    const base = childEnv('http://127.0.0.1:9', path.join(root, 'server'), stubs)
    const second = async (env) =>
      (await preflight({ flags: DAEMON_FLAGS, stubs, env, log: () => {} }))[1]
    expect((await second(base)).ok).toBe(true)
    const unset = { ...base }
    delete unset.TMUX_TMPDIR
    expect((await second(unset)).detail).toBe("TMUX_TMPDIR in the daemon's environment is unset")
    expect((await second({ ...base, TMUX_TMPDIR: '' })).detail).toBe(
      "TMUX_TMPDIR in the daemon's environment is empty"
    )
    const other = mkdtempSync(path.join(tmuxFallback(), 'clave-native-other-'))
    dirs.push(other)
    expect((await second({ ...base, TMUX_TMPDIR: other })).detail).toBe(
      `TMUX_TMPDIR in the daemon's environment is ${other}, not the fixture's tmux folder`
    )
    chmodSync(stubs.tmux, 0o755)
    expect((await second(base)).detail).toBe(`TMUX_TMPDIR ${stubs.tmux} has mode 755, not 700`)
    chmodSync(stubs.tmux, 0o700)
    mkdirSync(path.join(stubs.tmux, `tmux-${process.getuid()}`), { mode: 0o700 })
    expect((await second(base)).detail).toBe(
      `the tmux folder ${stubs.tmux} already holds tmux-${process.getuid()}`
    )
  })

  it("refuses, before any daemon, a Claude config folder, a Codex home or a keychain file that is not the run's own", async () => {
    const { root, stubs } = install()
    const base = childEnv('http://127.0.0.1:9', path.join(root, 'server'), stubs)
    const second = async (env) =>
      (await preflight({ flags: DAEMON_FLAGS, stubs, env, log: () => {} }))[1]
    expect((await second(base)).ok).toBe(true)
    expect((await second({ ...base, CLAUDE_CONFIG_DIR: stubs.home })).detail).toBe(
      "CLAUDE_CONFIG_DIR in the daemon's environment is not the fixture's Claude config folder"
    )
    const noCodex = { ...base }
    delete noCodex.CODEX_HOME
    expect((await second(noCodex)).detail).toBe(
      "CODEX_HOME in the daemon's environment is not the fixture's Codex home"
    )
    // On macOS an unset keychain file is the login keychain: refused; elsewhere none is expected.
    const keychain = keychainFileOf(path.join(root, 'server'))
    const noKeychain = { ...base }
    delete noKeychain.CLAVE_KEYCHAIN_FILE
    expect((await second(noKeychain)).ok).toBe(keychain === null)
    const elsewhere = path.join(root, 'elsewhere.keychain-db')
    expect((await second({ ...base, CLAVE_KEYCHAIN_FILE: elsewhere })).detail).toBe(
      `CLAVE_KEYCHAIN_FILE in the daemon's environment is ${elsewhere}, not ${keychain ?? 'unset'}`
    )
  })

  it('the booted cases sit in their own file, behind their opt-in', () => {
    // Renamed out of the suite or stripped of its guard, the booted file
    // would run nowhere, or everywhere; either fails here.
    const booted = readFileSync(new URL('./fixture-server.boot.test.mjs', import.meta.url), 'utf8')
    expect(booted).toContain("const BOOT = process.env.CLAVE_FIXTURE_BOOT === '1'")
    expect(booted).toContain("describe.runIf(BOOT)('the fixture server'")
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
    expect(answer.TMUX_TMPDIR).toBe(stubs.tmux)
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

describe("the daemon's start and the checks asked of the daemon itself", () => {
  const dirs = []
  afterAll(() => {
    for (const dir of dirs) removeRun(dir)
  })
  const install = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'clave-native-inside-'))
    dirs.push(root)
    claimRunFolder(root)
    const stubs = installStubs(path.join(root, 'stubs'))
    const serverDir = path.join(root, 'server')
    return { root, stubs, serverDir, env: childEnv('http://127.0.0.1:9', serverDir, stubs) }
  }

  it('the start refuses, before it makes or starts anything, a TMUX_TMPDIR tmux would not take as it is: unset, a decoy not made yet, another mode', async () => {
    const { root, stubs, serverDir, env } = install()
    // No keychain file is made here, whatever the start does with this environment.
    delete env.CLAVE_KEYCHAIN_FILE
    const unset = { ...env }
    delete unset.TMUX_TMPDIR
    const open = path.join(realpathSync(root), 'open')
    mkdirSync(open, { mode: 0o755 })
    chmodSync(open, 0o755)
    for (const [what, handed] of [
      ['unset', unset],
      ['a decoy not made yet', { ...env, TMUX_TMPDIR: path.join(stubs.tmux, TMUX_DECOY) }],
      ['mode 755', { ...env, TMUX_TMPDIR: open }]
    ]) {
      const problem = tmuxTmpdirProblem(handed.TMUX_TMPDIR)
      expect(problem, what).not.toBeNull()
      // /usr/bin/false stands where Bun would: nothing could announce itself even past the guard.
      const refused = await startDaemon({
        bun: '/usr/bin/false',
        port: 0,
        dataDir: serverDir,
        tokenFile: path.join(serverDir, 'token'),
        relay: 'http://127.0.0.1:9',
        env: handed,
        flags: DAEMON_FLAGS,
        log: () => {},
        timeoutMs: 2_000
      }).then(
        () => null,
        (error) => error
      )
      expect(refused?.message, what).toBe(`refused to start the daemon: ${problem}`)
      // A refused boot, which the command exits 2 on.
      expect(refused?.refusedBoot, what).toBe(true)
      expect(existsSync(serverDir), what).toBe(false)
    }
  })

  it('the sixth and seventh checks compare each value on their own: a stand-in for the daemon on the handed environment passes both, one key more or less fails the sixth, and another Claude config folder, Codex home or keychain file fails the seventh at that value', async () => {
    const { stubs, serverDir, env } = install()
    const server = {
      url: 'http://127.0.0.1:9',
      token: 'unused',
      discovery: { titles: 'off', testMode: true, machineUsage: false },
      env,
      dataDir: serverDir
    }
    // The function the check would send to the daemon's test route, run in a
    // Node process started on `actual`, as that route runs it in the daemon.
    // Node on macOS adds __CF_USER_TEXT_ENCODING to its own environment, which
    // the daemon's Bun does not (the booted sixth check passes there): the
    // stand-in first drops every key it was not started with.
    const standIn = (actual) => async (_server, source) => {
      const keep = JSON.stringify(Object.keys(actual))
      const run = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const keep = new Set(${keep}); for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key]; process.stdout.write(JSON.stringify(await (${source})()))`
        ],
        { env: actual, encoding: 'utf8', timeout: 20_000 }
      )
      if (run.status !== 0) throw new Error(`the stand-in exited ${run.status}`)
      return JSON.parse(run.stdout)
    }
    const sixAndSeven = async (actual) => {
      const results = await bootChecks({ server, stubs, log: () => {}, ask: standIn(actual) })
      return [
        results.find((r) => r.name.startsWith("inside the running daemon, the environment's keys")),
        results.find((r) => r.name.startsWith('inside the running daemon, its home'))
      ]
    }
    const elsewhere = path.join(stubs.dir, 'elsewhere')
    mkdirSync(elsewhere)
    const keychain = keychainFileOf(serverDir)

    const [six, seven] = await sixAndSeven(env)
    expect(six.ok, six.detail).toBe(true)
    expect(seven.ok, seven.detail).toBe(true)

    const more = await sixAndSeven({ ...env, CLAVE_FIXTURE_EXTRA: 'one more' })
    expect(more[0].detail).toBe('extra: CLAVE_FIXTURE_EXTRA; missing: none')
    expect(more[1].ok, more[1].detail).toBe(true)
    const fewer = { ...env }
    delete fewer.CLAVE_ANTASPHERE_ISSUER
    const less = await sixAndSeven(fewer)
    expect(less[0].detail).toBe('extra: none; missing: CLAVE_ANTASPHERE_ISSUER')
    expect(less[1].ok, less[1].detail).toBe(true)

    for (const [key, detail] of [
      [
        'CLAUDE_CONFIG_DIR',
        "CLAUDE_CONFIG_DIR inside the daemon is not the fixture's Claude config folder"
      ],
      ['CODEX_HOME', "CODEX_HOME inside the daemon is not the fixture's Codex home"]
    ]) {
      const [keys, values] = await sixAndSeven({ ...env, [key]: elsewhere })
      expect(keys.ok, `${key}: ${keys.detail}`).toBe(true)
      expect(values.detail, key).toBe(detail)
    }
    const otherKeychain = await sixAndSeven({
      ...env,
      CLAVE_KEYCHAIN_FILE: path.join(serverDir, 'elsewhere.keychain-db')
    })
    expect(otherKeychain[1].detail).toBe(
      "CLAVE_KEYCHAIN_FILE inside the daemon is not the fixture's keychain file"
    )
    // On macOS an unset keychain file is the login keychain: refused; elsewhere none is expected.
    const noKeychain = { ...env }
    delete noKeychain.CLAVE_KEYCHAIN_FILE
    expect((await sixAndSeven(noKeychain))[1].ok).toBe(keychain === null)
  })
})

describe("the CLI's way out", () => {
  it('a recorder failure reported while the fixture stops is latched: the run exits 3, never the code of the clean stop under way', async () => {
    const codes = []
    let finish
    const exit = exitLatch(
      () => new Promise((resolve) => (finish = resolve)),
      (code) => codes.push(code)
    )
    const first = exit(0)
    expect(exit.stopping()).toBe(true)
    await exit(3)
    await exit(1)
    expect(codes).toEqual([])
    finish()
    await first
    expect(codes).toEqual([3])
    // A clean stop alone exits with its own code, and nothing after it counts.
    const clean = []
    const once = exitLatch(
      async () => {},
      (code) => clean.push(code)
    )
    await once(0)
    await once(3)
    expect(clean).toEqual([0])
  })

  /** A fixture of the test's own, nothing started: its stop stays under way
   *  until `finish`, and every hook of the CLI is recorded. */
  const supervised = () => {
    const run = { handlers: {}, codes: [], written: [], stops: 0, finish: null, caught: null }
    run.child = new EventEmitter()
    run.fixture = {
      checks: [{ ok: true }],
      stubs: { log: path.join(os.tmpdir(), 'no-recorder.log') },
      server: { child: run.child },
      lines: () => ({ CLAVE_FIXTURE_SERVER_URL: 'http://127.0.0.1:9' }),
      stop: () => {
        run.stops += 1
        return new Promise((resolve) => (run.finish = resolve))
      }
    }
    run.io = (prove = async () => [{ ok: true }]) => ({
      prove,
      watch: (_stubs, onCaught) => (run.caught = onCaught),
      on: (signal, handler) => (run.handlers[signal] = handler),
      exitProcess: (code) => run.codes.push(code),
      out: (text) => run.written.push(text),
      log: () => {}
    })
    /** The whole command's hooks: `start` stands for the boot. Its `on` keeps
     *  every handler put on, so the test sees whether one was ever taken off. */
    run.cli = (start, prove) => {
      run.listeners = {}
      return {
        ...run.io(prove),
        start,
        on: (signal, handler) => {
          ;(run.listeners[signal] ??= []).push(handler)
          run.handlers[signal] = handler
        }
      }
    }
    return run
  }
  const turn = () => new Promise((resolve) => setImmediate(resolve))
  const summaries = (run) => run.written.filter((text) => /^\d+ checks, \d+ failed/.test(text))

  it('under --check, a SIGINT or a SIGTERM before the summary line exits 130 or 143 once the fixture stopped, and no summary line is written, whether the proof then ends or throws', async () => {
    expect(INTERRUPTED_CHECK_EXIT).toEqual({ SIGINT: 130, SIGTERM: 143 })
    for (const [signal, code] of Object.entries(INTERRUPTED_CHECK_EXIT))
      for (const ending of ['ends', 'throws']) {
        const run = supervised()
        const done = superviseFixture(
          run.fixture,
          { check: true },
          run.io(async () => {
            await turn()
            run.handlers[signal]()
            await turn()
            if (ending === 'throws') throw new Error('fetch failed')
            return [{ ok: true }]
          })
        )
        await done
        expect(run.stops, `${signal}, the proof ${ending}`).toBe(1)
        expect(summaries(run), `${signal}, the proof ${ending}`).toEqual([])
        expect(run.codes).toEqual([])
        run.finish()
        await turn()
        expect(run.codes, `${signal}, the proof ${ending}`).toEqual([code])
      }
  })

  it('under --check, the daemon exiting by itself is a failure, exit 1, whatever its own code, and no summary line is written', async () => {
    for (const own of [0, null]) {
      const run = supervised()
      const done = superviseFixture(
        run.fixture,
        { check: true },
        run.io(async () => {
          await turn()
          run.child.emit('exit', own)
          await turn()
          return [{ ok: true }]
        })
      )
      await done
      expect(summaries(run), `the daemon's own code ${own}`).toEqual([])
      run.finish()
      await turn()
      expect(run.codes, `the daemon's own code ${own}`).toEqual([1])
      expect(run.stops).toBe(1)
    }
  })

  it('under --check, a proof that runs to its end writes its summary line and exits with its verdict, a signal during the stop changing nothing; a proof that throws by itself stops the fixture and exits 1', async () => {
    for (const [rows, line, code] of [
      [[{ ok: true }], '2 checks, 0 failed\n', 0],
      [[{ ok: false }], '2 checks, 1 failed\n', 1]
    ]) {
      const run = supervised()
      const done = superviseFixture(
        run.fixture,
        { check: true },
        run.io(async () => rows)
      )
      await turn()
      expect(run.written).toEqual([line])
      run.handlers.SIGINT()
      run.finish()
      await done
      expect(run.codes).toEqual([code])
      expect(run.stops).toBe(1)
    }
    const run = supervised()
    const done = superviseFixture(
      run.fixture,
      { check: true },
      run.io(async () => {
        throw new Error('no answer')
      })
    )
    await turn()
    expect(run.stops).toBe(1)
    run.finish()
    await done
    expect(run.codes).toEqual([1])
    expect(summaries(run)).toEqual([])
  })

  it('running, a signal is the way out, exit 0; the daemon exiting by itself exits 1; and a recorder failure reported during a stop exits 3, the fixture stopped once', async () => {
    const signalled = supervised()
    await superviseFixture(signalled.fixture, {}, signalled.io())
    signalled.handlers.SIGINT()
    signalled.finish()
    await turn()
    expect(signalled.codes).toEqual([0])

    const gone = supervised()
    await superviseFixture(gone.fixture, {}, gone.io())
    gone.child.emit('exit', 0)
    gone.finish()
    await turn()
    expect(gone.codes).toEqual([1])

    const caught = supervised()
    await superviseFixture(caught.fixture, {}, caught.io())
    caught.handlers.SIGTERM()
    expect(caught.stops).toBe(1)
    caught.caught(['claude -p fixture'])
    caught.child.emit('exit', 0)
    caught.finish()
    await turn()
    expect(caught.codes).toEqual([3])
    expect(caught.stops).toBe(1)
  })

  it('the command under --check proves the fixture it started and writes its summary, the line or under --json the object with every check, then exits with the verdict', async () => {
    for (const json of [false, true]) {
      const run = supervised()
      const done = runCommand(
        { check: true, json },
        run.cli(async () => run.fixture)
      )
      await turn()
      await turn()
      if (json) {
        const printed = JSON.parse(run.written.join(''))
        expect(printed.checks).toEqual([{ ok: true }, { ok: true }])
        expect(printed.CLAVE_FIXTURE_SERVER_URL).toBe('http://127.0.0.1:9')
      } else expect(run.written).toEqual(['2 checks, 0 failed\n'])
      run.finish()
      await done
      expect(run.codes, `json ${json}`).toEqual([0])
      expect(run.stops).toBe(1)
    }
  })

  it('a SIGINT or a SIGTERM during the boot is kept until the boot ends: the fixture that came up is stopped before anything is proven or printed, exit 130 or 143 under --check and 0 running', async () => {
    for (const check of [true, false])
      for (const [signal, code] of Object.entries(INTERRUPTED_CHECK_EXIT)) {
        const run = supervised()
        let proved = 0
        const done = runCommand(
          { check },
          run.cli(
            async () => {
              run.handlers[signal]()
              await turn()
              return run.fixture
            },
            async () => {
              proved += 1
              return [{ ok: true }]
            }
          )
        )
        await turn()
        await turn()
        const what = `${signal}, check ${check}`
        expect(run.stops, what).toBe(1)
        expect(proved, what).toBe(0)
        expect(run.written, what).toEqual([])
        // A second signal during that stop reaches the running handlers, whose latch ignores it.
        run.handlers[signal]()
        run.finish()
        await done
        await turn()
        expect(run.codes, what).toEqual([check ? code : 0])
        expect(run.stops, what).toBe(1)
      }
  })

  it('the first signal of the boot is the one kept, and one pair of handlers serves the whole command, never taken off', async () => {
    const run = supervised()
    const done = runCommand(
      { check: true },
      run.cli(async () => {
        run.handlers.SIGTERM()
        run.handlers.SIGINT()
        await turn()
        return run.fixture
      })
    )
    await turn()
    await turn()
    run.finish()
    await done
    expect(run.codes).toEqual([INTERRUPTED_CHECK_EXIT.SIGTERM])
    // The command put on one handler per signal, and nothing else put one on the process.
    expect(Object.keys(run.listeners).sort()).toEqual(['SIGINT', 'SIGTERM'])
    for (const signal of ['SIGINT', 'SIGTERM']) expect(run.listeners[signal]).toHaveLength(1)
  })

  it('a signal that reaches the command once the boot has ended goes to the running fixture: under --check exit 130 and no summary, running exit 0', async () => {
    for (const check of [true, false]) {
      const run = supervised()
      let ended = false
      const done = runCommand(
        { check },
        run.cli(
          async () => run.fixture,
          async () => {
            await turn()
            await turn()
            ended = true
            return [{ ok: true }]
          }
        )
      )
      await turn()
      run.handlers.SIGINT()
      await turn()
      await turn()
      await turn()
      expect(run.stops, `check ${check}`).toBe(1)
      expect(summaries(run), `check ${check}`).toEqual([])
      run.finish()
      await done
      await turn()
      expect(run.codes, `check ${check}`).toEqual([check ? INTERRUPTED_CHECK_EXIT.SIGINT : 0])
      if (check) expect(ended).toBe(true)
    }
  })

  it('a boot that fails after a kept signal exits as that signal does, with no refusal line, whatever the failure', async () => {
    const failures = [
      Object.assign(new Error('not the fixture folder'), { refusedFolder: true }),
      Object.assign(new Error('refused before the daemon'), { checks: [{ ok: false }] }),
      Object.assign(new Error('refused to start the daemon: TMUX_TMPDIR is unset or empty'), {
        refusedBoot: true
      }),
      new Error('the relay exited (0) before announcing itself')
    ]
    for (const check of [true, false])
      for (const failure of failures) {
        const run = supervised()
        await runCommand(
          { check, json: true },
          run.cli(async () => {
            run.handlers.SIGINT()
            await turn()
            throw failure
          })
        )
        const what = `${failure.message}, check ${check}`
        expect(run.codes, what).toEqual([check ? INTERRUPTED_CHECK_EXIT.SIGINT : 0])
        expect(run.written, what).toEqual([])
      }
  })

  it('a refused run folder, refused checks and the daemon start refusing its TMUX_TMPDIR exit 2, each with its line; any other failure of the boot is thrown on, for the exit 1', async () => {
    for (const [error, line] of [
      [
        Object.assign(new Error('not the fixture folder'), { refusedFolder: true }),
        'refused: the run folder\n'
      ],
      [
        Object.assign(new Error('refused before the daemon'), {
          checks: [{ ok: true }, { ok: false }]
        }),
        'refused to boot: 1 of 2 checks failed\n'
      ],
      [
        Object.assign(new Error('refused to start the daemon: TMUX_TMPDIR is unset or empty'), {
          refusedBoot: true
        }),
        "refused to boot: the daemon's TMUX_TMPDIR\n"
      ]
    ]) {
      const run = supervised()
      await runCommand(
        {},
        run.cli(async () => {
          throw error
        })
      )
      expect(run.written, error.message).toEqual([line])
      expect(run.codes, error.message).toEqual([2])
      expect(run.stops).toBe(0)
      if (error.refusedFolder) continue
      // Under --json, the refusal is one object that says so, with its checks or its reason.
      const json = supervised()
      await runCommand(
        { json: true },
        json.cli(async () => {
          throw error
        })
      )
      expect(JSON.parse(json.written.join('')), error.message).toEqual(
        error.checks
          ? { refused: true, checks: error.checks }
          : { refused: true, reason: error.message }
      )
      expect(json.codes).toEqual([2])
    }
    const run = supervised()
    await expect(
      runCommand(
        {},
        run.cli(async () => {
          throw new Error('no bun here')
        })
      )
    ).rejects.toThrow('no bun here')
    expect(run.codes).toEqual([])
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
      removeRun(root)
    }
  })
})

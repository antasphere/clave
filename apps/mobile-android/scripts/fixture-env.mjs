#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by node */
// The environment the native Android app is developed and tested against, on
// 127.0.0.1 only: a local OpenID Connect provider standing in for the hub
// (tests/e2e/fixtures/oidc-provider.mjs), the relay and a Clave daemon with
// the Echo adapter, both from this checkout under the repository's Bun. The
// owner is signed in on the daemon, the daemon claims its machine on the
// relay, a scratch workspace holds one Echo session with one message in it.
//
//   node apps/mobile-android/scripts/fixture-env.mjs --server 47201 --relay 47202 \
//     --issuer 47203 --tmpdir /private/tmp/clave-native-b/fixture [--check] [--approve]
//
// Writes <tmpdir>/fixture.json and prints CLAVE_FIXTURE_* lines. The daemon's
// bearer is in a mode-0600 file (tokenFile); no token is ever printed.
// --check plays a phone over HTTP through the relay and exits 0 or 1.
// --approve keeps running and approves every phone that asks to pair.
// --dry-run runs the pre-boot checks alone, prints the daemon command it would
// start, and exits 0 or 2: nothing is started; it proves the pre-boot checks and,
// under --mutate recorder-* or decoy-line, the recorder guard's one look, nothing else (not
// the boot checks, not the guard's continuous watch).
// Otherwise it keeps running until SIGINT/SIGTERM, which stops every child.
//
// The run folder (--tmpdir, mandatory, never defaulted) is the fixture's own: an
// absent or empty folder is claimed with `.clave-fixture`, a regular file naming
// this script as the owner, the folder's real path, the band and the claiming pid.
// A non-empty folder without that marker, a symlinked or foreign marker, a marker
// whose pid is still alive, a symlink, a plain file or a folder that cannot be
// inspected is refused untouched (exit 2); an owned folder is emptied at each real
// run. A dry run only reads the folder and builds its shims in a scratch folder.
//
// No real agent, no real login, proven before and after the boot and watched
// for the whole run. Every child of the fixture (the daemon, the relay, the
// recorder self-test, the Bun probe) runs under one sanitized environment: the
// fixture's own keys over a frozen allowlist of the shell's, and Bun's automatic
// .env loading off (--no-env-file). BEFORE anything starts (preBootChecks): the
// daemon argv carries --no-env-file and --no-titles --test-no-activate
// --test-no-machine-usage; the key NAMES a Bun process sees under that environment
// (a probe printing names, never values) are exactly the launch's; the recorders
// are first on PATH, the fixture's login shell stand-in is SHELL and the Claude and
// Codex homes are empty folders of the fixture's own; the login environment, read
// the way the daemon reads it (`$SHELL -lic 'env -0'`), resolves `claude` and
// `codex` to the recorders. The stand-in prints a fixture-authored environment
// (written into it when the launch was built), never the one it is run in. AFTER
// the daemon announces itself and
// BEFORE anything is seeded (bootChecks, each inside the daemon's own process
// through POST /e2e/evaluate): its discovery file says titles "off", testMode
// true and machineUsage false; the title module's own test hooks (#354,
// `__claveE2E.titles`) say the opt-out is --no-titles, locate claude and codex
// on the daemon's cached login PATH to the recorders, and answer the one-shot's
// launch as the production resolver builds it, compared with the recorder by
// canonical path, and the key NAMES of the daemon's own environment, read inside
// it, are exactly the launch's; no agent CLI is executed inside the daemon (the
// hooks may read a cold login cache, which runs the fixture's stand-in once). The
// recorder's own self-test runs BEFORE the boot, by the fixture itself (`claude
// --version` on the recorder, never a CLI), so the log exists and holds that one
// line from the start. One failed check refuses the
// boot (exit 2) before any chat. From the daemon's start to the exit, in every
// mode, the recorder log is watched: a line that is not the boot check's probe
// stops everything with exit 3. The checked run's last step reads the same log
// and the two homes (names only, nothing of the person's).
//
// Negatives, never a boot with a flag dropped: --red-flags (the argv without
// --no-titles) and --red-interlock (a login shell that puts the real PATH
// back) run under --dry-run only. --mutate divergent-cache (the daemon's cached
// login PATH led by a decoy recorder) and --mutate wrong-resolver (the title
// hooks patched to answer a foreign path) run under --check only, inside the
// child, and the checks must refuse them with nothing executed; --mutate
// decoy-on-process-path is a positive control (the daemon's own PATH led by
// the decoy, the cache intact): a resolver reading the cache still answers the
// recorder and the checks pass. --mutate recorder-removed|recorder-unreadable|
// recorder-truncated damage the fixture's own recorder log after the checks, and
// --mutate recorder-foreign-line|decoy-line write a non-probe line through the
// fixture's own recorder or its decoy (`-p`, never a CLI), all under --check or
// --dry-run; the guard must latch each (exit 3). --check and --dry-run together
// are refused.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { ensureWorkspace } from '../../mobile/scripts/dev-server.mjs'
import { startOidcProvider } from '../../../tests/e2e/fixtures/oidc-provider.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const BUN = path.join(REPO, 'node_modules', '.bin', 'bun')

const OWNER = {
  sub: 'fixture-owner',
  name: 'Fixture Owner',
  email: 'owner@fixture.test',
  email_verified: true
}
const PHONE_REDIRECT = 'clave-android://oauth/callback'
const PHONE = { name: 'fixture check phone', platform: 'android', appVersion: '0.1.0' }

// ── Arguments ───────────────────────────────────────────────────────────────

/** The value after `--<name>`; a value that is itself a flag (`--tmpdir --dry-run`) is no value. */
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0 || i + 1 >= process.argv.length) return fallback
  const value = process.argv[i + 1]
  if (value.startsWith('--')) {
    process.stderr.write(`fixture: --${name} needs a value and was followed by ${value}: refusing\n`)
    process.exit(2)
  }
  return value
}
const flag = (name) => process.argv.includes(`--${name}`)
function portArg(name, fallback) {
  const value = Number(arg(name, String(fallback)))
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    process.stderr.write(`fixture: --${name} must be a port, got ${arg(name)}\n`)
    process.exit(2)
  }
  return value
}

const SERVER_PORT = portArg('server', 47201)
const RELAY_PORT = portArg('relay', 47202)
const ISSUER_PORT = portArg('issuer', 47203)
const TMPDIR_ARG = arg('tmpdir', null)
if (!TMPDIR_ARG) {
  process.stderr.write('fixture: --tmpdir <folder> is required (a run folder of this fixture, never a default): refusing\n')
  process.exit(2)
}
const TMPDIR = path.resolve(TMPDIR_ARG)
const CHECK = flag('check')
const APPROVE = flag('approve')
const DRY_RUN = flag('dry-run')
const RED_FLAGS = flag('red-flags')
const RED_INTERLOCK = flag('red-interlock')
const MUTATE = arg('mutate', null)
/** The faults a run can carry, every flag kept and the real CLI never involved: the two resolver
 *  faults and the positive control run inside the daemon under --check; the three recorder-file
 *  faults damage the fixture's own log and run under --check or --dry-run. */
const DAEMON_MUTATIONS = ['divergent-cache', 'wrong-resolver', 'decoy-on-process-path']
const RECORDER_MUTATIONS = ['recorder-removed', 'recorder-unreadable', 'recorder-truncated', 'recorder-foreign-line', 'decoy-line']
const MUTATIONS = [...DAEMON_MUTATIONS, ...RECORDER_MUTATIONS]
if ((RED_FLAGS || RED_INTERLOCK) && !DRY_RUN) {
  process.stderr.write(
    'fixture: --red-flags and --red-interlock prove the pre-boot checks and run under --dry-run only: a daemon is never started with a flag dropped\n'
  )
  process.exit(2)
}
if (CHECK && DRY_RUN) {
  process.stderr.write('fixture: --check and --dry-run together mean nothing: one boots and proves, the other starts nothing\n')
  process.exit(2)
}
if (MUTATE !== null) {
  const known = MUTATIONS.includes(MUTATE)
  const allowed = known && !APPROVE && (DAEMON_MUTATIONS.includes(MUTATE) ? CHECK : CHECK || DRY_RUN)
  if (!allowed) {
    process.stderr.write(
      `fixture: --mutate takes ${MUTATIONS.join(', ')}; the daemon faults run under --check only, the recorder faults under --check or --dry-run, none under --approve\n`
    )
    process.exit(2)
  }
}

/** The three flags that keep the daemon off every provider: `--no-titles` is its explicit
 *  opt-out of the title one-shot, `--test-no-activate` stops the usage clock, and
 *  `--test-no-machine-usage` keeps an explicit usage read off the machine login's keychain
 *  (test-mode.ts needs both). Lane C's fixture-server.mjs passes the same three, in this order. */
const DAEMON_FLAGS = ['--no-titles', '--test-no-activate', '--test-no-machine-usage']
/** The discovery file's three announcements (clave-server.json), read by name from here only:
 *  `titles` ("off" under --no-titles), `testMode` (true under --test-no-activate; lane C's
 *  name, since `testFixtures` collided with a guard counting that key in the server's main.ts)
 *  and `machineUsage` (false under --test-no-machine-usage). */
const DISCOVERY = { titles: 'titles', testMode: 'testMode', machineUsage: 'machineUsage' }
/** What the daemon's environment may carry of this shell's: nothing else travels. */
const ENV_ALLOWLIST = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ']
/** The same nine names, frozen apart for the check to compare against: an edit of the list
 *  above alone fails the check rather than widening it. */
const ENV_ALLOWLIST_FROZEN = Object.freeze(['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'TERM', 'TMPDIR', 'TZ', 'USER'])
/** What the fixture sets itself. */
const ENV_FIXTURE_KEYS = ['PATH', 'SHELL', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAVE_ANTASPHERE_ISSUER', 'CLAVE_KEYCHAIN_FILE']
/** The daemon's login-environment module, imported inside its own process by one negative only
 *  (the divergent cache); every check reads the production resolver through `__claveE2E.titles`. */
const PTY_BACKEND = path.join(REPO, 'packages', 'host', 'src', 'sessions', 'adapters', 'pty-backend.ts')
/** What the recorder answers a `--version` probe with; the title one-shot (-p) gets nothing. */
const RECORDER_VERSION = 'claude fixture-recorder'
const MARKER_NAME = '.clave-fixture'
/** What the marker must say to be this fixture's: the owner this script writes, and the folder it claimed. */
const MARKER_OWNER = 'apps/mobile-android/scripts/fixture-env.mjs'

const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`
const ISSUER_URL = `http://127.0.0.1:${ISSUER_PORT}`
const SERVER_DATA = path.join(TMPDIR, 'server')

/**
 * The run folder is the fixture's own. A folder this script created carries a marker: a regular
 * file (never a symlink) whose JSON names this script as the owner and the folder's own real
 * path as the one claimed. A folder holding anything without such a marker, a symlink, a plain
 * file, a marker of another owner or a marker that is a symlink is refused untouched: the
 * person's or another lane's data is never emptied by a wrong --tmpdir. A real run empties an
 * owned folder and claims it again. A dry run only reads: it says whether the folder would be
 * accepted or refused, writes nothing into it, and builds its shims in a scratch folder of its
 * own under the system's temp directory, removed at exit.
 */
function markerOf(dir) {
  const marker = path.join(dir, MARKER_NAME)
  let state
  try {
    state = lstatSync(marker)
  } catch {
    return { present: false }
  }
  if (state.isSymbolicLink() || !state.isFile()) return { present: true, ours: false, why: `${MARKER_NAME} is not a regular file` }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(marker, 'utf8'))
  } catch {
    return { present: true, ours: false, why: `${MARKER_NAME} is not this fixture's JSON` }
  }
  if (parsed?.owner !== MARKER_OWNER) return { present: true, ours: false, why: `${MARKER_NAME} names another owner (${JSON.stringify(parsed?.owner ?? null)})` }
  if (parsed?.folder !== realpathSync(dir)) return { present: true, ours: false, why: `${MARKER_NAME} claims another folder (${JSON.stringify(parsed?.folder ?? null)})` }
  const pid = Number(parsed?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return { present: true, ours: false, why: `${MARKER_NAME} names no claiming pid: not written by this fixture` }
  if (pid !== process.pid && alive(pid)) {
    return { present: true, ours: false, why: `${MARKER_NAME} was claimed by a fixture run that is still alive (pid ${pid}, band ${JSON.stringify(parsed?.band ?? null)})` }
  }
  return { present: true, ours: true }
}

/** Whether a process with [pid] exists (a signal of 0 is a question, never a kill). */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function claimRunFolder() {
  if (TMPDIR.split(path.sep).filter(Boolean).length < 2) {
    throw new RefusedBoot('the run folder', [{ name: `${TMPDIR} is too close to the root to be a run folder` }])
  }
  let state
  try {
    state = lstatSync(TMPDIR)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new RefusedBoot('the run folder', [{ name: `${TMPDIR} cannot be inspected (${error?.code ?? error}); nothing was touched` }])
    }
    state = null
  }
  if (state !== null) {
    if (state.isSymbolicLink() || !state.isDirectory()) {
      throw new RefusedBoot('the run folder', [{ name: `${TMPDIR} is not a plain directory; nothing was touched` }])
    }
    let entries
    try {
      entries = readdirSync(TMPDIR)
    } catch (error) {
      throw new RefusedBoot('the run folder', [{ name: `${TMPDIR} cannot be listed (${error?.code ?? error}); nothing was touched` }])
    }
    if (entries.length > 0) {
      const marker = markerOf(TMPDIR)
      if (!marker.present) {
        throw new RefusedBoot('the run folder', [
          { name: `${TMPDIR} holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} and no ${MARKER_NAME} marker: not a run folder of this fixture; nothing was touched` }
        ])
      }
      if (!marker.ours) {
        throw new RefusedBoot('the run folder', [{ name: `${TMPDIR}: ${marker.why}; nothing was touched` }])
      }
    }
    if (DRY_RUN) {
      say(`dry run: ${TMPDIR} would be ${entries.length === 0 ? 'claimed (empty)' : 'emptied and claimed again (this fixture\'s own marker)'}; nothing in it was touched`)
      return
    }
    for (const entry of entries) rmSync(path.join(TMPDIR, entry), { recursive: true, force: true })
  } else {
    if (DRY_RUN) {
      say(`dry run: ${TMPDIR} does not exist and would be created; nothing was touched`)
      return
    }
    mkdirSync(TMPDIR, { recursive: true, mode: 0o700 })
  }
  writeFileSync(
    path.join(TMPDIR, MARKER_NAME),
    JSON.stringify({ owner: MARKER_OWNER, folder: realpathSync(TMPDIR), band: [SERVER_PORT, RELAY_PORT, ISSUER_PORT], claimedAt: new Date().toISOString(), pid: process.pid }) + '\n',
    { mode: 0o600 }
  )
}

/** Where the shims are built: the run folder, or a scratch folder of the dry run's own. */
let SHIMS_ROOT = null
function shimsRoot() {
  if (SHIMS_ROOT) return SHIMS_ROOT
  SHIMS_ROOT = DRY_RUN ? mkdtempSync(path.join(os.tmpdir(), 'clave-fixture-dry-run-')) : TMPDIR
  return SHIMS_ROOT
}

/**
 * The fixture's own login environment and recorders, so no real agent ever runs from it. The
 * daemon's title generator spawns `claude -p` under the person's login on a chat's first
 * message, resolving the binary on the PATH of its login environment, which it reads once
 * through `$SHELL -lic 'env -0'` (pty-backend.ts, getLoginShellEnv): a stub on the daemon's
 * own PATH alone does not hold, since the person's login profile puts the real CLI back ahead
 * of it (what the first stubs let through on 9 November 2026, before this was understood, is in
 * the wave's record: prompts recorded here, whether a request left this Mac not established). So
 * SHELL is a script of the fixture's that prints the daemon's own environment, whose PATH
 * starts with this directory, where `claude` and `codex` are RECORDERS: each invocation is one
 * line in recorder.log (the time, the command, its first two arguments, never the stdin);
 * `claude --version` answers a fixed line so the boot check can probe the one-shot's launch,
 * and anything else drains its stdin and exits 1 so a one-shot that ran anyway gets nothing.
 * CLAUDE_CONFIG_DIR and CODEX_HOME are empty folders here, recreated at every launch. A
 * second, decoy recorder (decoy/claude, decoy.log) sits off every PATH: the negatives put it
 * ahead inside the daemon, so a wrong resolution lands on it and never on the real CLI.
 */
function shimPaths() {
  const dir = path.join(shimsRoot(), 'shims')
  return {
    dir,
    shell: path.join(dir, 'shell'),
    claude: path.join(dir, 'claude'),
    codex: path.join(dir, 'codex'),
    log: path.join(dir, 'recorder.log'),
    decoyDir: path.join(dir, 'decoy'),
    decoy: path.join(dir, 'decoy', 'claude'),
    decoyLog: path.join(dir, 'decoy.log'),
    claudeConfigDir: path.join(dir, 'claude-config'),
    codexHome: path.join(dir, 'codex-home')
  }
}

/** A value for a single-quoted shell literal. */
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

/**
 * Writes the stand-ins. The login shell prints the environment given here, the daemon's own
 * as the fixture built it, written into the script at this moment: never the environment of
 * the process that runs the script. Under --red-interlock its PATH is the real one without
 * the recorders, as a real login profile would put it back.
 */
function writeShims(shims, env) {
  mkdirSync(shims.dir, { recursive: true, mode: 0o700 })
  mkdirSync(shims.decoyDir, { recursive: true, mode: 0o700 })
  rmSync(shims.log, { force: true })
  rmSync(shims.decoyLog, { force: true })
  for (const home of [shims.claudeConfigDir, shims.codexHome]) {
    rmSync(home, { recursive: true, force: true })
    mkdirSync(home, { recursive: true, mode: 0o700 })
  }
  const write = (file, body) => {
    writeFileSync(file, body)
    chmodSync(file, 0o755)
    return file
  }
  const printed = { ...env }
  if (RED_INTERLOCK) printed.PATH = process.env.PATH ?? ''
  const literals = Object.entries(printed).map(([k, v]) => shellQuote(`${k}=${v}`)).join(' ')
  write(
    shims.shell,
    [
      '#!/bin/sh',
      "# The fixture's stand-in for the daemon's login shell. The daemon reads its login environment",
      "# through `$SHELL -lic 'env -0'`; this script answers with the environment the fixture wrote",
      '# into it when it built the launch, never the environment it is run in. A separate `-c <cmd>`',
      '# runs that command with /bin/sh; combined flags (-lic) print the environment whatever follows.',
      'cmd=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -c) shift; cmd="$1" ;;',
      '  esac',
      '  shift',
      'done',
      'if [ -n "$cmd" ] && [ "$cmd" != "env -0" ]; then exec /bin/sh -c "$cmd"; fi',
      `exec printf '%s\\0' ${literals}`,
      ''
    ].join('\n')
  )
  // The recorders: never a real agent. One line per invocation (the time, the command, its first
  // two arguments, never the stdin); `--version` answers a fixed line; a one-shot (-p) drains its
  // stdin and exits 1, so a daemon that asked anyway gets nothing.
  const recorder = (name, file, into) =>
    write(
      file,
      [
        '#!/bin/sh',
        `# The fixture's recorder for the ${name} CLI: never a real agent, never the machine login.`,
        '# One line per invocation (the time, the command, its first two arguments, never the stdin).',
        `printf '%s %s %s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${name}" "$1" "$2" >> ${shellQuote(into)}`,
        'case " $* " in',
        `  *" --version "*) printf '%s\\n' ${shellQuote(RECORDER_VERSION)}; exit 0 ;;`,
        '  *" -p "*|*" --print "*) cat >/dev/null ;;',
        'esac',
        `echo "fixture: no real agent runs here (${name} disabled)" >&2`,
        'exit 1',
        ''
      ].join('\n')
    )
  recorder('claude', shims.claude, shims.log)
  recorder('codex', shims.codex, shims.log)
  recorder('claude', shims.decoy, shims.decoyLog)
  return shims
}

/**
 * The lines a recorder wrote since the launch was built, never a prompt. Absence is told from
 * failure: a log that does not exist yet reads as no lines (nothing was called), a log that
 * exists but cannot be read is a failure of the recorder itself, which the guard treats as a
 * call it could not see. `readRecorder` answers both; `recorderLines` keeps the plain list for
 * the places where absence is fine.
 */
function readRecorder(file) {
  let state
  try {
    state = lstatSync(file)
  } catch {
    return { lines: [], absent: true, error: null }
  }
  if (state.isSymbolicLink() || !state.isFile()) return { lines: [], absent: false, error: `${file} is not a regular file` }
  try {
    return { lines: readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== ''), absent: false, error: null }
  } catch (error) {
    return { lines: [], absent: false, error: `${file} cannot be read: ${error?.code ?? error?.message ?? error}` }
  }
}
function recorderLines(file) {
  return readRecorder(file).lines
}
const isProbe = (line) => /^\S+ claude --version ?$/.test(line)

/** A recorder failure, latched: once set, no later success and no cleanup can bring the exit code
 *  under 3. `exitWith` reads it. */
let recorderFailure = null
function latchRecorderFailure(reason) {
  if (recorderFailure === null) recorderFailure = reason
}

/** Where `command` lives on `pathEnv`: the first directory holding an executable file of
 *  that name, as the host's `findExecutable` looks. */
function locateOnPath(command, pathEnv) {
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, command)
    try {
      accessSync(candidate, fsConstants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* not here */
    }
  }
  return null
}

/** The login environment as the daemon reads it (pty-backend.ts, getLoginShellEnv):
 *  `$SHELL -lic 'env -0'` with the daemon's own environment, parsed. */
function loginShellEnvOf(shell, env) {
  const output = execFileSync(shell, ['-lic', 'env -0'], { env, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  const parsed = {}
  for (const entry of output.split('\0')) {
    const i = entry.indexOf('=')
    if (i > 0) parsed[entry.slice(0, i)] = entry.slice(i + 1)
  }
  return parsed
}

const samePath = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/**
 * The daemon's launch, built once and checked before it is used: the argv with the three
 * flags, and an environment built from the allowlist (a few of this shell's keys) with the
 * recorders first on PATH, the fixture's login shell, empty Claude and Codex homes of the
 * fixture's own, the fixture issuer and the keychain FILE. Nothing else of this shell's
 * environment travels: not its server, not its agent credentials, not its config homes.
 */
function daemonLaunch() {
  const shims = shimPaths()
  const env = {}
  for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key]
  env.PATH = `${shims.dir}${path.delimiter}${process.env.PATH ?? ''}`
  env.SHELL = shims.shell
  env.CLAUDE_CONFIG_DIR = shims.claudeConfigDir
  env.CODEX_HOME = shims.codexHome
  env.CLAVE_ANTASPHERE_ISSUER = ISSUER_URL
  env.CLAVE_KEYCHAIN_FILE = path.join(SERVER_DATA, 'keychain.json')
  writeShims(shims, env)
  const flags = RED_FLAGS ? DAEMON_FLAGS.filter((f) => f !== '--no-titles') : DAEMON_FLAGS
  const args = [
    // Bun's own flag first: no automatic .env file of the repository root reaches the daemon.
    '--no-env-file',
    path.join(REPO, 'apps', 'server', 'src', 'main.ts'),
    '--data-dir',
    SERVER_DATA,
    '--daemon',
    '--port',
    String(SERVER_PORT),
    '--dev-echo-adapter',
    ...flags,
    '--relay',
    RELAY_URL
  ]
  const relayArgs = [
    '--no-env-file',
    path.join(REPO, 'apps', 'relay', 'src', 'main.ts'),
    '--port',
    String(RELAY_PORT),
    '--data-dir',
    RELAY_DATA,
    '--issuer',
    ISSUER_URL
  ]
  return { shims, env, args, relayArgs }
}

/** The key NAMES a Bun process sees under [env] with .env loading off: a probe, never values. */
function bunEnvKeys(env) {
  const output = execFileSync(
    BUN,
    ['--no-env-file', '-e', 'console.log(JSON.stringify(Object.keys(process.env).sort()))'],
    { cwd: REPO, env, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] }
  )
  return JSON.parse(output.trim().split('\n').pop())
}

/** One check line, the shape lane C prints: `check ok` or `check FAIL`, the name, the detail. */
function checker(results) {
  return async (name, fn) => {
    try {
      const detail = await fn()
      results.push({ name, ok: true, detail: detail ?? null })
      say(`check ok    ${name}${detail ? ` (${detail})` : ''}`)
    } catch (error) {
      results.push({ name, ok: false, detail: error?.message ?? String(error) })
      say(`check FAIL  ${name}: ${error?.message ?? error}`)
    }
  }
}
const expectThat = (condition, message) => {
  if (!condition) throw new Error(message)
}

/** A refusal to boot: exit 2, before any chat. */
class RefusedBoot extends Error {
  constructor(stage, failed) {
    super(`the fixture refuses to boot, before any chat (${stage}): ${failed.map((c) => c.name).join('; ')}`)
    this.code = 2
  }
}

/**
 * The checks that run BEFORE anything starts, on the launch the daemon will get: the
 * effective flags, the allowlisted environment with really empty homes, and the post-login
 * executable interlock.
 */
async function preBootChecks(launch) {
  const results = []
  const check = checker(results)
  await check('the effective flags: the daemon argv carries --no-titles, --test-no-activate and --test-no-machine-usage, after Bun\'s --no-env-file', async () => {
    const missing = DAEMON_FLAGS.filter((f) => !launch.args.includes(f))
    expectThat(missing.length === 0, `missing ${missing.join(' ')} in: bun ${launch.args.join(' ')}`)
    expectThat(launch.args[0] === '--no-env-file', `the argv does not start with --no-env-file: bun ${launch.args.join(' ')}`)
    expectThat(launch.relayArgs[0] === '--no-env-file', `the relay's argv does not start with --no-env-file: bun ${launch.relayArgs.join(' ')}`)
    return `--no-env-file ${DAEMON_FLAGS.join(' ')}; the relay under --no-env-file too`
  })
  await check(
    "the daemon's environment is the allowlist and the fixture's keys, with empty Claude and Codex homes of the fixture's own",
    async () => {
      expectThat(
        JSON.stringify([...ENV_ALLOWLIST].sort()) === JSON.stringify([...ENV_ALLOWLIST_FROZEN]),
        `the allowlist was widened or narrowed: ${[...ENV_ALLOWLIST].sort().join(' ')} against the frozen ${[...ENV_ALLOWLIST_FROZEN].join(' ')}`
      )
      const allowed = new Set([...ENV_ALLOWLIST_FROZEN, ...ENV_FIXTURE_KEYS])
      const stray = Object.keys(launch.env).filter((key) => !allowed.has(key))
      expectThat(stray.length === 0, `keys outside the frozen allowlist: ${stray.join(', ')}`)
      // What a Bun process really sees under this environment with .env loading off: the names.
      const seen = bunEnvKeys(launch.env)
      const expected = Object.keys(launch.env).sort()
      const extra = seen.filter((k) => !expected.includes(k))
      const lost = expected.filter((k) => !seen.includes(k))
      expectThat(extra.length === 0 && lost.length === 0, `a Bun child ${extra.length ? `sees extra keys ${extra.join(', ')}` : ''}${extra.length && lost.length ? ' and ' : ''}${lost.length ? `misses ${lost.join(', ')}` : ''}`)
      for (const key of ENV_FIXTURE_KEYS) expectThat(typeof launch.env[key] === 'string' && launch.env[key] !== '', `${key} is not set`)
      for (const [name, home] of [['CLAUDE_CONFIG_DIR', launch.shims.claudeConfigDir], ['CODEX_HOME', launch.shims.codexHome]]) {
        expectThat(launch.env[name] === home, `${name} is ${launch.env[name]}, not the fixture's`)
        expectThat(lstatSync(home).isDirectory() && !lstatSync(home).isSymbolicLink(), `${home} is not a plain directory`)
        const entries = readdirSync(home)
        expectThat(entries.length === 0, `${home} holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`)
      }
      const kept = ENV_ALLOWLIST_FROZEN.filter((key) => key in launch.env)
      return `${Object.keys(launch.env).length} keys: ${kept.join(' ')} of this shell, the ${ENV_FIXTURE_KEYS.length} of the fixture; a Bun child under --no-env-file sees exactly those names; both homes empty`
    }
  )
  await check(
    "the post-login executable interlock: the daemon's SHELL is the fixture's and its login environment ($SHELL -lic 'env -0') resolves claude and codex to the recorders",
    async () => {
      expectThat(samePath(launch.env.SHELL, launch.shims.shell), `the daemon's SHELL would be ${launch.env.SHELL}`)
      const login = loginShellEnvOf(launch.env.SHELL, launch.env)
      const claude = locateOnPath('claude', login.PATH)
      const codex = locateOnPath('codex', login.PATH)
      expectThat(claude && samePath(claude, launch.shims.claude), `claude resolves to ${claude ?? 'nothing'} on the daemon's login PATH`)
      expectThat(codex && samePath(codex, launch.shims.codex), `codex resolves to ${codex ?? 'nothing'} on the daemon's login PATH`)
      return `claude and codex are the recorders under ${launch.shims.dir}`
    }
  )
  await check(
    "the recorder records: run by the fixture itself with --version (never a CLI), it answers the recorder's line and the log holds exactly that one line",
    async () => {
      const answer = execFileSync(launch.shims.claude, ['--version'], { env: launch.env, encoding: 'utf8', timeout: 5000 }).trim()
      expectThat(answer === RECORDER_VERSION, `the recorder answered ${JSON.stringify(answer)}`)
      probesIssued += 1
      const log = readRecorder(launch.shims.log)
      expectThat(log.error === null && !log.absent, log.error ?? 'the recorder log was not written')
      expectThat(log.lines.length === 1 && isProbe(log.lines[0]), `the recorder log holds: ${log.lines.join(' | ')}`)
      return `one probe line in ${launch.shims.log}`
    }
  )
  return results
}

/** A function run inside the daemon's own process through its test fixture route. */
async function evaluate(daemon, source, argument) {
  const answer = await client(daemon.url, daemon.token)('POST', '/e2e/evaluate', { source, arg: argument })
  if (answer.status !== 200 || !answer.body?.ok)
    throw new Error(`POST /e2e/evaluate answered ${answer.status}: ${JSON.stringify(answer.body ?? null).slice(0, 300)}`)
  return answer.body.value
}

/** Inside the daemon: lead a PATH with the decoy recorder (the negatives), or take it off again. */
const PATH_PREFIX_SOURCE = `async (arg) => {
  const m = await import(arg.ptyBackend)
  const target = arg.where === 'cache' ? m.getLoginShellEnv() : process.env
  const parts = (target.PATH ?? '').split(':').filter((p) => p !== arg.decoy)
  target.PATH = (arg.on ? [arg.decoy, ...parts] : parts).join(':')
  return target.PATH
}`

/**
 * The checks that run AFTER the daemon announces itself and BEFORE anything is seeded, each
 * inside the daemon's own process: what the discovery file announces, what its cached login
 * environment resolves, and where the title one-shot's own launch lands.
 */
async function bootChecks(daemon, launch) {
  const results = []
  const check = checker(results)
  const discovery = daemon.discovery
  const shims = launch.shims
  await check('titles off: the daemon announces titles "off" (--no-titles)', async () => {
    expectThat(discovery[DISCOVERY.titles] === 'off', `the discovery file says ${DISCOVERY.titles} ${JSON.stringify(discovery[DISCOVERY.titles] ?? null)}`)
    return 'titles: off'
  })
  await check('test mode on, machine usage off: the daemon announces testMode true and machineUsage false, and answers POST /e2e/evaluate', async () => {
    expectThat(discovery[DISCOVERY.testMode] === true, `${DISCOVERY.testMode} ${JSON.stringify(discovery[DISCOVERY.testMode] ?? null)}`)
    expectThat(discovery[DISCOVERY.machineUsage] === false, `${DISCOVERY.machineUsage} ${JSON.stringify(discovery[DISCOVERY.machineUsage] ?? null)}`)
    const one = await evaluate(daemon, '() => 1')
    expectThat(one === 1, `the fixture route answered ${JSON.stringify(one)}`)
    return 'testMode: true, machineUsage: false, /e2e/evaluate answers'
  })
  // The title module's own test hooks (#354): the opt-out's state, the one-shot's launch as the
  // production resolver answers it, and where a command lives on the cached login PATH; read from
  // inside the daemon, nothing executed. The negatives patch what the hooks or the cache answer.
  const HOOKS_SOURCE = `async (arg) => {
    const t = globalThis.__claveE2E && globalThis.__claveE2E.titles
    if (!t) return null
    const fs = await import('node:fs')
    const real = (file) => { try { return fs.realpathSync(file) } catch { return null } }
    const launch = await t.launch()
    const claude = t.locate('claude')
    const codex = t.locate('codex')
    return {
      disabled: t.disabled(),
      shell: process.env.SHELL ?? null,
      launch: { file: launch.file, real: real(launch.file), args: launch.args, pathEnv: launch.pathEnv ?? null },
      claude: claude, claudeReal: claude ? real(claude) : null,
      codex: codex, codexReal: codex ? real(codex) : null
    }
  }`
  if (MUTATE === 'divergent-cache') {
    const mutated = await evaluate(daemon, PATH_PREFIX_SOURCE, { ptyBackend: PTY_BACKEND, where: 'cache', decoy: shims.decoyDir, on: true })
    say(`mutation  divergent-cache: the daemon's cached login PATH now starts with the decoy (${mutated.split(':')[0]}); the resolver must answer the decoy and the check must refuse`)
  }
  if (MUTATE === 'wrong-resolver') {
    const patched = await evaluate(
      daemon,
      `(arg) => {
        const t = globalThis.__claveE2E && globalThis.__claveE2E.titles
        if (!t) return null
        t.launch = async () => ({ file: arg.foreign, args: ['-p'], pathEnv: process.env.PATH })
        t.locate = () => arg.foreign
        return arg.foreign
      }`,
      { foreign: '/usr/bin/true' }
    )
    say(`mutation  wrong-resolver: the title hooks now answer a foreign path (${patched}); the check must refuse it unrun`)
  }
  if (MUTATE === 'decoy-on-process-path') {
    const mutated = await evaluate(daemon, PATH_PREFIX_SOURCE, { ptyBackend: PTY_BACKEND, where: 'process', decoy: shims.decoyDir, on: true })
    say(`mutation  decoy-on-process-path (a positive control): the daemon's own PATH now starts with the decoy (${mutated.split(':')[0]}) while the cached login PATH is intact; a resolver reading the cache still answers the recorder, so the checks are expected to pass`)
  }
  await check("the daemon's own environment, read inside it, carries exactly the launch's key names", async () => {
    const keys = await evaluate(daemon, '() => Object.keys(process.env).sort()')
    const expected = Object.keys(launch.env).sort()
    const extra = keys.filter((k) => !expected.includes(k))
    const lost = expected.filter((k) => !keys.includes(k))
    expectThat(extra.length === 0 && lost.length === 0, `the daemon sees ${extra.length ? `extra keys ${extra.join(', ')}` : ''}${extra.length && lost.length ? ' and ' : ''}${lost.length ? `misses ${lost.join(', ')}` : ''}`)
    return `${keys.length} keys, the launch's`
  })
  let hooks = null
  await check("the daemon carries the title module's test hooks (__claveE2E.titles, #354) and its opt-out says --no-titles", async () => {
    hooks = await evaluate(daemon, HOOKS_SOURCE, {})
    expectThat(hooks !== null, 'the daemon exposes no __claveE2E.titles: it predates #354; the boot waits for the rebase')
    expectThat(hooks.disabled === '--no-titles', `the title module says disabled by ${JSON.stringify(hooks.disabled)}`)
    return 'titles disabled by --no-titles'
  })
  await check(
    "the daemon's own SHELL is the fixture's, and the title module's locate (its cached login PATH, read inside the daemon) answers the recorders for claude and codex",
    async () => {
      expectThat(hooks !== null, 'no hooks')
      expectThat(samePath(hooks.shell, shims.shell), `the daemon's SHELL is ${hooks.shell}`)
      expectThat(hooks.claudeReal !== null && hooks.claudeReal === realpathSync(shims.claude), `claude locates to ${hooks.claude ?? 'nothing'} on the daemon's cached login PATH`)
      expectThat(hooks.codexReal !== null && hooks.codexReal === realpathSync(shims.codex), `codex locates to ${hooks.codex ?? 'nothing'} on the daemon's cached login PATH`)
      return `claude and codex are the recorders under ${shims.dir}`
    }
  )
  await check(
    "the title one-shot's launch, as the production resolver answers it inside the daemon, is the recorder by canonical path and found on a PATH led by the recorders; no agent CLI is executed",
    async () => {
      expectThat(hooks !== null, 'no hooks')
      const launch = hooks.launch
      expectThat(typeof launch.file === 'string' && launch.file !== '', 'the launch names no file')
      expectThat(
        launch.real !== null && launch.real === realpathSync(shims.claude),
        `the one-shot would run ${launch.real ?? launch.file} (${(launch.args ?? []).join(' ')}); nothing was executed`
      )
      expectThat(typeof launch.pathEnv === 'string' && launch.pathEnv.split(path.delimiter)[0] === shims.dir, `the one-shot's PATH starts with ${(launch.pathEnv ?? '').split(path.delimiter)[0]}`)
      return `${launch.real} ${(launch.args ?? []).slice(0, 2).join(' ')}…, not run`
    }
  )
  if (MUTATE === 'decoy-on-process-path') {
    await evaluate(daemon, PATH_PREFIX_SOURCE, { ptyBackend: PTY_BACKEND, where: 'process', decoy: shims.decoyDir, on: false })
    say('mutation  decoy-on-process-path: the decoy taken off the daemon\'s own PATH again')
  }
  return results
}

/**
 * One look at the owned logs: null when all is as it should be, else the failure in words. The
 * recorder's self-test wrote the log before the boot, so from then on the log must exist, be
 * readable and hold that one probe line: a missing, unreadable or truncated log is a failure of
 * the recorder itself, treated as a call that could not be seen. Any other line, or any decoy
 * line, means an agent CLI was invoked from the fixture.
 */
function recorderVerdict(shims) {
  const log = readRecorder(shims.log)
  const decoy = readRecorder(shims.decoyLog)
  const probes = log.lines.filter(isProbe)
  const unexpected = log.lines.filter((line) => !isProbe(line))
  if (log.error) return `the recorder log is unreadable: ${log.error}`
  if (probesIssued > 0 && log.absent) return `the recorder log is missing after the recorder's self-test wrote it`
  if (probesIssued > 0 && probes.length < probesIssued) return `the recorder log holds ${probes.length} probe line(s), ${probesIssued} expected: truncated`
  if (probes.length > probesIssued) return `the recorder saw ${probes.length} probe line(s), ${probesIssued} issued: ${probes.slice(probesIssued).join(' | ')}`
  if (unexpected.length > 0) return `an agent CLI was invoked from the fixture: ${unexpected.join(' | ')}`
  if (decoy.error) return `the decoy log is unreadable: ${decoy.error}`
  if (decoy.lines.length > 0) return `the decoy recorder saw: ${decoy.lines.join(' | ')}`
  return null
}

/** The recorder's guard, in every mode, from the daemon's start to the exit: one look every half
 *  second; a failure is latched (exit code 3 at the latest exit, whatever happens after) and
 *  everything stops. */
function watchRecorders(shims) {
  const timer = setInterval(() => {
    const failure = recorderVerdict(shims)
    if (failure !== null) {
      latchRecorderFailure(failure)
      note(`recorder: ${failure}; stopping everything`)
      clearInterval(timer)
      void exitWith(3)
    }
  }, 500)
  timer.unref()
  return () => clearInterval(timer)
}

/** How many `claude --version` probes the fixture itself has issued: one, the pre-boot self-test. */
let probesIssued = 0

/** The negatives on the owned files, applied after the checks (under --check, after the boot
 *  checks; under --dry-run, after the pre-boot checks): the recorder log removed, made unreadable,
 *  or truncated to nothing. The guard must latch each, the real CLI never involved. */
function mutateRecorderFiles(shims, env) {
  const invoke = (file) => {
    try {
      execFileSync(file, ['-p'], { input: '', env, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 })
    } catch {
      /* the recorder exits 1 on purpose */
    }
  }
  switch (MUTATE) {
    case 'recorder-foreign-line':
      invoke(shims.claude)
      say("mutation  recorder-foreign-line: the fixture's own recorder was invoked with -p (never a CLI): one non-probe line in the recorder log")
      break
    case 'decoy-line':
      invoke(shims.decoy)
      say("mutation  decoy-line: the decoy recorder was invoked with -p (never a CLI): one line in the decoy log")
      break
    case 'recorder-removed':
      rmSync(shims.log, { force: true })
      say('mutation  recorder-removed: the recorder log was removed after the recorder self-test')
      break
    case 'recorder-unreadable':
      chmodSync(shims.log, 0o000)
      say('mutation  recorder-unreadable: the recorder log was made unreadable after the recorder self-test')
      break
    case 'recorder-truncated':
      writeFileSync(shims.log, '')
      say('mutation  recorder-truncated: the recorder log was truncated after the recorder self-test')
      break
    default:
      break
  }
}

const RELAY_DATA = path.join(TMPDIR, 'relay')
const SCRATCH = path.join(TMPDIR, 'scratch')
const TOKEN_FILE = path.join(TMPDIR, 'server-token')
const FIXTURE_FILE = path.join(TMPDIR, 'fixture.json')

const say = (line) => process.stdout.write(`${line}\n`)
const note = (line) => process.stderr.write(`fixture: ${line}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hex = (n) => randomBytes(n).toString('hex')

// ── The children, and stopping them ─────────────────────────────────────────

/** Every process this script spawned, and nothing else. */
const children = []
let provider = null
let stopping = null

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const hard = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, 8_000)
    child.once('exit', () => {
      clearTimeout(hard)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

function stopAll() {
  if (!stopping)
    stopping = (async () => {
      // The daemon first, so it tells the relay goodbye while the relay listens.
      for (const child of [...children].reverse()) await stopChild(child)
      if (provider) await provider.close().catch(() => {})
    })()
  return stopping
}

/** The launch of this run, once built: the exit takes a last look at its recorders. */
let LAUNCH = null

async function exitWith(code) {
  await stopAll()
  if (DRY_RUN && SHIMS_ROOT !== null) rmSync(SHIMS_ROOT, { recursive: true, force: true })
  if (LAUNCH !== null && !DRY_RUN) {
    const last = recorderVerdict(LAUNCH.shims)
    if (last !== null) latchRecorderFailure(last)
  }
  if (recorderFailure !== null) {
    note(`recorder failure latched: ${recorderFailure}`)
    process.exit(Math.max(code, 3))
  }
  process.exit(code)
}

process.on('SIGINT', () => void exitWith(130))
process.on('SIGTERM', () => void exitWith(143))
process.on('uncaughtException', (error) => {
  note(`error: ${error?.message ?? error}`)
  void exitWith(1)
})
process.on('unhandledRejection', (error) => {
  note(`error: ${error?.message ?? error}`)
  void exitWith(1)
})
// A last resort for an exit that bypassed the handlers: no child outlives us.
process.on('exit', () => {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
})

/** A child under the repository's Bun, its output prefixed and passed through. */
function spawnBun(label, args, env) {
  const child = spawn(BUN, args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  const tail = []
  const relayLines = (stream, sink) => {
    let partial = ''
    stream.on('data', (d) => {
      partial += String(d)
      const lines = partial.split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > 200) tail.shift()
        sink(line)
      }
    })
  }
  const stdoutLines = []
  relayLines(child.stdout, (line) => {
    stdoutLines.push(line)
    process.stderr.write(`${label}: ${line}\n`)
  })
  relayLines(child.stderr, (line) => process.stderr.write(`${label}: ${line}\n`))
  return { child, tail, stdoutLines }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

/** A raw client: a bearer or none; answers `{status, body}` and never throws on a status. */
function client(base, token) {
  const root = String(base).replace(/\/+$/, '')
  return async (method, route, body) => {
    const res = await fetch(root + route, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = { raw: text.slice(0, 400) }
    }
    return { status: res.status, body: parsed }
  }
}

/** Polls `probe` until it answers something truthy, or null at the deadline. */
async function until(probe, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe().catch(() => null)
    if (value) return value
    if (Date.now() > deadline) return null
    await sleep(everyMs)
  }
}

function portBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

// ── Step 1: the provider, the relay, the daemon ─────────────────────────────

/** The fixture binds port 0; for its start alone, that bind is the issuer port. */
async function startProviderOn(port) {
  const original = net.Server.prototype.listen
  net.Server.prototype.listen = function (...args) {
    if (args[0] === 0 && args[1] === '127.0.0.1') args[0] = port
    return original.apply(this, args)
  }
  try {
    return await startOidcProvider({ registrationStatus: 200, user: OWNER })
  } finally {
    net.Server.prototype.listen = original
  }
}

async function startRelay(launch) {
  mkdirSync(RELAY_DATA, { recursive: true, mode: 0o700 })
  // The relay runs no agent; it still gets the launch's argv (checked before the boot) and the
  // fixture's sanitized environment, nothing of the shell's.
  const run = spawnBun('relay', launch.relayArgs, launch.env)
  const url = await until(async () => {
    if (run.child.exitCode !== null) throw new Error('exited')
    for (const line of run.stdoutLines) {
      try {
        const value = JSON.parse(line)
        if (typeof value.url === 'string') return value.url
      } catch {
        /* not the announcement */
      }
    }
    return null
  }, 30_000, 100)
  if (!url) throw new Error(`the relay did not announce itself (exit ${run.child.exitCode})`)
  return run
}

/** The daemon, started with the launch the pre-boot checks passed, and nothing else. */
async function startDaemon(launch) {
  mkdirSync(SERVER_DATA, { recursive: true, mode: 0o700 })
  const run = spawnBun('server', launch.args, launch.env)
  const discoveryFile = path.join(SERVER_DATA, 'clave-server.json')
  const discovery = await until(async () => {
    if (run.child.exitCode !== null) throw new Error('exited')
    const value = JSON.parse(readFileSync(discoveryFile, 'utf8'))
    return value.pid === run.child.pid &&
      typeof value.url === 'string' &&
      typeof value.token === 'string'
      ? value
      : null
  }, 60_000, 100)
  if (!discovery)
    throw new Error(`the daemon did not announce itself (exit ${run.child.exitCode})`)
  return { ...run, url: discovery.url, token: discovery.token, serverId: discovery.serverId, discovery }
}

// ── Step 2: the owner signs in on the daemon ────────────────────────────────

async function signOwnerIn(owner) {
  const started = await owner('POST', '/accounts/antasphere/sign-in', {})
  const handoff = started.body?.handoff
  if (started.status !== 200 || !handoff?.url)
    throw new Error(
      `sign-in answered ${started.status}, phase ${started.body?.status?.phase ?? '?'}, failure ${
        started.body?.status?.lastFailure ?? started.body?._tag ?? 'none'
      }`
    )
  // The shell's own confirmation before it opens the browser (a read).
  await owner('POST', '/accounts/antasphere/handoff/confirm', handoff)
  const browsed = await provider.browse(handoff.url)
  const callbackStatus = browsed.response.status
  let last = null
  const signed = await until(async () => {
    const read = await owner('GET', '/accounts/antasphere')
    last = read.body
    return read.body?.phase === 'signed-in' ? read.body : null
  }, 20_000)
  if (!signed)
    throw new Error(
      `the owner is not signed in: phase ${last?.phase ?? '?'}, failure ${
        last?.lastFailure ?? 'none'
      }, callback ${callbackStatus}`
    )
  return signed
}

// ── Step 3: the relay lists the machine ─────────────────────────────────────

async function waitForMachine(relayRun) {
  const ownerAtRelay = client(RELAY_URL, provider.mintAccessToken({ sub: OWNER.sub }))
  let last = null
  const machine = await until(async () => {
    const read = await ownerAtRelay('GET', '/machines')
    last = read
    return read.body?.machines?.find((m) => m.online) ?? null
  }, 30_000, 500)
  if (!machine) {
    for (const line of relayRun.tail.slice(-30)) process.stderr.write(`relay (tail): ${line}\n`)
    throw new Error(
      `no machine online on the relay after 30 s (last answer ${last?.status}, ${
        last?.body?.machines?.length ?? 0
      } machine(s))`
    )
  }
  return machine
}

// ── Step 4: the scratch workspace and one Echo session ──────────────────────

const FAMILY_FLAG = {
  claude: 'claudeMode',
  antigravity: 'antigravityMode',
  codex: 'codexMode',
  pi: 'piMode'
}

async function timelineItems(call, sessionId) {
  const read = await call('GET', `/sessions/timeline?id=${encodeURIComponent(sessionId)}`)
  if (read.status !== 200) return { status: read.status, items: null, body: read.body }
  return { status: 200, items: read.body?.items ?? [] }
}
const userMessages = (items, text) =>
  items.filter((i) => i.event?.type === 'user_message' && i.event.text === text)
const echoReplied = (items, text) =>
  items.some(
    (i) =>
      i.event?.type === 'assistant_text' &&
      typeof i.event.delta === 'string' &&
      i.event.delta.includes(text)
  )

async function startEchoSession(daemon, owner) {
  const workspace = await ensureWorkspace(daemon.url, daemon.token, SCRATCH, 'scratch')
  const profiles = await owner('GET', '/launch-profiles')
  if (profiles.status !== 200) throw new Error(`/launch-profiles answered ${profiles.status}`)
  const echo = (profiles.body?.customProfiles ?? []).find(
    (p) => p.id === 'dev-echo-adapter' || /echo/i.test(p.name)
  )
  if (!echo) throw new Error('no Echo profile in /launch-profiles (is --dev-echo-adapter on?)')
  const familyFlag = FAMILY_FLAG[echo.family]
  const started = await owner('POST', '/sessions/start', {
    cwd: SCRATCH,
    options: {
      launchProfileId: echo.id,
      launchProfile: echo,
      workspaceId: workspace.id,
      ...(familyFlag ? { [familyFlag]: true } : {})
    }
  })
  if (started.status !== 200 || !started.body?.id)
    throw new Error(
      `/sessions/start answered ${started.status}: ${JSON.stringify(started.body).slice(0, 400)}`
    )
  const sessionId = started.body.id
  const nonce = `fixture-${hex(6)}`
  const written = await owner('POST', '/sessions/write', {
    id: sessionId,
    input: { type: 'user_message', text: nonce, clientMessageId: `fixture-cmid-${hex(8)}` }
  })
  if (written.status !== 200)
    throw new Error(
      `/sessions/write answered ${written.status}: ${JSON.stringify(written.body).slice(0, 400)}`
    )
  const replied = await until(async () => {
    const { items } = await timelineItems(owner, sessionId)
    return items && echoReplied(items, nonce)
  }, 20_000)
  if (!replied) throw new Error(`the Echo did not reply to ${nonce} within 20 s`)
  return { workspace, sessionId, nonce, profile: echo }
}

// ── Step 7: a phone, over HTTP ──────────────────────────────────────────────

/** The phone's own registration at the issuer and its PKCE code flow. */
async function phoneSignsIn() {
  const registration = await fetch(`${ISSUER_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [PHONE_REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Clave on Android (fixture check)',
      application_type: 'native'
    })
  })
  if (registration.status !== 200) throw new Error(`register answered ${registration.status}`)
  const { client_id: clientId } = await registration.json()
  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URL(`${ISSUER_URL}/authorize`)
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('redirect_uri', PHONE_REDIRECT)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('scope', 'openid profile email offline_access')
  authorize.searchParams.set('state', hex(8))
  authorize.searchParams.set('nonce', hex(8))
  authorize.searchParams.set(
    'code_challenge',
    createHash('sha256').update(verifier).digest('base64url')
  )
  authorize.searchParams.set('code_challenge_method', 'S256')
  const sent = await fetch(authorize, { redirect: 'manual' })
  if (sent.status !== 302) throw new Error(`authorize answered ${sent.status}`)
  const back = new URL(sent.headers.get('location'))
  const code = back.searchParams.get('code')
  if (!code) throw new Error(`authorize redirected without a code (${back.searchParams.get('error')})`)
  const exchanged = await fetch(`${ISSUER_URL}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: PHONE_REDIRECT,
      client_id: clientId,
      code_verifier: verifier
    })
  })
  if (exchanged.status !== 200) throw new Error(`token answered ${exchanged.status}`)
  const tokens = await exchanged.json()
  if (!tokens.id_token || !tokens.access_token) throw new Error('token answered no ID token')
  return { clientId, idToken: tokens.id_token, accessToken: tokens.access_token }
}

/** A push socket through the relay road, its frames queued. */
function pushSocket(url, origin) {
  const ws = new WebSocket(url, { headers: { origin } })
  const frames = []
  const waiting = []
  ws.on('message', (data) => {
    let frame
    try {
      frame = JSON.parse(data.toString())
    } catch {
      return
    }
    const next = waiting.shift()
    if (next) next(frame)
    else frames.push(frame)
  })
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade answered ${res.statusCode}`)))
  })
  const next = (timeoutMs) =>
    frames.length
      ? Promise.resolve(frames.shift())
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no frame')), timeoutMs)
          waiting.push((frame) => {
            clearTimeout(timer)
            resolve(frame)
          })
        })
  /** The first frame of `tag`, skipping the others (stream frames after a subscribe). */
  const nextOf = async (tag, timeoutMs = 8_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`no ${tag} frame`)
      const frame = await next(left)
      if (frame?._tag === tag) return frame
      if (frame?._tag === 'error' || frame?._tag === 'refused')
        throw new Error(`${frame._tag}: ${frame.message ?? frame.reason ?? ''}`)
    }
  }
  return { ws, opened, nextOf, send: (frame) => ws.send(JSON.stringify(frame)) }
}

async function runCheck(env) {
  const results = []
  let failed = false
  const step = async (name, fn) => {
    if (failed) {
      results.push(`- ${name} (not run)`)
      say(`- ${name} (not run)`)
      return undefined
    }
    try {
      const detail = await fn()
      const line = `✓ ${name}${detail ? ` (${detail})` : ''}`
      results.push(line)
      say(line)
      return true
    } catch (error) {
      failed = true
      const line = `✗ ${name}: ${error?.message ?? error}`
      results.push(line)
      say(line)
      return false
    }
  }
  const expect = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const brief = (body) => JSON.stringify(body ?? null).slice(0, 300)

  const owner = client(env.serverUrl, env.serverToken)
  const stranger = client(`${RELAY_URL}/m/${env.machineId}`, null)
  let phone, pairingId, deviceSession, device, checkText, checkCmid, firstWrite

  await step('the phone registers its own client at the issuer and signs in (PKCE)', async () => {
    phone = await phoneSignsIn()
    return `client ${phone.clientId}`
  })
  await step('the relay lists the machine to the phone', async () => {
    const read = await client(RELAY_URL, phone.accessToken)('GET', '/machines')
    expect(read.status === 200, `GET /machines answered ${read.status}`)
    const machine = read.body?.machines?.find((m) => m.id === env.machineId)
    expect(machine, `machine ${env.machineId} not listed`)
    expect(machine.online, 'the machine is offline')
    return `${machine.id}, ${machine.name}, online`
  })
  await step('the phone asks to pair through the relay, no bearer', async () => {
    const asked = await stranger('POST', '/devices/pair', {
      idToken: phone.idToken,
      clientId: phone.clientId,
      device: PHONE
    })
    expect(
      asked.status === 200 && typeof asked.body?.pairingId === 'string',
      `POST /devices/pair answered ${asked.status}: ${brief(asked.body)}`
    )
    pairingId = asked.body.pairingId
    return `pairing ${pairingId}`
  })
  await step('the pairing reads pending', async () => {
    const read = await stranger('GET', `/devices/pair?id=${encodeURIComponent(pairingId)}`)
    expect(read.body?.status === 'pending', `answered ${read.status}: ${brief(read.body)}`)
    return 'pending'
  })
  await step('the owner approves it on the daemon', async () => {
    const approved = await owner('POST', '/devices/approve', { pairingId })
    expect(
      approved.status === 200 && approved.body?.id,
      `POST /devices/approve answered ${approved.status}: ${brief(approved.body)}`
    )
    return `device ${approved.body.id}`
  })
  await step('the pairing reads approved with the device session, once', async () => {
    const read = await stranger('GET', `/devices/pair?id=${encodeURIComponent(pairingId)}`)
    expect(
      read.body?.status === 'approved' && read.body.deviceSession?.token,
      `answered ${read.status}, status ${read.body?.status}, session ${read.body?.deviceSession ? 'present' : 'absent'}`
    )
    deviceSession = read.body.deviceSession
    const again = await stranger('GET', `/devices/pair?id=${encodeURIComponent(pairingId)}`)
    expect(
      again.body?.status === 'approved' && !again.body.deviceSession,
      `the second read answered ${again.status}, status ${again.body?.status}, session ${again.body?.deviceSession ? 'present' : 'absent'}`
    )
    device = client(`${RELAY_URL}/m/${env.machineId}`, deviceSession.token)
    return `device ${deviceSession.deviceId}, server ${deviceSession.serverId}; second read without it`
  })
  await step('GET /devices/me through the relay', async () => {
    const me = await device('GET', '/devices/me')
    expect(me.status === 200 && me.body?.id === deviceSession.deviceId, `answered ${me.status}: ${brief(me.body)}`)
    return `200, ${me.body.name}, ${me.body.platform}`
  })
  await step('GET /sessions through the relay holds the Echo session', async () => {
    const read = await device('GET', '/sessions')
    expect(read.status === 200, `answered ${read.status}`)
    const list = Array.isArray(read.body) ? read.body : (read.body?.sessions ?? [])
    expect(list.some((s) => s.id === env.sessionId), `session ${env.sessionId} not listed`)
    return `200, ${list.length} session(s)`
  })
  await step('GET /devices through the relay is refused (the device-session boundary)', async () => {
    const read = await device('GET', '/devices')
    const detail = `${read.status} ${read.body?.error ?? ''}: ${read.body?.message ?? ''}`
    expect(
      read.status === 403 &&
        read.body?.error === 'Forbidden' &&
        read.body?.message === 'A phone may not do this.',
      `answered ${detail}`
    )
    return detail
  })
  await step('GET /sessions/timeline through the relay holds the nonce with a position', async () => {
    const { status, items } = await timelineItems(device, env.sessionId)
    expect(items, `answered ${status}`)
    const hit = userMessages(items, env.nonce)[0]
    expect(hit, `${env.nonce} not in ${items.length} item(s)`)
    expect(hit.position !== undefined && hit.position !== null, 'the item has no position')
    return `${env.nonce} at ${JSON.stringify(hit.position)}`
  })
  await step('POST /sessions/write through the relay is accepted', async () => {
    checkText = `check-${hex(6)}`
    checkCmid = `check-cmid-${hex(8)}`
    const written = await device('POST', '/sessions/write', {
      id: env.sessionId,
      input: { type: 'user_message', text: checkText, clientMessageId: checkCmid }
    })
    expect(
      written.status === 200 && written.body?.status === 'accepted',
      `answered ${written.status}: ${brief(written.body)}`
    )
    firstWrite = written.body
    return `${checkText}, accepted`
  })
  await step('the same clientMessageId again answers the same, and writes nothing', async () => {
    const again = await device('POST', '/sessions/write', {
      id: env.sessionId,
      input: { type: 'user_message', text: checkText, clientMessageId: checkCmid }
    })
    expect(
      again.status === 200 && again.body?.status === 'accepted',
      `answered ${again.status}: ${brief(again.body)}`
    )
    expect(
      again.body.at === firstWrite.at,
      `the second answer's time differs (${again.body.at} vs ${firstWrite.at})`
    )
    return 'accepted, same answer'
  })
  await step("the Echo replies to the check text, and the timeline holds it once", async () => {
    let count = 0
    const replied = await until(async () => {
      const { items } = await timelineItems(device, env.sessionId)
      if (!items) return null
      count = userMessages(items, checkText).length
      return echoReplied(items, checkText)
    }, 20_000)
    expect(replied, `no Echo reply to ${checkText} within 20 s`)
    await sleep(500)
    const { items } = await timelineItems(device, env.sessionId)
    count = userMessages(items ?? [], checkText).length
    expect(count === 1, `${checkText} is in the timeline ${count} time(s)`)
    return 'replied; once'
  })
  await step('GET /sessions/writes reads accepted', async () => {
    const read = await device(
      'GET',
      `/sessions/writes?id=${encodeURIComponent(env.sessionId)}&clientMessageId=${encodeURIComponent(checkCmid)}`
    )
    expect(read.status === 200 && read.body?.status === 'accepted', `answered ${read.status}: ${brief(read.body)}`)
    return 'accepted'
  })
  await step('the push channel through the relay: welcome, then subscribed', async () => {
    const socket = pushSocket(
      `ws://127.0.0.1:${RELAY_PORT}/m/${env.machineId}/push`,
      new URL(RELAY_URL).origin
    )
    try {
      await socket.opened
      socket.send({ _tag: 'hello', token: deviceSession.token, client: 'fixture-check' })
      const welcome = await socket.nextOf('welcome')
      socket.send({ _tag: 'subscribe', sessionId: env.sessionId })
      const subscribed = await socket.nextOf('subscribed')
      expect(subscribed.sessionId === env.sessionId, `subscribed to ${subscribed.sessionId}`)
      return `welcome (protocol ${welcome.protocol ?? '?'}), subscribed ${subscribed.sessionId}`
    } finally {
      socket.ws.close()
    }
  })
  await step('the owner revokes the device; its next GET /sessions is refused', async () => {
    const revoked = await owner('POST', '/devices/revoke', { deviceId: deviceSession.deviceId })
    expect(
      revoked.status === 204 || revoked.status === 200,
      `POST /devices/revoke answered ${revoked.status}: ${brief(revoked.body)}`
    )
    let last = null
    const refused = await until(async () => {
      last = await device('GET', '/sessions')
      return last.status === 401
    }, 10_000)
    expect(refused, `GET /sessions answered ${last?.status} after the revocation`)
    return `revoke ${revoked.status}; GET /sessions 401`
  })
  await step('no agent CLI was invoked from the fixture: the recorder log holds the self-test\'s one probe and nothing else, the decoy log is empty, the two homes are still empty', async () => {
    expect(recorderFailure === null, `a recorder failure is latched: ${recorderFailure}`)
    const log = readRecorder(env.shims.log)
    expect(log.error === null && !log.absent, log.error ?? 'the recorder log is missing')
    const unexpected = log.lines.filter((line) => !isProbe(line))
    expect(unexpected.length === 0, `the recorders saw: ${unexpected.join(' | ')}`)
    expect(log.lines.filter(isProbe).length === probesIssued, `${log.lines.filter(isProbe).length} probe line(s), ${probesIssued} expected`)
    const decoy = recorderLines(env.shims.decoyLog)
    expect(decoy.length === 0, `the decoy recorder saw: ${decoy.join(' | ')}`)
    for (const home of [env.shims.claudeConfigDir, env.shims.codexHome]) {
      const entries = readdirSync(home)
      expect(entries.length === 0, `${home} now holds: ${entries.join(', ')}`)
    }
    return 'one probe, nothing else; both homes empty'
  })
  return !failed
}

// ── Step 6: approve every phone that asks ───────────────────────────────────

async function approveForever(owner) {
  const seen = new Set()
  for (;;) {
    const read = await owner('GET', '/devices').catch(() => null)
    for (const pending of read?.body?.pending ?? []) {
      if (seen.has(pending.id)) continue
      seen.add(pending.id)
      const approved = await owner('POST', '/devices/approve', { pairingId: pending.id })
      if (approved.status === 200)
        say(
          `approved: ${pending.name} (${pending.platform}), device ${approved.body?.id}, pairing ${pending.id}`
        )
      else note(`approve of pairing ${pending.id} answered ${approved.status}`)
    }
    await sleep(2_000)
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(BUN)) throw new Error(`bun not found at ${BUN}`)
  if (!DRY_RUN) {
    for (const port of [SERVER_PORT, RELAY_PORT, ISSUER_PORT])
      if (await portBusy(port)) throw new Error(`port ${port} is in use on 127.0.0.1: stopping`)
  }
  // The run folder: ours, or refused untouched.
  claimRunFolder()

  // Before anything starts: the launch the daemon will get, checked.
  const launch = daemonLaunch()
  LAUNCH = launch
  const pre = await preBootChecks(launch)
  const preFailed = pre.filter((c) => !c.ok)
  if (DRY_RUN) {
    say(`dry run: would start the daemon as: bun ${launch.args.join(' ')}`)
    say(`dry run: SHELL=${launch.env.SHELL} CLAUDE_CONFIG_DIR=${launch.env.CLAUDE_CONFIG_DIR} CODEX_HOME=${launch.env.CODEX_HOME}`)
    say(preFailed.length ? 'dry run: the pre-boot checks FAILED; a boot would be refused (exit 2)' : 'dry run: the pre-boot checks passed; nothing was started (the boot checks run only on a boot)')
    if (MUTATE !== null) {
      mutateRecorderFiles(launch.shims, launch.env)
      const verdict = recorderVerdict(launch.shims)
      if (verdict !== null) latchRecorderFailure(verdict)
      say(verdict !== null ? `dry run: the recorder guard's one look latched: ${verdict} (exit 3)` : 'dry run: the recorder guard saw nothing wrong after the mutation: the negative did NOT go red')
    }
    say(`dry run: the shims were built in the scratch folder ${shimsRoot()}, removed now; ${TMPDIR} was only read`)
    rmSync(shimsRoot(), { recursive: true, force: true })
    return exitWith(preFailed.length ? 2 : 0)
  }
  if (preFailed.length) throw new RefusedBoot('pre-boot', preFailed)

  provider = await startProviderOn(ISSUER_PORT)
  if (provider.issuer !== ISSUER_URL)
    throw new Error(`the provider's issuer is ${provider.issuer}, not ${ISSUER_URL}`)
  note(`issuer ${provider.issuer}`)

  const relayRun = await startRelay(launch)
  note(`relay ${RELAY_URL}`)

  const daemon = await startDaemon(launch)
  note(`server ${daemon.url} (server id ${daemon.serverId ?? '?'})`)
  // From here to the exit, in every mode: a recorder line that is not the boot check's probe stops everything.
  watchRecorders(launch.shims)
  writeFileSync(TOKEN_FILE, daemon.token, { mode: 0o600 })
  chmodSync(TOKEN_FILE, 0o600)

  // After the announcement, before any sign-in or chat: what the daemon says of itself.
  const boot = await bootChecks(daemon, launch)
  const bootFailed = boot.filter((c) => !c.ok)
  if (bootFailed.length) throw new RefusedBoot('after the boot, before any chat', bootFailed)
  mutateRecorderFiles(launch.shims, launch.env)
  const owner = client(daemon.url, daemon.token)

  const signed = await signOwnerIn(owner)
  note(`owner signed in as ${signed.account?.email ?? OWNER.email}`)

  const machine = await waitForMachine(relayRun)
  note(`machine ${machine.id} (${machine.name}) online on the relay`)

  const echo = await startEchoSession(daemon, owner)
  note(`session ${echo.sessionId} in workspace ${echo.workspace.id}, Echo replied to ${echo.nonce}`)

  const fixture = {
    serverUrl: daemon.url,
    relayUrl: RELAY_URL,
    issuerUrl: ISSUER_URL,
    machineId: machine.id,
    machineName: machine.name,
    workspaceId: echo.workspace.id,
    sessionId: echo.sessionId,
    nonce: echo.nonce,
    owner: { sub: OWNER.sub, email: OWNER.email },
    tokenFile: TOKEN_FILE
  }
  writeFileSync(FIXTURE_FILE, JSON.stringify(fixture, null, 2) + '\n', { mode: 0o600 })
  say(`CLAVE_FIXTURE_SERVER_URL=${fixture.serverUrl}`)
  say(`CLAVE_FIXTURE_RELAY_URL=${fixture.relayUrl}`)
  say(`CLAVE_FIXTURE_ISSUER_URL=${fixture.issuerUrl}`)
  say(`CLAVE_FIXTURE_TOKEN_FILE=${fixture.tokenFile}`)
  say(`CLAVE_FIXTURE_MACHINE_ID=${fixture.machineId}`)
  say(`CLAVE_FIXTURE_WORKSPACE_ID=${fixture.workspaceId}`)
  say(`CLAVE_FIXTURE_SESSION_ID=${fixture.sessionId}`)
  say(`CLAVE_FIXTURE_NONCE=${fixture.nonce}`)
  say(`fixture: ${FIXTURE_FILE}`)

  if (CHECK) {
    const ok = await runCheck({ ...fixture, serverToken: daemon.token, shims: launch.shims })
    say(ok ? 'check: passed' : 'check: FAILED')
    return exitWith(ok ? 0 : 1)
  }

  for (const run of [relayRun, daemon])
    run.child.once('exit', (code, signal) => {
      if (stopping) return
      note(`a child exited (${code ?? signal}); stopping`)
      void exitWith(1)
    })
  if (APPROVE) {
    say('fixture: running; approving every phone that asks; Ctrl-C stops it')
    await approveForever(owner)
  } else {
    say('fixture: running; Ctrl-C stops it')
  }
}

main().catch((error) => {
  note(`error: ${error?.message ?? error}`)
  void exitWith(error?.code === 2 ? 2 : 1)
})



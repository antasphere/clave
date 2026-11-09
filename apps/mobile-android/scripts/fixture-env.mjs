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
// start, and exits 0 or 2: nothing is started; it proves the pre-boot checks and
// nothing else (not the boot checks, not the recorder's guard).
// Otherwise it keeps running until SIGINT/SIGTERM, which stops every child.
//
// The run folder (--tmpdir) is the fixture's own: a folder it created, marked
// with `.clave-fixture`. An existing folder without the marker, a symlink or a
// file is refused untouched (exit 2); a marked folder is emptied at each run.
//
// No real agent, no real login, proven before and after the boot and watched
// for the whole run. BEFORE anything starts (preBootChecks): the daemon argv
// carries --no-titles --test-no-activate --test-no-machine-usage; its environment
// is built from an allowlist (the fixture's own keys over a few of the shell's)
// with the recorders first on PATH, the fixture's login shell as SHELL and empty
// Claude and Codex homes of the fixture's own; the login environment, read the
// way the daemon reads it (`$SHELL -lic 'env -0'` on that environment), resolves
// `claude` and `codex` to the recorders. AFTER the daemon announces itself and
// BEFORE anything is seeded (bootChecks, each inside the daemon's own process
// through POST /e2e/evaluate): its discovery file says titles "off", testMode
// true and machineUsage false; its cached login environment (getLoginShellEnv)
// resolves the two commands to the recorders; the title one-shot's own launch
// (buildOneShotLaunch, the resolver the title generator uses) is built and its
// file compared with the recorder's BEFORE anything runs, then run with
// --version for the probe line. One failed check refuses the
// boot (exit 2) before any chat. From the daemon's start to the exit, in every
// mode, the recorder log is watched: a line that is not the boot check's probe
// stops everything with exit 3. The checked run's last step reads the same log
// and the two homes (names only, nothing of the person's).
//
// Negatives, never a boot with a flag dropped: --red-flags (the argv without
// --no-titles) and --red-interlock (a login shell that puts the real PATH
// back) run under --dry-run only; --mutate divergent-cache (the daemon's cached
// login PATH led by a decoy recorder) and --mutate wrong-resolver (the daemon's
// own PATH led by the decoy, the cache intact) run under --check only, inside
// the child, and every path they open leads to a recorder, never to the real CLI.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import net from 'node:net'
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

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
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
const TMPDIR = path.resolve(arg('tmpdir', '/private/tmp/clave-native-b/fixture'))
const CHECK = flag('check')
const APPROVE = flag('approve')
const DRY_RUN = flag('dry-run')
const RED_FLAGS = flag('red-flags')
const RED_INTERLOCK = flag('red-interlock')
const MUTATE = arg('mutate', null)
const MUTATIONS = ['divergent-cache', 'wrong-resolver']
if ((RED_FLAGS || RED_INTERLOCK) && !DRY_RUN) {
  process.stderr.write(
    'fixture: --red-flags and --red-interlock prove the pre-boot checks and run under --dry-run only: a daemon is never started with a flag dropped\n'
  )
  process.exit(2)
}
if (MUTATE !== null && (!MUTATIONS.includes(MUTATE) || !CHECK || APPROVE || DRY_RUN)) {
  process.stderr.write(
    `fixture: --mutate takes ${MUTATIONS.join(' or ')} and runs under --check only (never --approve, never --dry-run)\n`
  )
  process.exit(2)
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
/** What the fixture sets itself. */
const ENV_FIXTURE_KEYS = ['PATH', 'SHELL', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAVE_ANTASPHERE_ISSUER', 'CLAVE_KEYCHAIN_FILE']
/** The daemon's modules the boot checks import inside its own process. */
const PTY_BACKEND = path.join(REPO, 'packages', 'host', 'src', 'sessions', 'adapters', 'pty-backend.ts')
const ONE_SHOT = path.join(REPO, 'packages', 'host', 'src', 'claude-one-shot.ts')
const PROFILES = path.join(REPO, 'packages', 'host', 'src', 'launch-profile-manager.ts')
/** What the recorder answers a `--version` probe with; the title one-shot (-p) gets nothing. */
const RECORDER_VERSION = 'claude fixture-recorder'
const MARKER_NAME = '.clave-fixture'

const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`
const ISSUER_URL = `http://127.0.0.1:${ISSUER_PORT}`
const SERVER_DATA = path.join(TMPDIR, 'server')

/**
 * The run folder is the fixture's own. A folder this script created carries the marker; a
 * folder without it that holds anything, a symlink or a plain file is refused untouched: the
 * person's or another lane's data is never emptied by a wrong --tmpdir. A real run empties an
 * owned folder; a dry run keeps what is there.
 */
function claimRunFolder() {
  if (TMPDIR.split(path.sep).filter(Boolean).length < 2) {
    throw new RefusedBoot('the run folder', [{ name: `${TMPDIR} is too close to the root to be a run folder` }])
  }
  const marker = path.join(TMPDIR, MARKER_NAME)
  let state
  try {
    state = lstatSync(TMPDIR)
  } catch {
    state = null
  }
  if (state !== null) {
    if (state.isSymbolicLink() || !state.isDirectory()) {
      throw new RefusedBoot('the run folder', [{ name: `${TMPDIR} is not a plain directory; nothing was touched` }])
    }
    const entries = readdirSync(TMPDIR)
    if (entries.length > 0 && !existsSync(marker)) {
      throw new RefusedBoot('the run folder', [
        { name: `${TMPDIR} holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} and no ${MARKER_NAME} marker: not a run folder of this fixture; nothing was touched` }
      ])
    }
    if (!DRY_RUN) {
      for (const entry of entries) rmSync(path.join(TMPDIR, entry), { recursive: true, force: true })
    }
  } else {
    mkdirSync(TMPDIR, { recursive: true, mode: 0o700 })
  }
  writeFileSync(
    marker,
    JSON.stringify({ owner: 'apps/mobile-android/scripts/fixture-env.mjs', claimedAt: new Date().toISOString(), pid: process.pid }) + '\n',
    { mode: 0o600 }
  )
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
function agentShims() {
  const dir = path.join(TMPDIR, 'shims')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const log = path.join(dir, 'recorder.log')
  const decoyDir = path.join(dir, 'decoy')
  const decoyLog = path.join(dir, 'decoy.log')
  mkdirSync(decoyDir, { recursive: true, mode: 0o700 })
  rmSync(log, { force: true })
  rmSync(decoyLog, { force: true })
  const claudeConfigDir = path.join(dir, 'claude-config')
  const codexHome = path.join(dir, 'codex-home')
  for (const home of [claudeConfigDir, codexHome]) {
    rmSync(home, { recursive: true, force: true })
    mkdirSync(home, { recursive: true, mode: 0o700 })
  }
  const write = (file, body) => {
    writeFileSync(file, body)
    chmodSync(file, 0o755)
    return file
  }
  // The login shell: `$SHELL -lic 'env -0'` prints this environment; a `-c` command runs
  // with /bin/sh. Under --red-interlock it puts the PATH the fixture was started with back,
  // the way a real login profile does, so the interlock check must fail.
  const shell = write(
    path.join(dir, 'shell'),
    RED_INTERLOCK
      ? `#!/bin/sh\n# RED: a login shell that restores the real PATH, as a login profile would.\nPATH='${(process.env.PATH ?? '').replace(/'/g, '')}' exec /usr/bin/env -0\n`
      : [
          '#!/bin/sh',
          "# The fixture's stand-in for the daemon's login shell: the daemon reads its login",
          "# environment through `$SHELL -lic 'env -0'`, and this environment is the fixture's own,",
          '# its PATH starting with the recorders. A `-c` command runs with /bin/sh.',
          'cmd=""',
          'while [ $# -gt 0 ]; do',
          '  case "$1" in',
          '    -c) shift; cmd="$1" ;;',
          '  esac',
          '  shift',
          'done',
          'case "$cmd" in',
          '  ""|"env -0") exec /usr/bin/env -0 ;;',
          '  *) exec /bin/sh -c "$cmd" ;;',
          'esac',
          ''
        ].join('\n')
  )
  const recorder = (name, file, into) =>
    write(
      file,
      [
        '#!/bin/sh',
        `# The fixture's recorder for the ${name} CLI: never a real agent, never the machine login.`,
        '# One line per invocation (the time, the command, its first two arguments, never the stdin).',
        `printf '%s %s %s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${name}" "$1" "$2" >> '${into}'`,
        'case " $* " in',
        `  *" --version "*) printf '%s\\n' '${RECORDER_VERSION}'; exit 0 ;;`,
        '  *" -p "*|*" --print "*) cat >/dev/null ;;',
        'esac',
        `echo "fixture: no real agent runs here (${name} disabled)" >&2`,
        'exit 1',
        ''
      ].join('\n')
    )
  return {
    dir,
    shell,
    claude: recorder('claude', path.join(dir, 'claude'), log),
    codex: recorder('codex', path.join(dir, 'codex'), log),
    log,
    decoyDir,
    decoy: recorder('claude', path.join(decoyDir, 'claude'), decoyLog),
    decoyLog,
    claudeConfigDir,
    codexHome
  }
}

/** The lines a recorder wrote since the launch was built; never a prompt. */
function recorderLines(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
  } catch {
    return []
  }
}
const isProbe = (line) => / claude --version /.test(line + ' ')

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
  const shims = agentShims()
  const env = {}
  for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key]
  env.PATH = `${shims.dir}${path.delimiter}${process.env.PATH ?? ''}`
  env.SHELL = shims.shell
  env.CLAUDE_CONFIG_DIR = shims.claudeConfigDir
  env.CODEX_HOME = shims.codexHome
  env.CLAVE_ANTASPHERE_ISSUER = ISSUER_URL
  env.CLAVE_KEYCHAIN_FILE = path.join(SERVER_DATA, 'keychain.json')
  const flags = RED_FLAGS ? DAEMON_FLAGS.filter((f) => f !== '--no-titles') : DAEMON_FLAGS
  const args = [
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
  return { shims, env, args }
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
  await check('the effective flags: the daemon argv carries --no-titles, --test-no-activate and --test-no-machine-usage', async () => {
    const missing = DAEMON_FLAGS.filter((f) => !launch.args.includes(f))
    expectThat(missing.length === 0, `missing ${missing.join(' ')} in: bun ${launch.args.join(' ')}`)
    return DAEMON_FLAGS.join(' ')
  })
  await check(
    "the daemon's environment is the allowlist and the fixture's keys, with empty Claude and Codex homes of the fixture's own",
    async () => {
      const allowed = new Set([...ENV_ALLOWLIST, ...ENV_FIXTURE_KEYS])
      const stray = Object.keys(launch.env).filter((key) => !allowed.has(key))
      expectThat(stray.length === 0, `keys outside the allowlist: ${stray.join(', ')}`)
      for (const key of ENV_FIXTURE_KEYS) expectThat(typeof launch.env[key] === 'string' && launch.env[key] !== '', `${key} is not set`)
      for (const [name, home] of [['CLAUDE_CONFIG_DIR', launch.shims.claudeConfigDir], ['CODEX_HOME', launch.shims.codexHome]]) {
        expectThat(launch.env[name] === home, `${name} is ${launch.env[name]}, not the fixture's`)
        expectThat(lstatSync(home).isDirectory() && !lstatSync(home).isSymbolicLink(), `${home} is not a plain directory`)
        const entries = readdirSync(home)
        expectThat(entries.length === 0, `${home} holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`)
      }
      const kept = ENV_ALLOWLIST.filter((key) => key in launch.env)
      return `${Object.keys(launch.env).length} keys: ${kept.join(' ')} of this shell, the ${ENV_FIXTURE_KEYS.length} of the fixture; both homes empty`
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
  if (MUTATE === 'divergent-cache') {
    const mutated = await evaluate(daemon, PATH_PREFIX_SOURCE, { ptyBackend: PTY_BACKEND, where: 'cache', decoy: shims.decoyDir, on: true })
    say(`mutation  divergent-cache: the daemon's cached login PATH now starts with the decoy (${mutated.split(':')[0]})`)
  }
  if (MUTATE === 'wrong-resolver') {
    const mutated = await evaluate(daemon, PATH_PREFIX_SOURCE, { ptyBackend: PTY_BACKEND, where: 'process', decoy: shims.decoyDir, on: true })
    say(`mutation  wrong-resolver: the daemon's own PATH now starts with the decoy (${mutated.split(':')[0]}), its cached login PATH intact`)
  }
  await check(
    "the daemon's own SHELL is the fixture's and its CACHED login environment (getLoginShellEnv, read inside the daemon) resolves claude and codex to the recorders",
    async () => {
      const inside = await evaluate(
        daemon,
        `async (arg) => {
          const m = await import(arg.ptyBackend)
          const login = m.getLoginShellEnv()
          return { shell: process.env.SHELL ?? null, userShell: m.getUserShell(), loginShell: login.SHELL ?? null, loginPath: login.PATH ?? null, keys: Object.keys(login).length }
        }`,
        { ptyBackend: PTY_BACKEND }
      )
      expectThat(samePath(inside.shell, shims.shell), `the daemon's SHELL is ${inside.shell}`)
      expectThat(samePath(inside.userShell, shims.shell), `the daemon reads its login shell as ${inside.userShell}`)
      expectThat(inside.loginPath, 'the cached login environment has no PATH')
      const claude = locateOnPath('claude', inside.loginPath)
      const codex = locateOnPath('codex', inside.loginPath)
      expectThat(claude && samePath(claude, shims.claude), `claude resolves to ${claude ?? 'nothing'} on the daemon's cached login PATH`)
      expectThat(codex && samePath(codex, shims.codex), `codex resolves to ${codex ?? 'nothing'} on the daemon's cached login PATH`)
      return `${inside.keys} keys cached; claude and codex are the recorders under ${shims.dir}`
    }
  )
  // The one-shot's launch, built inside the daemon exactly as the title generator builds it;
  // executed only when `execute` is set, and only after the parent has compared its file.
  const ONE_SHOT_SOURCE = `async (arg) => {
    const m = await import(arg.ptyBackend)
    const o = await import(arg.oneShot)
    const { launchProfileManager } = await import(arg.profiles)
    const launch = o.buildOneShotLaunch({
      profile: launchProfileManager.resolveClaudeCli(null, null),
      args: ['--version'],
      loginEnv: m.getLoginShellEnv(),
      account: {},
      userShell: m.getUserShell()
    })
    const built = { file: launch.file, args: launch.args, path: launch.env.PATH ?? null }
    if (!arg.execute) return built
    if (launch.file !== arg.expectFile) return { ...built, refused: 'the launch changed between the comparison and the probe' }
    const cp = await import('node:child_process')
    const run = await new Promise((resolve) =>
      cp.execFile(launch.file, launch.args, { env: launch.env, timeout: 5000, encoding: 'utf8' }, (err, stdout, stderr) =>
        resolve({ error: err ? err.message : null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      )
    )
    return { ...built, ...run }
  }`
  const oneShotArgument = { ptyBackend: PTY_BACKEND, oneShot: ONE_SHOT, profiles: PROFILES }
  let builtFile = null
  await check(
    "the title one-shot's own launch (buildOneShotLaunch, the resolver the title generator uses), built inside the daemon and NOT run, names the recorder",
    async () => {
      const built = await evaluate(daemon, ONE_SHOT_SOURCE, { ...oneShotArgument, execute: false })
      expectThat(typeof built.file === 'string' && built.file !== '', 'the launch names no file')
      expectThat(
        samePath(built.file, shims.claude),
        `the one-shot would run ${built.file} (${built.args.join(' ')}); nothing was executed`
      )
      builtFile = built.file
      return `${built.file} ${built.args.join(' ')}, not run`
    }
  )
  await check(
    "the same launch, run with --version inside the daemon only after the comparison, answers the recorder's line and leaves one probe line in the recorder log",
    async () => {
      expectThat(builtFile !== null, 'the launch was not compared first; nothing is run')
      const before = recorderLines(shims.log).length
      const decoyBefore = recorderLines(shims.decoyLog).length
      const result = await evaluate(daemon, ONE_SHOT_SOURCE, { ...oneShotArgument, execute: true, expectFile: builtFile })
      expectThat(!result.refused, result.refused ?? '')
      const decoyHits = recorderLines(shims.decoyLog).length - decoyBefore
      expectThat(decoyHits === 0, `the launch reached the decoy recorder ${decoyHits} time(s): ${result.file}`)
      expectThat(result.error === null, `the probe failed: ${result.error}`)
      expectThat(result.stdout.trim() === RECORDER_VERSION, `the probe answered ${JSON.stringify(result.stdout.trim())}`)
      const fresh = recorderLines(shims.log).slice(before)
      expectThat(fresh.length === 1 && isProbe(fresh[0]), `the recorder log gained ${fresh.length} line(s): ${fresh.join(' | ')}`)
      return `${result.file} ${result.args.join(' ')} → ${RECORDER_VERSION}; one probe line in the recorder log`
    }
  )
  if (MUTATE === 'wrong-resolver') {
    await evaluate(daemon, PATH_PREFIX_SOURCE, { ptyBackend: PTY_BACKEND, where: 'process', decoy: shims.decoyDir, on: false })
    say('mutation  wrong-resolver: the decoy taken off the daemon\'s own PATH again')
  }
  return results
}

/**
 * The recorder's guard, in every mode, from the daemon's start to the exit: a recorder line
 * that is not a probe of the boot check means an agent CLI was invoked from the fixture, and
 * everything stops with exit 3; the decoy log must stay empty too. Polled every half second.
 */
function watchRecorders(shims) {
  const probesAllowed = () => 1
  const timer = setInterval(() => {
    const unexpected = recorderLines(shims.log).filter((line) => !isProbe(line))
    const probes = recorderLines(shims.log).filter(isProbe)
    const decoy = recorderLines(shims.decoyLog)
    if (unexpected.length > 0 || probes.length > probesAllowed() || (decoy.length > 0 && MUTATE === null)) {
      note(`recorder: an agent CLI was invoked from the fixture; stopping everything: ${[...unexpected, ...decoy, ...probes.slice(probesAllowed())].join(' | ')}`)
      clearInterval(timer)
      void exitWith(3)
    }
  }, 500)
  timer.unref()
  return () => clearInterval(timer)
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

async function exitWith(code) {
  await stopAll()
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

async function startRelay() {
  mkdirSync(RELAY_DATA, { recursive: true, mode: 0o700 })
  const run = spawnBun(
    'relay',
    [
      path.join(REPO, 'apps', 'relay', 'src', 'main.ts'),
      '--port',
      String(RELAY_PORT),
      '--data-dir',
      RELAY_DATA,
      '--issuer',
      ISSUER_URL
    ],
    { ...process.env }
  )
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
  await step('no agent CLI was invoked from the fixture: the recorder log holds the boot check\'s one probe and nothing else, the decoy log is empty, the two homes are still empty', async () => {
    const lines = recorderLines(env.shims.log)
    const unexpected = lines.filter((line) => !isProbe(line))
    expect(unexpected.length === 0, `the recorders saw: ${unexpected.join(' | ')}`)
    expect(lines.filter(isProbe).length === 1, `${lines.filter(isProbe).length} probe line(s), one expected`)
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
  const pre = await preBootChecks(launch)
  const preFailed = pre.filter((c) => !c.ok)
  if (DRY_RUN) {
    say(`dry run: would start the daemon as: bun ${launch.args.join(' ')}`)
    say(`dry run: SHELL=${launch.env.SHELL} CLAUDE_CONFIG_DIR=${launch.env.CLAUDE_CONFIG_DIR} CODEX_HOME=${launch.env.CODEX_HOME}`)
    say(preFailed.length ? 'dry run: the pre-boot checks FAILED; a boot would be refused (exit 2)' : 'dry run: the pre-boot checks passed; nothing was started (the boot checks and the recorder guard run only on a boot)')
    return exitWith(preFailed.length ? 2 : 0)
  }
  if (preFailed.length) throw new RefusedBoot('pre-boot', preFailed)

  provider = await startProviderOn(ISSUER_PORT)
  if (provider.issuer !== ISSUER_URL)
    throw new Error(`the provider's issuer is ${provider.issuer}, not ${ISSUER_URL}`)
  note(`issuer ${provider.issuer}`)

  const relayRun = await startRelay()
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



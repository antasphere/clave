#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by node and imported by a vitest */
// The server fixture both native phones are tested against (lane C of the
// native mobile wave, PRDCT-4230): this checkout's own server entry as a
// DAEMON with the Echo adapter, a local relay and the local OpenID Connect
// provider, on a band of ports the caller names, with the real sign-in and
// the real pairing and nothing bypassed. One command:
//
//   node packages/mobile-native/scripts/fixture-server.mjs \
//     --server 47301 --relay 47302 --issuer 47303 --tmpdir /private/tmp/clave-native-c
//
// It checks before it boots and again before it seeds, prints every check
// as `check ok` or `check FAIL`, and refuses to go on unless all pass:
//
//   before any process (`preflight`, also alone as `--preflight`):
//   1. flags: the argv the daemon will be started with carries --no-titles,
//      --test-no-activate and --test-no-machine-usage;
//   2. the recorders stand in: the environment the daemon will be started
//      with has the fixture's `zsh` as its login shell, and that shell's
//      dump of the login environment, read the way the daemon reads it
//      (`$SHELL -lic 'env -0'`), resolves `claude` and `codex` to the
//      fixture's recorders;
//   after the daemon announced itself and before any chat (`bootChecks`):
//   3. the daemon's discovery file says `titles: "off"`;
//   4. it says `testMode: true` and `machineUsage: false`, and the daemon
//      answers POST /e2e/evaluate;
//   5. inside the running daemon, through its test hooks: the title
//      one-shot's own resolver (the daemon's cached login environment, the
//      one-shot's locate) names the recorder `claude`, the cached login PATH
//      names the recorder `codex`, and the daemon's SHELL is the fixture's;
//   6. inside the running daemon, the keys of its environment are the
//      allowlist's and the fixture's own and nothing else (names compared,
//      never values).
//
// Only then does it start the provider on the issuer port (its dynamic
// registration takes any redirect URI a client sends, so clave-ios:// and
// clave-android:// both pass), the relay under the repository's Bun with that
// issuer, and the daemon under Bun with `--dev-echo-adapter`, `--push-fake`,
// `--relay`, a token file of the fixture's own and the three flags; signs the
// daemon in as the fixture owner through the daemon's own sign-in command
// (the provider standing in for the browser); waits for the relay to list
// the machine online; registers a scratch workspace; seeds an Echo chat with
// a message carrying a nonce; and prints where everything is, one line per
// key:
//
//   CLAVE_FIXTURE_SERVER_URL=http://127.0.0.1:47301
//   CLAVE_FIXTURE_TOKEN_FILE=/private/tmp/clave-native-c/server/daemon-token
//   CLAVE_FIXTURE_RELAY_URL=http://127.0.0.1:47302
//   CLAVE_FIXTURE_ISSUER_URL=http://127.0.0.1:47303
//   CLAVE_FIXTURE_MACHINE_ID=m_…
//   CLAVE_FIXTURE_WORKSPACE_ID=…  CLAVE_FIXTURE_SESSION_ID=…  CLAVE_FIXTURE_NONCE=…
//   CLAVE_FIXTURE_RECORDER_LOG=/private/tmp/clave-native-c/stubs/recorder.log
//   CLAVE_FIXTURE_FILE=/private/tmp/clave-native-c/fixture.json
//
// and stays up until Ctrl-C stops the three processes, WATCHING ITS RECORDER:
// while it runs, the first line a recorder writes (a `claude` or a `codex`
// invoked by the daemon for any reason) is printed and the fixture stops the
// three processes and exits 3, so the enforcement is continuous and not a
// dry run. The token file is a path: the token itself is never printed.
// `--approve` approves every pending pairing as it appears (a development
// convenience, off by default; a runner approves through POST /devices/approve
// with the token in the file otherwise), under the same watch. `--check`
// runs the proof in this process after the boot and exits non-zero on a
// failure, then stops everything. `--preflight` runs the two pre-boot checks
// on the folder's stubs and exits, no process started. `--json` prints one
// JSON object instead of the lines. A port of 0 takes a free one; without
// `--tmpdir` a fresh folder under the system temp directory is used. Exit
// codes: 2 a refused boot or a refused run folder, 3 the recorder caught an
// attempt while running or its log could not be read, 1 a failed proof or an
// error.
//
// No real agent, no real login. The daemon names every fresh chat by its
// first message with a `claude -p` one-shot (packages/host/src/title-generator.ts),
// the Echo chat included, under the login shell's PATH and the machine's own
// login; it polls Claude and Codex usage on a clock from five seconds after
// its start, and an explicit usage read goes through the machine login's
// keychain item. The fixture keeps all of it off, and proves it:
//
//   - `--no-titles` is the daemon's explicit opt-out, checked at the title
//     generator's every entry; `--test-no-activate` stops the usage clock and
//     enables the test fixture route; `--test-no-machine-usage` keeps an
//     explicit Claude usage read off the machine login (the two together set
//     TEST_NO_MACHINE_USAGE). The Codex read has no flag: it is covered by the
//     recorder on the PATH and an empty Codex home.
//   - the daemon's environment is built from an ALLOWLIST, never from this
//     shell's: HOME, USER, LOGNAME, TMPDIR, LANG, LC_ALL, LC_CTYPE, TERM and
//     TZ as they are, then SHELL (the fixture's `zsh` under <tmpdir>/stubs,
//     a script that prints the daemon's environment whatever its arguments,
//     since only a POSIX shell's name is kept by the daemon, and runs a `-c`
//     command with /bin/sh), PATH (the stubs folder, then the system
//     directories and nothing of this shell's PATH, so the recorders are the
//     only `claude` and `codex` the daemon can find), CLAUDE_CONFIG_DIR and
//     CODEX_HOME (two folders of the fixture's own, recreated empty at every
//     boot), the issuer, and on macOS the keychain file; both Bun children
//     start with `--no-env-file`, so no .env of the working directory reaches
//     them past the allowlist. The recorders each
//     append one line per invocation (the time, the command, its first two
//     arguments, never the stdin) to <tmpdir>/stubs/recorder.log; `claude -p`
//     answers a fixed title, `codex` exits silently.
//   - the proof (`--check`, and fixture-server.test.mjs) seeds the chat, waits
//     past the clock's first tick, and asserts: zero recorder lines, no
//     session.title_changed for the chat, the two owned folders still empty,
//     no usage event on the push channel; then an explicit Claude read
//     answers without the machine login and leaves the recorder silent, and
//     an explicit Codex read reaches the codex recorder, exactly one line,
//     and answers an error. Each row says whether it rests on the argv, on
//     the daemon's announcement (derived from the code's flags), on a
//     recorder, on the wire, or on the owned folders; no row ever rests on a
//     provider's answer, none being expected. The person's own folders
//     (~/.claude, their Codex home) are never read.
//   - `--mutate <name>` is the verifier's knob and nobody's configuration; a
//     mutant run never boots the daemon with the wrong usage flags against
//     this Mac's login. `drop-title-opt-out` boots without --no-titles (the
//     recorders in place, the usage flags kept) and continues past the failed
//     first and third checks so the recorder shows the one-shot too;
//     `bypass-title-guard` keeps every flag and re-opens the titles through
//     the daemon's test hook, so the daemon still announces titles off while
//     the one-shot really runs, and the recorder alone catches it;
//     `start-usage-clock` keeps every flag and starts the clock through the
//     test hook, so the codex recorder and the usage events catch the reads
//     while the Claude read stays off the machine login (the flags are kept
//     because the keychain item is read by username through /usr/bin/security,
//     which no environment variable redirects: a clock run without them would
//     read the person's own login); `divergent-daemon-env` passes the
//     preflight on the recorders' environment and then starts the daemon on
//     this shell's PATH instead, so the fifth check, asked of the daemon's
//     own resolver, fails and nothing is seeded (no CLI runs: titles are off
//     and the clock is off); `drop-recorders` starts nothing at all: the
//     second check aborts before any process.
//
// Secrets: the daemon's token is in the token file (mode 0600) and in the
// discovery file under the data folder, never on stdout; on macOS the
// daemon's sealed session goes to a keychain FILE under the data folder,
// created here, never the login keychain; on Linux to the daemon's encrypted
// files. Nothing here deletes outside the folders the fixture created: the
// two owned folders and the recorder log under <tmpdir>/stubs, and the
// daemon's stored registration and session under <tmpdir>/server. A run
// folder is taken only when it is missing, empty, or marked by the fixture
// (a regular file `.clave-native-fixture` at its root holding exactly the
// fixture's stamp, read with lstat so a symlink is refused); anything else is
// refused before a byte is written, and a dry run never rewrites a folder it
// reuses.
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
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { startOidcProvider } from '../../../tests/e2e/fixtures/oidc-provider.mjs'
import { bunBinary } from '../../../scripts/server-process.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(here, '..', '..', '..')

/** The owner the daemon signs in as, and the phones sign in as to pair. */
export const OWNER = {
  sub: 'fixture-owner',
  name: 'Fixture Owner',
  email: 'owner@fixture.clave.test',
  email_verified: true
}
/** The two callback schemes the app lanes chose; both register at the issuer. */
export const REDIRECTS = {
  ios: 'clave-ios://oauth/callback',
  android: 'clave-android://oauth/callback'
}
export const SEED_PREFIX = 'seeded-'
export const TOKEN_FILE_NAME = 'daemon-token'
export const MANIFEST_NAME = 'fixture.json'
export const RECORDER_LOG_NAME = 'recorder.log'
/** What the recorder `claude` answers a title one-shot with, were one ever asked. */
export const STUB_TITLE = 'fixture chat'
/** The daemon's three flags that keep it off every provider. */
export const DAEMON_FLAGS = ['--no-titles', '--test-no-activate', '--test-no-machine-usage']
/** The verifier's mutations; never a configuration. */
export const MUTATIONS = [
  'drop-title-opt-out',
  'bypass-title-guard',
  'start-usage-clock',
  'divergent-daemon-env',
  'drop-recorders'
]
/** The usage clock's first tick runs five seconds after the daemon starts. */
export const CLOCK_WINDOW_MS = 7_000
/** The variables of this shell the daemon's environment keeps, as they are. */
export const ENV_ALLOWLIST = [
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ'
]
/** The system directories beside the recorders: `security`, `sysctl`, `sh`. */
export const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
/** How often the running fixture reads its recorder log. */
const RECORDER_WATCH_MS = 500
/** The marker a run folder carries once the fixture owns it: a regular file
 *  at the folder's root holding exactly RUN_FOLDER_OWNER. */
export const RUN_FOLDER_MARKER = '.clave-native-fixture'
export const RUN_FOLDER_OWNER = `clave-native-fixture-server/1 ${REPO}\n`
/** The names a login shell may have for the daemon to run a command through
 *  it (`POSIX_SHELLS` in packages/host/src/shell-launch.ts, mirrored here and
 *  held in step by the test): any other name sends the Codex usage read and
 *  the one-shot's not-found fallback to /bin/zsh, the real login shell. */
export const POSIX_SHELL_NAMES = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash']

const stderr = (line) => process.stderr.write(`fixture: ${line}\n`)

export function parseArgs(argv) {
  const value = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    if (i >= 0) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`--${name} needs a value`)
      return next
    }
    const inline = argv.find((a) => a.startsWith(`--${name}=`))
    return inline ? inline.slice(name.length + 3) : fallback
  }
  const port = (name) => {
    const raw = value(name, '0')
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`--${name} must be 0..65535`)
    return n
  }
  for (const a of argv)
    if (
      a.startsWith('--') &&
      !/^--(server|relay|issuer|tmpdir|timeout|mutate)(=|$)/.test(a) &&
      !['--approve', '--check', '--json', '--preflight'].includes(a)
    )
      throw new Error(`unknown option ${a}`)
  const mutate = value('mutate', null)
  if (mutate !== null && !MUTATIONS.includes(mutate))
    throw new Error(`--mutate takes one of ${MUTATIONS.join(', ')}`)
  return {
    ports: { server: port('server'), relay: port('relay'), issuer: port('issuer') },
    tmpdir: value('tmpdir', null),
    timeoutMs: Number(value('timeout', '90000')),
    approve: argv.includes('--approve'),
    check: argv.includes('--check'),
    preflight: argv.includes('--preflight'),
    json: argv.includes('--json'),
    mutate
  }
}

/** The daemon's flags for a run: the three, less `--no-titles` under the one mutation that drops it. */
export function flagsFor(mutate) {
  return mutate === 'drop-title-opt-out'
    ? DAEMON_FLAGS.filter((f) => f !== '--no-titles')
    : DAEMON_FLAGS
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll `fn` until it answers something truthy, or null past the budget. */
async function until(fn, { tries = 40, gapMs = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = await fn()
    if (value) return value
    await sleep(gapMs)
  }
  return null
}

/** One HTTP call with an optional bearer; the body parsed when it is JSON. */
export async function call(url, token, method, route, body) {
  const response = await fetch(`${url}${route}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = { raw: text }
  }
  return { status: response.status, body: parsed }
}

async function must(url, token, method, route, body) {
  const answer = await call(url, token, method, route, body)
  if (answer.status < 200 || answer.status >= 300)
    throw new Error(`${method} ${route} answered ${answer.status}: ${JSON.stringify(answer.body)}`)
  return answer.body
}

/** Run a function inside the daemon through its test fixture route. */
async function evaluate(server, source) {
  const answer = await call(server.url, server.token, 'POST', '/e2e/evaluate', { source })
  if (answer.status !== 200 || !answer.body?.ok)
    throw new Error(`POST /e2e/evaluate answered ${answer.status}: ${JSON.stringify(answer.body)}`)
  return answer.body.value
}

/** Stop a child: SIGTERM, then SIGKILL after eight seconds. */
function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve()
    const hard = setTimeout(() => child.kill('SIGKILL'), 8_000)
    child.once('exit', () => {
      clearTimeout(hard)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

/**
 * Take the run folder, or refuse it. A folder the fixture may write and
 * clean is one it created, or one it marked: a regular file (lstat, never a
 * symlink) at its root holding exactly RUN_FOLDER_OWNER. A missing or empty
 * folder is claimed and marked; a folder holding anything else and no
 * marker, a marker that is not a regular file, a marker naming another
 * owner, or a root that is not a plain directory is refused before anything
 * is written. `fresh` says whether the folder was created or empty.
 */
export function claimRunFolder(root) {
  const marker = path.join(root, RUN_FOLDER_MARKER)
  const refuse = (why) => {
    const error = new Error(`refusing the run folder ${root}: ${why}`)
    error.refusedFolder = true
    return error
  }
  let stat = null
  try {
    stat = lstatSync(root)
  } catch {
    stat = null
  }
  if (stat && !stat.isDirectory())
    throw refuse(stat.isSymbolicLink() ? 'it is a symlink' : 'it is not a directory')
  if (!stat) mkdirSync(root, { recursive: true, mode: 0o700 })
  if (readdirSync(root).length === 0) {
    writeFileSync(marker, RUN_FOLDER_OWNER, { mode: 0o600, flag: 'wx' })
    return { root, marker, fresh: true }
  }
  let markerStat
  try {
    markerStat = lstatSync(marker)
  } catch {
    throw refuse(`it is not empty and carries no ${RUN_FOLDER_MARKER}`)
  }
  if (!markerStat.isFile()) throw refuse(`${RUN_FOLDER_MARKER} is not a regular file`)
  if (readFileSync(marker, 'utf8') !== RUN_FOLDER_OWNER)
    throw refuse(`${RUN_FOLDER_MARKER} names another owner`)
  return { root, marker, fresh: false }
}

/**
 * The stand-ins under <tmpdir>/stubs: `zsh`, the daemon's login shell, which
 * prints this environment whatever it is asked and runs a `-c` command with
 * /bin/sh; `claude` and `codex`, the recorders, each appending one line to
 * the recorder log per invocation (the time, the command, its first two
 * arguments, never the stdin); `claude -p` answers the fixed title so a
 * daemon that asked anyway gets a harmless one. The Claude config folder and
 * the Codex home, the fixture's own, are recreated empty, and the recorder
 * log recreated empty, at every boot: the log exists from the install on, so
 * a read that finds it missing is a failure, never "no calls". Nothing
 * outside this folder is touched, and with `reuse` an install already there
 * is taken as it is, nothing rewritten (a dry run on a reused folder).
 */
export function installStubs(dir, { reuse = false } = {}) {
  const log = path.join(dir, RECORDER_LOG_NAME)
  const claudeConfigDir = path.join(dir, 'claude-config')
  const codexHome = path.join(dir, 'codex-home')
  const installed = {
    dir,
    shell: path.join(dir, 'zsh'),
    claude: path.join(dir, 'claude'),
    codex: path.join(dir, 'codex'),
    log,
    claudeConfigDir,
    codexHome
  }
  if (reuse && [installed.shell, installed.claude, installed.codex, log].every(existsSync))
    return installed
  mkdirSync(dir, { recursive: true })
  for (const owned of [claudeConfigDir, codexHome]) {
    rmSync(owned, { recursive: true, force: true })
    mkdirSync(owned, { recursive: true })
  }
  writeFileSync(log, '', { mode: 0o600 })
  const write = (name, body) => {
    const file = path.join(dir, name)
    writeFileSync(file, body)
    chmodSync(file, 0o755)
    return file
  }
  const shell = write(
    'zsh',
    [
      '#!/bin/sh',
      "# The fixture's stand-in for the daemon's login shell: the daemon reads its",
      "# login environment through `$SHELL -lic 'env -0'`, and this environment is the",
      "# fixture's own, its PATH starting with the recorders. A `-c` command runs with /bin/sh.",
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
  const record = `printf '%s %s %s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$0" "$1" "$2" >> '${log}'`
  const claude = write(
    'claude',
    [
      '#!/bin/sh',
      "# The fixture's recorder for the claude CLI: never a real agent, never the",
      '# machine login. Every invocation is one line in the recorder log; a one-shot',
      '# (-p) reads its prompt off stdin, drops it, and answers a fixed title.',
      record.replace('"$0"', '"claude"'),
      'case " $* " in',
      '  *" -p "*|*" --print "*)',
      '    cat >/dev/null',
      `    printf '%s\\n' '${STUB_TITLE}' ;;`,
      '  *" --version "*) printf \'claude fixture-recorder\\n\' ;;',
      'esac',
      'exit 0',
      ''
    ].join('\n')
  )
  const codex = write(
    'codex',
    [
      '#!/bin/sh',
      "# The fixture's recorder for the codex CLI: never a real agent. Every",
      '# invocation is one line in the recorder log; it answers nothing and exits.',
      record.replace('"$0"', '"codex"'),
      'exit 0',
      ''
    ].join('\n')
  )
  return { dir, shell, claude, codex, log, claudeConfigDir, codexHome }
}

/** The lines the recorders wrote since the boot, never a prompt. Throws when
 *  the log is missing or unreadable: a read that fails is a failure, never
 *  "no calls" (the log exists, empty, from the install on). */
export function recorderLines(stubs) {
  return readFileSync(stubs.log, 'utf8').split('\n').filter(Boolean)
}

/** What the two owned folders hold, by name; both empty while nothing reached them. */
export function ownedFolderEntries(stubs) {
  const list = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : [])
  return { claudeConfigDir: list(stubs.claudeConfigDir), codexHome: list(stubs.codexHome) }
}

/**
 * The daemon's environment, built from the allowlist and nothing of this
 * shell's beyond it: the fixture's shell, a PATH of the recorders and the
 * system directories (this shell's own PATH only under the two mutations
 * that stand a real `claude` in the daemon's way, to be caught), the two
 * owned credential folders, the issuer, and on macOS the keychain file.
 * Computed once, checked before the boot, then handed to the daemon as it is.
 */
export function childEnv(issuer, serverDir, stubs, { recorders = true } = {}) {
  const env = {}
  for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key]
  env.SHELL = stubs.shell
  env.PATH = recorders
    ? `${stubs.dir}${path.delimiter}${SYSTEM_PATH}`
    : (process.env.PATH ?? SYSTEM_PATH)
  env.CLAUDE_CONFIG_DIR = stubs.claudeConfigDir
  env.CODEX_HOME = stubs.codexHome
  env.CLAVE_ANTASPHERE_ISSUER = issuer
  if (process.platform === 'darwin')
    env.CLAVE_KEYCHAIN_FILE = path.join(serverDir, 'fixture.keychain-db')
  return env
}

/** A keychain FILE for the daemon's sealed secrets on macOS, created once
 *  under the data folder and kept across restarts; never the login keychain. */
function ensureKeychain(file) {
  if (process.platform !== 'darwin' || existsSync(file)) return
  execFileSync('/usr/bin/security', ['create-keychain', '-p', '', file], { stdio: 'ignore' })
  execFileSync('/usr/bin/security', ['set-keychain-settings', file], { stdio: 'ignore' })
}

/** The daemon's credential, minted once per data folder, mode 0600. */
function ensureTokenFile(file) {
  if (!existsSync(file))
    writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
  chmodSync(file, 0o600)
  return readFileSync(file, 'utf8').trim()
}

/** The relay as its own process: the entry under Bun, its url on stdout, on
 *  the same allowlisted environment without the recorders (it spawns nothing). */
async function startRelay({ bun, port, dataDir, issuer, env, log, timeoutMs }) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const child = spawn(
    bun,
    [
      '--no-env-file',
      path.join(REPO, 'apps/relay/src/main.ts'),
      '--port',
      String(port),
      '--data-dir',
      dataDir,
      '--issuer',
      issuer
    ],
    { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let errors = ''
  child.stderr.on('data', (d) => {
    errors = (errors + d).slice(-16_384)
    for (const line of String(d).split('\n')) if (line.trim()) log(`relay: ${line}`)
  })
  const url = await new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(
      () => reject(new Error(`the relay did not announce itself in ${timeoutMs} ms\n${errors}`)),
      timeoutMs
    )
    child.stdout.on('data', (d) => {
      out += d
      const nl = out.indexOf('\n')
      if (nl < 0) return
      clearTimeout(timer)
      try {
        resolve(JSON.parse(out.slice(0, nl)).url)
      } catch (error) {
        reject(error)
      }
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`the relay exited (${code ?? signal}) before announcing itself\n${errors}`))
    })
  })
  return { url, child, dataDir }
}

/** The daemon: this checkout's server entry under Bun, in the environment
 *  the preflight checked, ready once it has written `clave-server.json`
 *  with its own pid. */
async function startDaemon({ bun, port, dataDir, tokenFile, relay, env, flags, log, timeoutMs }) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  chmodSync(dataDir, 0o700)
  if (env.CLAVE_KEYCHAIN_FILE) ensureKeychain(env.CLAVE_KEYCHAIN_FILE)
  const token = ensureTokenFile(tokenFile)
  const terminalProcess = path.join(REPO, 'out', 'main', 'terminal-process.js')
  const args = [
    '--no-env-file',
    path.join(REPO, 'apps', 'server', 'src', 'main.ts'),
    '--data-dir',
    dataDir,
    '--daemon',
    '--port',
    String(port),
    '--token-file',
    tokenFile,
    '--dev-echo-adapter',
    '--push-fake',
    '--relay',
    relay,
    ...flags,
    ...(existsSync(terminalProcess)
      ? ['--terminal-process', terminalProcess, '--node', process.execPath]
      : [])
  ]
  const startedAt = Date.now()
  const child = spawn(bun, args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let errors = ''
  const onLine = (d) => {
    errors = (errors + d).slice(-16_384)
    for (const line of String(d).split('\n')) if (line.trim()) log(`server: ${line}`)
  }
  child.stderr.on('data', onLine)
  child.stdout.on('data', onLine)
  const discoveryFile = path.join(dataDir, 'clave-server.json')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `the server exited (${child.exitCode ?? child.signalCode}) before announcing itself\n${errors}`
      )
    if (Date.now() > deadline) {
      await stopChild(child)
      throw new Error(`the server did not announce itself in ${timeoutMs} ms\n${errors}`)
    }
    try {
      const value = JSON.parse(readFileSync(discoveryFile, 'utf8'))
      if (value.pid === child.pid && typeof value.url === 'string' && value.token === token)
        return {
          url: value.url,
          token,
          serverId: value.serverId,
          discovery: value,
          env,
          flags,
          startedAt,
          child,
          dataDir,
          tokenFile
        }
    } catch {
      /* not written yet */
    }
    await sleep(100)
  }
}

/** Where `command` lives on `pathEnv`: the first directory holding an
 *  executable file of that name, as the host's `findExecutable` looks. */
export function locateOnPath(command, pathEnv) {
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

/** The login environment as the daemon reads it: `$SHELL -lic 'env -0'`
 *  with the daemon's own environment, parsed. */
export function loginShellEnvOf(shell, env) {
  const output = execFileSync(shell, ['-lic', 'env -0'], {
    env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  })
  const parsed = {}
  for (const entry of output.split('\0')) {
    const i = entry.indexOf('=')
    if (i > 0) parsed[entry.slice(0, i)] = entry.slice(i + 1)
  }
  return parsed
}

const same = (a, b) => {
  try {
    return typeof a === 'string' && realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/** Whether `shell` is the fixture's stand-in AND bears a name the daemon runs
 *  a command through (POSIX_SHELL_NAMES): the Codex usage read and the
 *  one-shot's not-found fallback route by the shell's basename, and any other
 *  name sends them to /bin/zsh, the real login shell, with the PATH its
 *  profile builds (the verifier's round 1, F2). */
export function shellStandsIn(shell, stubShell) {
  return same(shell, stubShell) && POSIX_SHELL_NAMES.includes(path.basename(shell))
}

/** One row of a check: its name, the stage, what it rests on, the verdict. */
function checker(stage, results, log) {
  return async (name, kind, fn) => {
    try {
      const detail = await fn()
      results.push({ stage, name, kind, ok: true, detail: detail ?? null })
      log(`check ok    ${name}${detail ? ` (${detail})` : ''}`)
    } catch (error) {
      results.push({ stage, name, kind, ok: false, detail: error.message })
      log(`check FAIL  ${name}: ${error.message}`)
    }
  }
}
const expect = (condition, message) => {
  if (!condition) throw new Error(message)
}

/**
 * The two checks before any process starts: the argv the daemon will get
 * carries the three flags (`argv`), and the environment it will get, read
 * the way the daemon reads its login environment, resolves `claude` and
 * `codex` to the recorders (`observed`). `--preflight` runs these alone.
 */
export async function preflight({ flags, stubs, env, log }) {
  const results = []
  const check = checker('preflight', results, log)
  await check(
    "flags: the daemon's argv carries --no-titles, --test-no-activate and --test-no-machine-usage",
    'argv',
    async () => {
      const missing = DAEMON_FLAGS.filter((f) => !flags.includes(f))
      expect(
        missing.length === 0,
        `missing ${missing.join(' ')}; the argv carries ${flags.join(' ')}`
      )
      return flags.join(' ')
    }
  )
  await check(
    "the recorders stand in: the daemon's login shell is the fixture's zsh and its login environment resolves claude and codex to the recorders",
    'observed',
    async () => {
      expect(
        shellStandsIn(env.SHELL, stubs.shell),
        `the daemon's SHELL would be ${env.SHELL}, not the fixture's zsh`
      )
      const login = loginShellEnvOf(env.SHELL, env)
      const claude = locateOnPath('claude', login.PATH)
      const codex = locateOnPath('codex', login.PATH)
      expect(
        claude && same(claude, stubs.claude),
        `claude resolves to ${claude ?? 'nothing'} on the daemon's login PATH`
      )
      expect(
        codex && same(codex, stubs.codex),
        `codex resolves to ${codex ?? 'nothing'} on the daemon's login PATH`
      )
      return `claude and codex are the recorders under ${stubs.dir}`
    }
  )
  return results
}

/**
 * The three checks after the daemon announced itself and before any chat:
 * what its discovery file says (`announced`, derived from the code's flags),
 * that its test fixture route answers, and, asked of the daemon itself
 * through its test hooks, what its title one-shot would start and where its
 * cached login PATH finds `codex` (`observed`).
 */
export async function bootChecks({ server, stubs, log }) {
  const results = []
  const check = checker('boot', results, log)
  const discovery = server.discovery
  await check(
    'titles off: the daemon announces titles "off" (--no-titles)',
    'announced',
    async () => {
      expect(
        discovery.titles === 'off',
        `the discovery file says titles ${JSON.stringify(discovery.titles)}`
      )
      return 'titles: off'
    }
  )
  await check(
    'test mode on, machine usage off: the daemon announces testMode true and machineUsage false, and answers POST /e2e/evaluate',
    'announced',
    async () => {
      expect(discovery.testMode === true, `testMode ${JSON.stringify(discovery.testMode)}`)
      expect(
        discovery.machineUsage === false,
        `machineUsage ${JSON.stringify(discovery.machineUsage)}`
      )
      const one = await evaluate(server, '() => 1')
      expect(one === 1, `the fixture route answered ${JSON.stringify(one)}`)
      return 'testMode: true, machineUsage: false, /e2e/evaluate answers'
    }
  )
  await check(
    "inside the running daemon, the title one-shot's resolver and the cached login PATH name the recorders, and SHELL is the fixture's",
    'observed',
    async () => {
      const inside = await evaluate(
        server,
        `async () => {
          const titles = globalThis.__claveE2E?.titles
          if (!titles) throw new Error('no titles hook on this daemon')
          const launch = await titles.launch()
          return { shell: process.env.SHELL, file: launch.file, pathEnv: launch.pathEnv, codex: titles.locate('codex') }
        }`
      )
      expect(
        shellStandsIn(inside.shell, stubs.shell),
        `the daemon's SHELL is ${inside.shell}, not the fixture's zsh`
      )
      expect(
        same(inside.file, stubs.claude),
        `the title one-shot would start ${inside.file} on the daemon's cached login PATH`
      )
      expect(
        same(inside.codex, stubs.codex),
        `codex resolves to ${inside.codex ?? 'nothing'} inside the daemon`
      )
      expect(
        typeof inside.pathEnv === 'string' && inside.pathEnv.startsWith(stubs.dir + path.delimiter),
        `the one-shot's PATH does not start with ${stubs.dir}`
      )
      return `one-shot ${path.basename(inside.file)} and codex are the recorders, by the daemon's own resolver`
    }
  )
  await check(
    "inside the running daemon, the environment's keys are the allowlist's and the fixture's own, nothing else",
    'observed',
    async () => {
      // Names compared, never values: the daemon answers the sorted keys of
      // its process.env, and they must be exactly the keys it was handed.
      const inside = await evaluate(server, '() => Object.keys(process.env).sort()')
      const handed = Object.keys(server.env).sort()
      const extra = inside.filter((k) => !handed.includes(k))
      const missing = handed.filter((k) => !inside.includes(k))
      expect(
        extra.length === 0 && missing.length === 0,
        `extra: ${extra.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}`
      )
      return `${inside.length} keys: ${inside.join(', ')}`
    }
  )
  return results
}

/** Sign the daemon in as the owner through its own command: the handoff it
 *  answers is confirmed as the shell confirms it, then the provider stands
 *  in for the browser, and the daemon's own status says signed in. */
async function signIn(server, provider) {
  const started = await must(server.url, server.token, 'POST', '/accounts/antasphere/sign-in', {})
  if (!started.handoff)
    throw new Error(
      `the daemon answered no handoff: ${started.status?.lastFailure ?? 'no failure named'}`
    )
  const confirmed = await must(
    server.url,
    server.token,
    'POST',
    '/accounts/antasphere/handoff/confirm',
    started.handoff
  )
  if (!confirmed.current) throw new Error('the daemon did not confirm the handoff it issued')
  await provider.browse(started.handoff.url)
  const status = await until(
    async () => {
      const s = await must(server.url, server.token, 'GET', '/accounts/antasphere')
      return s.phase === 'signing-in' ? null : s
    },
    { tries: 100, gapMs: 200 }
  )
  if (!status) throw new Error('the sign-in did not settle')
  if (status.phase !== 'signed-in' || status.account?.subject !== OWNER.sub)
    throw new Error(
      `the daemon is not signed in as the owner: ${status.phase} ${status.lastFailure ?? ''}`
    )
  return status
}

/** The relay lists the owner's machine online, under the owner's hub bearer. */
async function waitForMachine(relayUrl, bearer, tries = 150) {
  const machine = await until(
    async () => {
      const list = await call(relayUrl, bearer, 'GET', '/machines')
      return list.body?.machines?.find((m) => m.online) ?? null
    },
    { tries, gapMs: 200 }
  )
  if (!machine) throw new Error('the relay never listed the machine online')
  return machine
}

/** `rootDir` as a workspace of the daemon, named `name`, when it is not one. */
export async function ensureWorkspace(server, rootDir, name) {
  mkdirSync(rootDir, { recursive: true })
  const state = await must(server.url, server.token, 'GET', '/workspaces')
  const existing = state.workspaces.find((w) => w.rootDir === rootDir)
  if (existing) return existing
  const workspace = {
    id: `ws-${randomBytes(6).toString('hex')}`,
    name,
    rootDir,
    profileFile: null,
    createdAt: Date.now()
  }
  const written = await must(server.url, server.token, 'POST', '/workspaces/registry', {
    workspaces: [...state.workspaces, workspace],
    base: { revision: state.revision, instance: state.instance }
  })
  if (!written.ok) throw new Error(`the daemon refused the workspace: ${written.reason}`)
  return workspace
}

/** An Echo chat on the scratch workspace holding one message with a nonce,
 *  and the Echo's reply to it, both in the ordered timeline. */
export async function seedEchoChat(server, workspace) {
  const nonce = randomBytes(4).toString('hex')
  const text = `${SEED_PREFIX}${nonce}`
  const started = await must(server.url, server.token, 'POST', '/sessions/start', {
    cwd: workspace.rootDir,
    options: { claudeMode: true, launchProfileId: 'dev-echo-adapter', workspaceId: workspace.id }
  })
  await must(server.url, server.token, 'POST', '/sessions/write', {
    id: started.id,
    input: { type: 'user_message', text, clientMessageId: `m-fixture-${nonce}` }
  })
  const page = await until(
    async () => {
      const answer = await call(
        server.url,
        server.token,
        'GET',
        `/sessions/timeline?id=${started.id}`
      )
      const items = answer.body?.items ?? []
      const asked = items.some((i) => i.event?.type === 'user_message' && i.event.text === text)
      const echoed = items.some(
        (i) =>
          i.event?.type === 'assistant_text' &&
          i.event.final &&
          String(i.event.delta).includes(nonce)
      )
      return asked && echoed ? answer.body : null
    },
    { tries: 100, gapMs: 200 }
  )
  if (!page) throw new Error('the seeded message and its echo never reached the timeline')
  return { id: started.id, nonce, text, cursor: page.cursor }
}

/** A push socket of the owner's that keeps every usage event and every title
 *  change it hears. */
function watchEvents(server) {
  const events = []
  const titles = []
  const socket = new WebSocket(`${server.url.replace(/^http/, 'ws')}/push`)
  socket.on('open', () =>
    socket.send(
      JSON.stringify({ _tag: 'hello', token: server.token, client: 'clave-fixture-usage-watch' })
    )
  )
  socket.on('message', (data) => {
    try {
      const frame = JSON.parse(data.toString())
      if (frame._tag !== 'event' || typeof frame.event?._tag !== 'string') return
      if (frame.event._tag.startsWith('usage.')) events.push(frame.event._tag)
      if (frame.event._tag === 'session.title_changed')
        titles.push({ id: frame.event.id, title: frame.event.title })
    } catch {
      /* not a frame */
    }
  })
  socket.on('error', () => {})
  return { events, titles, close: () => socket.close(1000, 'done') }
}

/** The refusal: what failed, and whether a daemon was ever started. */
function refusal(checks, before) {
  const failed = checks.filter((c) => !c.ok)
  const error = new Error(
    `the fixture refuses to boot, before any ${before}: ${failed.map((c) => c.name).join('; ')}`
  )
  error.checks = checks
  return error
}

/** The whole fixture: the preflight, the provider, the relay, the daemon
 *  checked, signed in and on the relay, the scratch workspace and the seeded
 *  chat. */
export async function startFixture({
  ports,
  tmpdir,
  approve = false,
  timeoutMs = 90_000,
  mutate = null,
  log = stderr
} = {}) {
  if (mutate !== null && !MUTATIONS.includes(mutate))
    throw new Error(`mutate takes one of ${MUTATIONS.join(', ')}`)
  if (mutate) log(`MUTATION ${mutate}: a proof run, never a configuration`)
  const root = tmpdir ?? mkdtempSync(path.join(os.tmpdir(), 'clave-native-fixture-'))
  claimRunFolder(root)
  const bun = bunBinary(process.env, REPO)
  const stubs = installStubs(path.join(root, 'stubs'))
  const serverDir = path.join(root, 'server')
  const flags = flagsFor(mutate)
  // The issuer's port is known only once the provider listens; the preflight
  // checks the shell and the PATH, which do not depend on it, on the very
  // environment the daemon is then handed, the issuer filled in.
  const env = childEnv('http://127.0.0.1:0', serverDir, stubs, {
    recorders: mutate !== 'drop-recorders'
  })
  const checks = await preflight({ flags, stubs, env, log })
  if (!checks[1].ok || (!checks[0].ok && !mutate)) throw refusal(checks, 'daemon')
  const provider = await startOidcProvider({
    port: ports?.issuer ?? 0,
    registrationStatus: 200,
    user: OWNER
  })
  env.CLAVE_ANTASPHERE_ISSUER = provider.issuer
  log(`issuer ${provider.issuer}`)
  let relay = null
  let server = null
  let watch = null
  const stop = async () => {
    watch?.close()
    await stopChild(server?.child)
    await stopChild(relay?.child)
    await provider.close()
  }
  try {
    relay = await startRelay({
      bun,
      port: ports?.relay ?? 0,
      dataDir: path.join(root, 'relay'),
      issuer: provider.issuer,
      env: { ...env, PATH: SYSTEM_PATH },
      log,
      timeoutMs
    })
    log(`relay ${relay.url}`)
    // The provider's registrations live in its memory: a stored client of a
    // previous boot is unknown to this one, so the daemon registers and signs
    // in anew every boot. Its identity, its token and the relay's machine
    // credential stay.
    for (const stale of ['antasphere-account-client.json', 'antasphere-account-session.json'])
      rmSync(path.join(serverDir, stale), { force: true })
    // The one mutation that gives the daemon an environment other than the
    // checked one: this shell's PATH, carrying a real claude, so the fifth
    // check, asked of the daemon's own resolver, has something to catch.
    const daemonEnv =
      mutate === 'divergent-daemon-env' ? { ...env, PATH: process.env.PATH ?? SYSTEM_PATH } : env
    server = await startDaemon({
      bun,
      port: ports?.server ?? 0,
      dataDir: serverDir,
      tokenFile: path.join(serverDir, TOKEN_FILE_NAME),
      relay: relay.url,
      env: daemonEnv,
      flags,
      log,
      timeoutMs
    })
    log(`server ${server.url}, its token in ${server.tokenFile}`)
    checks.push(...(await bootChecks({ server, stubs, log })))
    if (!checks[4].ok || !checks[5].ok || (checks.some((c) => !c.ok) && !mutate))
      throw refusal(checks, 'chat')
    watch = watchEvents(server)
    if (mutate === 'bypass-title-guard') {
      const disabled = await evaluate(
        server,
        '() => { const titles = globalThis.__claveE2E.titles; titles.enable(); return titles.disabled() }'
      )
      log(
        `MUTATION: the titles re-opened through the test hook (disabled: ${JSON.stringify(disabled)}); the daemon still announces ${server.discovery.titles}`
      )
    }
    let clockStartedAt = null
    if (mutate === 'start-usage-clock') {
      await evaluate(server, '() => { globalThis.__claveE2E.usageClock.start(60000); return true }')
      clockStartedAt = Date.now()
      log('MUTATION: the usage clock started through the test hook, every flag kept')
    }
    await signIn(server, provider)
    log(`signed in as ${OWNER.email}`)
    const ownerBearer = provider.mintAccessToken({ sub: OWNER.sub })
    const machine = await waitForMachine(relay.url, ownerBearer)
    log(`the relay lists machine ${machine.id} online`)
    const scratch = path.join(root, 'scratch')
    const workspace = await ensureWorkspace(server, scratch, 'scratch')
    const seed = await seedEchoChat(server, workspace)
    log(`Echo chat ${seed.id} holds "${seed.text}"`)
    const manifestFile = path.join(root, MANIFEST_NAME)
    const manifest = {
      v: 1,
      startedAt: new Date(server.startedAt).toISOString(),
      server: {
        url: server.url,
        serverId: server.serverId,
        tokenFile: server.tokenFile,
        dataDir: server.dataDir,
        pid: server.child.pid,
        flags: server.flags,
        envKeys: Object.keys(server.env).sort(),
        announces: {
          titles: server.discovery.titles,
          testMode: server.discovery.testMode,
          machineUsage: server.discovery.machineUsage
        }
      },
      relay: { url: relay.url, dataDir: relay.dataDir, pid: relay.child.pid },
      issuer: {
        url: provider.issuer,
        owner: { sub: OWNER.sub, name: OWNER.name, email: OWNER.email },
        redirects: REDIRECTS
      },
      machineId: machine.id,
      workspace: { id: workspace.id, name: workspace.name, rootDir: workspace.rootDir },
      session: { id: seed.id, nonce: seed.nonce, text: seed.text },
      stubs: {
        dir: stubs.dir,
        recorderLog: stubs.log,
        title: STUB_TITLE,
        claudeConfigDir: stubs.claudeConfigDir,
        codexHome: stubs.codexHome
      },
      checks,
      mutation: mutate,
      approve
    }
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    let approving = null
    if (approve) approving = approveLoop({ server, log })
    return {
      root,
      provider,
      relay,
      server,
      machine,
      workspace,
      seed,
      stubs,
      checks,
      mutate,
      usageEvents: watch.events,
      titleEvents: watch.titles,
      clockStartedAt,
      manifest,
      manifestFile,
      /** The lines the command prints: every value a reader needs, never the token. */
      lines: () => ({
        CLAVE_FIXTURE_SERVER_URL: server.url,
        CLAVE_FIXTURE_TOKEN_FILE: server.tokenFile,
        CLAVE_FIXTURE_RELAY_URL: relay.url,
        CLAVE_FIXTURE_ISSUER_URL: provider.issuer,
        CLAVE_FIXTURE_MACHINE_ID: machine.id,
        CLAVE_FIXTURE_WORKSPACE_ID: workspace.id,
        CLAVE_FIXTURE_SESSION_ID: seed.id,
        CLAVE_FIXTURE_NONCE: seed.nonce,
        CLAVE_FIXTURE_RECORDER_LOG: stubs.log,
        CLAVE_FIXTURE_FILE: manifestFile
      }),
      stop: async () => {
        approving?.stop()
        await stop()
      }
    }
  } catch (error) {
    await stop()
    throw error
  }
}

/** Approve every pending pairing as it appears, by name and platform. */
function approveLoop({ server, log }) {
  let stopped = false
  const run = async () => {
    while (!stopped) {
      try {
        const view = await call(server.url, server.token, 'GET', '/devices')
        for (const pending of view.body?.pending ?? []) {
          const approved = await call(server.url, server.token, 'POST', '/devices/approve', {
            pairingId: pending.id
          })
          if (approved.status === 200) log(`approved ${pending.name} (${pending.platform})`)
        }
      } catch (error) {
        log(`approve: ${error.message}`)
      }
      await sleep(500)
    }
  }
  void run()
  return {
    stop: () => {
      stopped = true
    }
  }
}

/** The running fixture's watch on its recorder: the first lines a recorder
 *  writes are handed to `onCaught(lines, null)` once; a read of the log that
 *  fails is handed over as `onCaught(null, error)`, a failure and never "no
 *  calls"; `stop` ends the watch. */
export function watchRecorder(stubs, onCaught, intervalMs = RECORDER_WATCH_MS) {
  let done = false
  const timer = setInterval(() => {
    if (done) return
    let lines
    try {
      lines = recorderLines(stubs)
    } catch (error) {
      done = true
      clearInterval(timer)
      onCaught(null, error)
      return
    }
    if (lines.length === 0) return
    done = true
    clearInterval(timer)
    onCaught(lines, null)
  }, intervalMs)
  timer.unref?.()
  return {
    stop: () => {
      done = true
      clearInterval(timer)
    }
  }
}

/** A phone's side of the hub: its own registration under its own redirect
 *  scheme, one sign-in as the owner with PKCE, the ID token kept. */
export async function phoneSignsIn(provider, redirect, clientName = 'Clave on a phone') {
  const registration = await fetch(`${provider.issuer}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: clientName,
      application_type: 'native'
    })
  })
  if (!registration.ok)
    throw new Error(`the issuer refused the registration: ${registration.status}`)
  const { client_id: clientId } = await registration.json()
  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URL(`${provider.issuer}/authorize`)
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('redirect_uri', redirect)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('scope', 'openid profile email offline_access')
  authorize.searchParams.set('state', randomBytes(8).toString('hex'))
  authorize.searchParams.set('nonce', randomBytes(8).toString('hex'))
  authorize.searchParams.set(
    'code_challenge',
    createHash('sha256').update(verifier).digest('base64url')
  )
  authorize.searchParams.set('code_challenge_method', 'S256')
  const sent = await fetch(authorize, { redirect: 'manual' })
  const location = sent.headers.get('location')
  if (sent.status !== 302 || !location)
    throw new Error(`the issuer did not redirect: ${sent.status}`)
  const back = new URL(location)
  if (!location.startsWith(redirect))
    throw new Error(`the issuer sent the browser elsewhere: ${back.origin}`)
  const code = back.searchParams.get('code')
  if (!code) throw new Error(`the issuer answered no code: ${back.searchParams.get('error')}`)
  const exchanged = await fetch(`${provider.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier
    })
  })
  if (!exchanged.ok) throw new Error(`the token exchange answered ${exchanged.status}`)
  const { id_token: idToken } = await exchanged.json()
  return { idToken, clientId, redirect }
}

/** A push socket: hello with a token, the welcome or the close code. */
function pushHello(url, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/push`)
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('the push channel did not answer'))
    }, 15_000)
    socket.on('open', () =>
      socket.send(JSON.stringify({ _tag: 'hello', token, client: 'clave-fixture-check' }))
    )
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString())
      if (frame._tag === 'welcome') {
        clearTimeout(timer)
        socket.close(1000, 'done')
        resolve({ welcome: frame })
      }
    })
    socket.on('close', (code) => {
      clearTimeout(timer)
      resolve({ closed: code })
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/**
 * The no-provider proof, on its own: after the clock's first tick would have
 * run, nothing reached a provider for the seeded chat, and the two explicit
 * usage reads are kept off by the flag (Claude) and caught by the recorder
 * (Codex). Every row names what it rests on: `announced` (the daemon's
 * flags, derived from the code), `recorder`, `wire` (the push channel, the
 * routes' answers), or `owned-folders` (the fixture's own credential
 * folders). No row ever rests on a provider's answer: none is expected. The
 * person's own folders are never read.
 */
export async function proveNoProvider(fixture, { log = stderr } = {}) {
  const { server, seed, stubs, usageEvents, titleEvents } = fixture
  const results = []
  const check = async (name, kind, fn) => {
    try {
      const detail = await fn()
      results.push({ name, kind, ok: true, detail: detail ?? null })
      log(`ok    ${name}${detail ? ` (${detail})` : ''}`)
    } catch (error) {
      results.push({ name, kind, ok: false, detail: error.message })
      log(`FAIL  ${name}: ${error.message}`)
    }
  }
  // The window is counted from the clock's start: the daemon's spawn in a
  // plain run, the test hook's call under the start-usage-clock mutation,
  // whose first tick comes five seconds after THAT (round 1, F1).
  const clockFrom = fixture.clockStartedAt ?? server.startedAt
  const sinceClock = Date.now() - clockFrom
  if (sinceClock < CLOCK_WINDOW_MS) await sleep(CLOCK_WINDOW_MS - sinceClock)

  await check(
    'the recorders saw no claude and no codex since the boot, the seeded chat included',
    'recorder',
    async () => {
      const lines = recorderLines(stubs)
      expect(lines.length === 0, `${lines.length} invocation(s): ${lines.join(' | ')}`)
      return `0 lines in ${path.basename(stubs.log)}, ${Math.round((Date.now() - server.startedAt) / 1000)} s after the boot`
    }
  )
  await check('the seeded chat was not named by a one-shot', 'wire', async () => {
    const named = titleEvents.filter((t) => t.id === seed.id)
    expect(
      named.length === 0,
      `the push channel named the chat ${named.map((t) => JSON.stringify(t.title)).join(', ')}`
    )
    return `no session.title_changed for the chat, ${titleEvents.length} for any`
  })
  await check(
    'the fixture-owned Claude config folder and Codex home are still empty: no transcript, no credential written',
    'owned-folders',
    async () => {
      const entries = ownedFolderEntries(stubs)
      expect(
        entries.claudeConfigDir.length === 0,
        `the Claude config folder holds ${entries.claudeConfigDir.join(', ')}`
      )
      expect(entries.codexHome.length === 0, `the Codex home holds ${entries.codexHome.join(', ')}`)
      return 'both empty'
    }
  )
  await check(
    'the usage clock did not run: no usage event on the push channel and no codex app-server in the recorder past the first tick (announced: testMode true)',
    'wire',
    async () => {
      expect(server.discovery.testMode === true, 'the daemon does not announce testMode')
      const codexLines = recorderLines(stubs).filter((l) => l.includes(' codex '))
      expect(
        codexLines.length === 0 && usageEvents.length === 0,
        `codex invoked: ${codexLines.join(' | ') || 'never'}; usage events heard: ${usageEvents.join(', ') || 'none'}`
      )
      return `0 usage events and 0 codex lines in ${Math.round((Date.now() - clockFrom) / 1000)} s`
    }
  )
  await check(
    'an explicit Claude usage read answers without the machine login and leaves the recorder silent (announced: machineUsage false)',
    'wire',
    async () => {
      expect(server.discovery.machineUsage === false, 'the daemon announces machineUsage true')
      const read = await call(server.url, server.token, 'GET', '/usage/claude?force=true')
      expect(read.status === 200, `GET /usage/claude answered ${read.status}`)
      expect(
        typeof read.body?.error === 'string' && !read.body.windows,
        `the read answered ${JSON.stringify(read.body).slice(0, 200)}`
      )
      const claudeLines = recorderLines(stubs).filter((l) => l.includes(' claude '))
      expect(claudeLines.length === 0, `claude invoked: ${claudeLines.join(' | ')}`)
      return `the read answered an error, no credential read: ${read.body.error}`
    }
  )
  await check(
    'an explicit Codex usage read reaches the codex recorder, exactly one line, and answers an error',
    'recorder',
    async () => {
      const before = recorderLines(stubs).filter((l) => l.includes(' codex ')).length
      const read = await call(server.url, server.token, 'GET', '/usage/codex?force=true')
      expect(read.status === 200, `GET /usage/codex answered ${read.status}`)
      expect(
        typeof read.body?.error === 'string',
        `the read answered ${JSON.stringify(read.body).slice(0, 200)}`
      )
      const lines = recorderLines(stubs).filter((l) => l.includes(' codex '))
      expect(
        lines.length === before + 1,
        `${lines.length - before} codex invocation(s): ${lines.join(' | ')}`
      )
      expect(lines.at(-1).includes(' codex app-server '), `the recorder saw: ${lines.at(-1)}`)
      return `${lines.at(-1).split(' ').slice(1).join(' ')}; ${read.body.error}`
    }
  )
  return results
}

/**
 * The pairing proof, against the running fixture: every check is a row,
 * `ok` or not, with what was seen. Real routes, real tokens of the fixture
 * issuer; the tampered tokens come from the provider's own tamper knob, so
 * each refusal names the check the daemon applied. The no-provider proof
 * runs first, its rows at the head of the list.
 */
export async function proveFixture(fixture, { log = stderr } = {}) {
  const { provider, relay, server, machine, seed } = fixture
  const results = await proveNoProvider(fixture, { log })
  const check = async (name, fn) => {
    try {
      const detail = await fn()
      results.push({ name, kind: 'wire', ok: true, detail: detail ?? null })
      log(`ok    ${name}`)
    } catch (error) {
      results.push({ name, kind: 'wire', ok: false, detail: error.message })
      log(`FAIL  ${name}: ${error.message}`)
    }
  }
  const road = `${relay.url}/m/${machine.id}`

  await check('the issuer serves its discovery document', async () => {
    const doc = await (await fetch(`${provider.issuer}/.well-known/openid-configuration`)).json()
    expect(doc.issuer === provider.issuer, `issuer ${doc.issuer}`)
    expect(typeof doc.registration_endpoint === 'string', 'no registration endpoint')
    return doc.issuer
  })
  await check('the relay answers /health with the machine online', async () => {
    const health = await call(relay.url, null, 'GET', '/health')
    expect(
      health.status === 200 && health.body?.status === 'live',
      `health ${health.status} ${JSON.stringify(health.body)}`
    )
    expect(health.body.online >= 1, `online ${health.body.online}`)
    return `${health.body.machines} known, ${health.body.online} online`
  })
  await check('the daemon answers its token and refuses none', async () => {
    const withToken = await call(server.url, server.token, 'GET', '/sessions')
    const without = await call(server.url, null, 'GET', '/sessions')
    expect(withToken.status === 200, `with the token: ${withToken.status}`)
    expect(without.status === 401, `without a token: ${without.status}`)
    return `${withToken.body.length} session(s)`
  })
  await check('the daemon is signed in as the fixture owner', async () => {
    const status = await must(server.url, server.token, 'GET', '/accounts/antasphere')
    expect(
      status.phase === 'signed-in' && status.account?.subject === OWNER.sub,
      `${status.phase} as ${status.account?.subject}`
    )
    return status.account.email
  })

  let phone = null
  let deviceSession = null
  await check('a phone registers under clave-ios:// and signs in at the issuer', async () => {
    phone = await phoneSignsIn(provider, REDIRECTS.ios, 'Clave iOS')
    expect(phone.idToken.split('.').length === 3, 'no compact JWS')
    return phone.clientId
  })
  let pairingId = null
  await check('POST /devices/pair takes the fixture-issued token without a bearer', async () => {
    const asked = await call(server.url, null, 'POST', '/devices/pair', {
      idToken: phone.idToken,
      clientId: phone.clientId,
      device: { name: 'Fixture check iPhone', platform: 'ios', appVersion: '0.0.0-check' }
    })
    expect(asked.status === 200, `${asked.status} ${JSON.stringify(asked.body)}`)
    pairingId = asked.body.pairingId
    const pending = await call(server.url, null, 'GET', `/devices/pair?id=${pairingId}`)
    expect(pending.body?.status === 'pending', `status ${pending.body?.status}`)
    return pairingId
  })
  await check(
    'the owner approves through POST /devices/approve and the session is read once',
    async () => {
      const approved = await call(server.url, server.token, 'POST', '/devices/approve', {
        pairingId
      })
      expect(approved.status === 200, `approve ${approved.status} ${JSON.stringify(approved.body)}`)
      const read = await call(server.url, null, 'GET', `/devices/pair?id=${pairingId}`)
      expect(
        read.body?.status === 'approved' && read.body.deviceSession?.token,
        `first read ${JSON.stringify(read.body)}`
      )
      deviceSession = read.body.deviceSession
      const again = await call(server.url, null, 'GET', `/devices/pair?id=${pairingId}`)
      expect(
        again.body?.status === 'approved' && !again.body.deviceSession,
        'the second read carried a token'
      )
      return deviceSession.deviceId
    }
  )
  await check(
    'the device session reaches the sessions, its record and the seeded timeline',
    async () => {
      const sessions = await call(server.url, deviceSession.token, 'GET', '/sessions')
      expect(sessions.status === 200, `sessions ${sessions.status}`)
      const me = await call(server.url, deviceSession.token, 'GET', '/devices/me')
      expect(me.status === 200 && me.body?.id === deviceSession.deviceId, `me ${me.status}`)
      const timeline = await call(
        server.url,
        deviceSession.token,
        'GET',
        `/sessions/timeline?id=${seed.id}`
      )
      expect(timeline.status === 200, `timeline ${timeline.status}`)
      const items = timeline.body.items
      expect(
        items.some((i) => i.event?.type === 'user_message' && i.event.text === seed.text),
        'the seeded message is not in the timeline'
      )
      expect(
        items.every((i) => i.position?.generation === timeline.body.cursor.generation),
        'a page mixes generations'
      )
      return `${items.length} items, cursor ${timeline.body.cursor.sequence}`
    }
  )
  await check('the device session is refused on an owner route with the one sentence', async () => {
    const accounts = await call(server.url, deviceSession.token, 'GET', '/accounts/antasphere')
    expect(accounts.status === 403, `accounts ${accounts.status}`)
    expect(accounts.body?.message === 'A phone may not do this.', JSON.stringify(accounts.body))
    const approve = await call(server.url, deviceSession.token, 'POST', '/devices/approve', {
      pairingId: 'x'
    })
    expect(approve.status === 403, `approve ${approve.status}`)
    const usage = await call(server.url, deviceSession.token, 'GET', '/usage/claude')
    expect(usage.status === 403, `usage ${usage.status}`)
  })
  await check(
    'the relay road carries the device session to the machine, and refuses nobody itself',
    async () => {
      const through = await call(road, deviceSession.token, 'GET', '/sessions')
      expect(through.status === 200, `through the relay ${through.status}`)
      const bare = await call(road, null, 'GET', '/sessions')
      expect(bare.status === 401, `without a bearer ${bare.status}`)
      const unknown = await call(
        relay.url,
        deviceSession.token,
        'GET',
        '/m/m_0000000000000000/sessions'
      )
      expect(unknown.status === 404, `unknown machine ${unknown.status}`)
    }
  )
  await check(
    'the push channel welcomes the device session, directly and through the relay',
    async () => {
      const direct = await pushHello(server.url, deviceSession.token)
      expect(direct.welcome, `direct: closed ${direct.closed}`)
      const tunnelled = await pushHello(road, deviceSession.token)
      expect(tunnelled.welcome, `through the relay: closed ${tunnelled.closed}`)
      const stranger = await pushHello(server.url, 'not-a-token')
      expect(stranger.closed === 4001, `a made-up token: ${JSON.stringify(stranger)}`)
      return direct.welcome.serverId
    }
  )

  const tampers = [
    ['audience', { aud: 'someone-else' }],
    ['signature', { key: 'other' }],
    ['issuer', { iss: 'http://127.0.0.1:1' }],
    ['subject', { sub: 'someone-else' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }]
  ]
  for (const [expected, tamper] of tampers) {
    await check(
      `a token tampered on the ${expected} is refused by the check named ${expected}`,
      async () => {
        provider.state.tamper = tamper
        const other = await phoneSignsIn(provider, REDIRECTS.android, 'Clave Android')
        const asked = await call(server.url, null, 'POST', '/devices/pair', {
          idToken: other.idToken,
          clientId: other.clientId,
          device: { name: 'Fixture check Android', platform: 'android', appVersion: '0.0.0-check' }
        })
        expect(asked.status === 422, `${asked.status} ${JSON.stringify(asked.body)}`)
        expect(asked.body?._tag === 'DevicePairingRefused', JSON.stringify(asked.body))
        expect(asked.body.check === expected, `check ${asked.body.check}`)
        expect(
          !JSON.stringify(asked.body).includes(other.idToken.slice(0, 40)),
          'the refusal echoes the token'
        )
        return asked.body.check
      }
    )
  }
  await check('a phone registered under clave-android:// pairs the same way', async () => {
    const android = await phoneSignsIn(provider, REDIRECTS.android, 'Clave Android')
    const asked = await call(server.url, null, 'POST', '/devices/pair', {
      idToken: android.idToken,
      clientId: android.clientId,
      device: { name: 'Fixture check Android', platform: 'android', appVersion: '0.0.0-check' }
    })
    expect(asked.status === 200, `${asked.status} ${JSON.stringify(asked.body)}`)
    const refused = await call(server.url, server.token, 'POST', '/devices/refuse', {
      pairingId: asked.body.pairingId
    })
    expect(refused.status === 204, `refuse ${refused.status}`)
    const read = await call(server.url, null, 'GET', `/devices/pair?id=${asked.body.pairingId}`)
    expect(read.body?.status === 'refused', `status ${read.body?.status}`)
  })
  await check(
    'the proof phone is revoked and refused afterwards, the fixture left as found',
    async () => {
      const revoked = await call(server.url, server.token, 'POST', '/devices/revoke', {
        deviceId: deviceSession.deviceId
      })
      expect(revoked.status === 204, `revoke ${revoked.status}`)
      const after = await until(async () => {
        const r = await call(server.url, deviceSession.token, 'GET', '/sessions')
        return r.status === 401 ? r : null
      })
      expect(after, 'the revoked session still reaches the sessions')
      const list = await must(server.url, server.token, 'GET', '/devices')
      expect(
        list.pending.length === 0 && !list.devices.some((d) => d.id === deviceSession.deviceId),
        'a check phone is left paired or pending'
      )
      return `${list.devices.length} phone(s) paired`
    }
  )
  return results
}

async function main(argv) {
  const options = parseArgs(argv)
  const log = options.json && !options.check ? () => {} : stderr
  if (options.preflight) {
    // The two pre-boot checks alone, on this folder's stubs and the
    // environment the daemon would get; no provider, no relay, no daemon.
    const root = options.tmpdir ?? mkdtempSync(path.join(os.tmpdir(), 'clave-native-fixture-'))
    let claim
    try {
      claim = claimRunFolder(root)
    } catch (error) {
      if (!error.refusedFolder) throw error
      stderr(error.message)
      process.exit(2)
    }
    // A reused folder is checked as it is: a dry run rewrites nothing.
    const stubs = installStubs(path.join(root, 'stubs'), { reuse: !claim.fresh })
    const env = childEnv('http://127.0.0.1:0', path.join(root, 'server'), stubs, {
      recorders: options.mutate !== 'drop-recorders'
    })
    const checks = await preflight({ flags: flagsFor(options.mutate), stubs, env, log: stderr })
    const failed = checks.filter((c) => !c.ok).length
    if (options.json) process.stdout.write(`${JSON.stringify({ preflight: checks }, null, 2)}\n`)
    else process.stdout.write(`preflight: ${checks.length} checks, ${failed} failed\n`)
    process.exit(failed ? 2 : 0)
  }
  let fixture
  try {
    fixture = await startFixture({ ...options, log })
  } catch (error) {
    if (error.refusedFolder) {
      stderr(error.message)
      process.stdout.write('refused: the run folder\n')
      process.exit(2)
    }
    if (error.checks) {
      stderr(error.message)
      if (options.json)
        process.stdout.write(
          `${JSON.stringify({ refused: true, checks: error.checks }, null, 2)}\n`
        )
      else
        process.stdout.write(
          `refused to boot: ${error.checks.filter((c) => !c.ok).length} of ${error.checks.length} checks failed\n`
        )
      process.exit(2)
    }
    throw error
  }
  let exiting = false
  const exit = async (code) => {
    if (exiting) return
    exiting = true
    await fixture.stop()
    process.exit(code)
  }
  process.on('SIGINT', () => void exit(0))
  process.on('SIGTERM', () => void exit(0))
  fixture.server.child.once('exit', (code) => {
    if (!exiting) {
      stderr(`the server exited (${code ?? 'signal'})`)
      void exit(code ?? 1)
    }
  })
  if (options.check) {
    const results = await proveFixture(fixture, { log })
    const checks = [...fixture.checks, ...results]
    const failed = checks.filter((r) => !r.ok)
    if (options.json)
      process.stdout.write(
        `${JSON.stringify({ ...fixture.lines(), mutation: options.mutate, checks }, null, 2)}\n`
      )
    else
      process.stdout.write(
        `${checks.length} checks, ${failed.length} failed${options.mutate ? ` (mutation ${options.mutate})` : ''}\n`
      )
    await exit(failed.length ? 1 : 0)
    return
  }
  // Running: the recorder is watched for as long as the fixture lives, and
  // the first line it writes stops everything with exit code 3.
  watchRecorder(fixture.stubs, (lines, error) => {
    if (error)
      stderr(
        `the recorder log could not be read (${error.message}); stopping: a read that fails is a failure, never "no calls"`
      )
    else stderr(`the recorder caught an attempt while running; stopping: ${lines.join(' | ')}`)
    void exit(3)
  })
  const lines = fixture.lines()
  if (options.json)
    process.stdout.write(`${JSON.stringify({ ...lines, checks: fixture.checks }, null, 2)}\n`)
  else {
    for (const [key, value] of Object.entries(lines)) process.stdout.write(`${key}=${value}\n`)
    process.stdout.write(
      `fixture: running${options.approve ? ', approving every pairing' : ''}, watching ${path.basename(fixture.stubs.log)}; Ctrl-C stops it. Android emulator: adb reverse the server, relay and issuer ports.\n`
    )
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    stderr(error.stack ?? String(error))
    process.exit(1)
  })

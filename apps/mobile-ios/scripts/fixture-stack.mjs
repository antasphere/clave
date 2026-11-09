#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by node */
// The isolated stack the native iPhone app is tested against, on this Mac
// and nowhere else: a local OpenID Connect provider (tests/e2e/fixtures/
// oidc-provider.mjs, which approves on sight), this checkout's relay
// (apps/relay) pointed at that provider, and this checkout's standalone
// server as a daemon with the Echo adapter (a chat that repeats what it is
// told; no real agent provider ever runs), pointed at the provider and at the
// relay. The owner signs in, the server claims its machine on the relay, one
// Echo chat is seeded with a nonce, and the facts land in <tmpdir>/stack.json.
// Everything listens on 127.0.0.1.
//
//   node apps/mobile-ios/scripts/fixture-stack.mjs [--server 47101] [--relay 47102]
//        [--tmpdir /private/tmp/clave-native-a/stack] [--approve]
//        [--dry-run | --self-check | --once | --prove-tmpdir-guard | --prove-env-guard | --prove-prerequisites
//         | --prove-inside cache|resolver|args|probe | --prove-recorder-read missing|unreadable
//         | --prove-title-guard]
//
// The run folder is the stack's own or nothing happens: a folder it made holds
// a regular file `.clave-fixture-stack` whose content is exactly this stack's
// owner id, and is emptied and reused; a folder that does not exist or is
// empty becomes one; a folder with entries and no marker, a marker that is a
// symlink, or a marker naming another owner is refused before one entry is
// touched, and so is a run root that is itself a symlink. A dry run never
// rewrites a reused folder: it works in a fresh one.
//
// Every boot runs five checks and refuses (exit 2) unless all pass, printing
// them first. Before the daemon starts (the provider and the relay are already
// up): (1) the daemon's command starts Bun
// with --no-env-file before the entry (Bun loads .env files from its working
// directory otherwise) and carries --no-titles, --test-no-activate and
// --test-no-machine-usage; (2) the environment handed to the daemon is built
// from an allowlist, its SHELL is the stack's stub, which prints a FIXED
// environment the stack wrote (never the environment of any process), the
// first folder of its PATH holds the claude and codex recorders, and
// CLAUDE_CONFIG_DIR and CODEX_HOME are empty folders the stack made. After
// the daemon announces itself and before anything is seeded:
// (3) its discovery file says titles "off", testMode true and machineUsage
// false; (4) read INSIDE the daemon through its test route (POST
// /e2e/evaluate, packages/server/src/fixtures/route.ts): its cached login
// environment (getLoginShellEnv) resolves claude and codex to the recorders
// and names the empty folders, the sorted keys of its process.env equal the
// allowlist plus the stack's own, and the one-shot launch the title path builds
// (buildOneShotLaunch over launchProfileManager.resolveClaudeCli) has the
// recorder's canonical path as its file and exactly --version as its
// arguments, a wrapper or a foreign path refused without starting anything;
// (5) only then the daemon itself executes that probe, which must answer the
// recorder's fixed line and leave exactly one line in the recorder log, the
// baseline. After the seed, the recorders and the two folders are read at
// once and then every half second for the whole run: a line beyond the
// baseline, a file in a folder, or a recorder log that cannot be read stops
// the daemon, latches the failure through the cleanup and ends the run with
// exit 2. --once and --self-check keep the stack up at least 12 s (7 s past
// the usage clock's first tick at 5 s) under that watch.
//
// --dry-run runs the two pre-boot checks on the very command and environment
// a boot would use, prints that command and exits without starting anything.
// --approve approves every pending pairing as the owner (GET /devices every
// second). --self-check proves the relay road end to end, prints PASS/FAIL
// lines and exits. --once brings the stack up, prints it and tears it down.
// The proofs keep every flag (never a wrong-flags boot) and touch the
// stack's own files alone: --prove-tmpdir-guard starts nothing and shows the
// refusals (no marker, another owner, an inexact owner id, a symlink marker, a
// symlink run root) with their sentinels intact, an owned folder reused as the
// same folder and a dry run leaving a reused folder alone; --prove-env-guard
// starts nothing and shows the second pre-boot check red on one stray
// variable, the key named and never its value; --prove-prerequisites hands check 3
// a discovery read saying titles "on"; --prove-inside cache|resolver|args
// hands check 4 a cached PATH without the recorders, a one-shot whose file is
// not the recorder, or arguments other than --version, and --prove-inside
// probe asks the daemon to run the probe against a wrong expected path, all
// refused before the seed with nothing started; --prove-recorder-read
// missing|unreadable removes or replaces the owned recorder log while the
// stack runs and expects the watch to latch a failure; --prove-title-guard
// runs the claude RECORDER itself with -p while the stack runs (never a CLI),
// so a foreign line lands in the log, and expects the watch to stop the
// daemon. Otherwise the stack runs until SIGINT/SIGTERM.
// The server's bearer token is written to <tmpdir>/owner-token (mode 0600)
// and nowhere else: never to stdout, stack.json or a log. Children's output
// goes to <tmpdir>/logs/.
//
// Import `startStack(options)` to drive the stack from another script.
import { execFileSync, spawn } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOidcProvider } from '../../../tests/e2e/fixtures/oidc-provider.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '..', '..', '..')
const BUN = path.join(REPO, 'node_modules', '.bin', 'bun')
const STEP_MS = 30_000
/** What the daemon's discovery file must announce before anything is seeded
 *  (apps/server/src/main.ts under PR #354): no tab named, the test mode on,
 *  no usage read of the machine login. */
export const PREREQUISITES = [
  ['titles', 'off'],
  ['testMode', true],
  ['machineUsage', false]
]
/** The flags every daemon boot carries (apps/server/src/main.ts, packages/host/src/test-mode.ts). */
export const DAEMON_FLAGS = ['--no-titles', '--test-no-activate', '--test-no-machine-usage']
/** The only variables of this process a child may inherit; PATH and SHELL are rebuilt. */
export const ENV_ALLOWLIST = [
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM'
]
/** The variables the stack sets itself on the daemon. */
const DAEMON_OWN_KEYS = [
  'PATH',
  'SHELL',
  'CLAVE_ANTASPHERE_ISSUER',
  'CLAVE_KEYCHAIN_FILE',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME'
]
/** The launch profile of the seeded chat; the title path resolves the Claude CLI for it. */
const ECHO_PROFILE_ID = 'dev-echo-adapter'
/** What the claude recorder answers a title one-shot with, were one ever asked. */
const STUB_TITLE = 'fixture chat'
/** The one call the daemon is asked to make, and the recorder's answer to it. */
export const PROBE_ARGS = ['--version']
export const PROBE_ANSWER = 'claude fixture-recorder'
/** A failed check stops the boot with this exit code, as lane C's fixture does. */
export const CHECK_FAILED_EXIT = 2
/** The file that marks a run folder as this stack's own, and its exact content. */
export const OWNER_MARKER = '.clave-fixture-stack'
export const OWNER_ID = 'clave native iOS fixture stack · apps/mobile-ios/scripts/fixture-stack.mjs'
/** How often the recorders and the credential folders are read while the stack runs. */
const WATCH_MS = 500
/** The least a --once or --self-check run stays up under the watch: 7 s past
 *  the usage clock's first tick at 5 s (packages/host/src/usage-manager.ts). */
const MIN_RUN_MS = 12_000
/** The daemon's modules the inside checks import, by absolute path, so the
 *  dynamic import inside the daemon lands on the daemon's own instances. */
const PTY_BACKEND = path.join(
  REPO,
  'packages',
  'host',
  'src',
  'sessions',
  'adapters',
  'pty-backend.ts'
)
const ONE_SHOT = path.join(REPO, 'packages', 'host', 'src', 'claude-one-shot.ts')
const PROFILE_MANAGER = path.join(REPO, 'packages', 'host', 'src', 'launch-profile-manager.ts')

const SHELL_LAUNCH = path.join(REPO, 'packages', 'host', 'src', 'shell-launch.ts')

export const DEFAULTS = {
  serverPort: 47101,
  relayPort: 47102,
  tmpdir: '/private/tmp/clave-native-a/stack'
}

const OWNER = {
  sub: 'fixture-owner',
  name: 'Fixture Owner',
  email: 'owner@fixture.test',
  email_verified: true
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** One word for /bin/sh, single-quoted, a quote inside it escaped. */
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
/** The stop of a boot still under way, for a signal that arrives before the stack is up. */
let inFlightStop = null

/** An error that names the step it failed and the exit code the process ends with. */
function fail(step, err, child, exitCode = 1) {
  const detail = child ? `\n--- last lines of ${child.name}'s stderr ---\n${child.tail()}` : ''
  const error = new Error(`${step} failed: ${err.message}${detail}`)
  error.fixtureStep = step
  error.exitCode = exitCode
  return error
}

const refuse = (message) =>
  fail('prepare the run folder', new Error(message), null, CHECK_FAILED_EXIT)

/**
 * The run folder, owned. A folder this stack made holds OWNER_MARKER, a
 * regular file whose content is exactly OWNER_ID, and is emptied and reused;
 * a folder that does not exist or is empty becomes one. A folder with entries
 * and no marker, a marker that is not a regular file (a symlink is read with
 * lstat and never followed), a marker naming another owner, or a run root that
 * is itself a symlink is refused before one entry is touched. Nothing here
 * removes the folder itself or anything above it.
 */
export function prepareRunFolder(tmpdir) {
  const marker = path.join(tmpdir, OWNER_MARKER)
  let root = null
  try {
    root = lstatSync(tmpdir)
  } catch {
    /* not there yet */
  }
  if (root) {
    if (root.isSymbolicLink())
      throw refuse(
        `${tmpdir} is a symlink; the run folder must be a real folder, nothing was touched`
      )
    if (!root.isDirectory()) throw refuse(`${tmpdir} is not a folder`)
    const entries = readdirSync(tmpdir)
    if (entries.length) {
      let info
      try {
        info = lstatSync(marker)
      } catch {
        throw refuse(
          `${tmpdir} holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} this stack did not make (no ${OWNER_MARKER}); choose an empty folder or one of the stack's own, nothing was touched`
        )
      }
      if (info.isSymbolicLink())
        throw refuse(`${marker} is a symlink, not the stack's marker; nothing was touched`)
      if (!info.isFile()) throw refuse(`${marker} is not a regular file; nothing was touched`)
      if (readFileSync(marker, 'utf8') !== `${OWNER_ID}\n`)
        throw refuse(`${marker} names another owner; nothing was touched`)
      for (const entry of entries)
        rmSync(path.join(tmpdir, entry), { recursive: true, force: true })
    }
  } else {
    mkdirSync(tmpdir, { recursive: true, mode: 0o700 })
  }
  writeFileSync(marker, `${OWNER_ID}\n`, { mode: 0o600 })
  return marker
}

/**
 * Where a dry run works: `tmpdir` itself when it does not exist yet (made and
 * marked), else a fresh sibling folder, so a reused folder is never rewritten
 * by a run that starts nothing. Answers the folder and whether to remove it.
 */
export function dryRunFolder(tmpdir) {
  if (!existsSync(tmpdir)) return { folder: tmpdir, fresh: false, marker: prepareRunFolder(tmpdir) }
  const folder = mkdtempSync(`${tmpdir}-dry-`)
  return { folder, fresh: true, marker: prepareRunFolder(folder) }
}

/**
 * The daemon names every fresh Claude-mode chat by its first message with a
 * one-shot of the Claude CLI, the Echo fixture included
 * (packages/host/src/title-generator.ts), under the machine's own login, with
 * the PATH of the login shell (`$SHELL -lic 'env -0'`), unless `--no-titles`
 * says not to. A fixture boot must never make that call, flag or no flag. So
 * the daemon gets a SHELL, a script named `zsh` under <tmpdir>/stubs, that
 * prints a FIXED environment the stack wrote into it at boot (the allowlist
 * plus the stack's own variables, the same the daemon is started with), never
 * the environment of any process, and runs a `-c` command with /bin/sh; a
 * PATH whose first folder holds `claude` and `codex`
 * RECORDERS, each appending one line (the time, the command, its first two
 * arguments, never the stdin) to <tmpdir>/stubs/recorder.log, the claude one
 * answering `--version` with a fixed line and a one-shot with a fixed title;
 * and an empty Claude config folder and Codex home beside them, where a real
 * CLI run with that environment would leave its files. A stub on the daemon's
 * PATH alone is not enough: the login profile would put the real CLI back in
 * front. The log is removed at every boot.
 */
function writeStubs(tmpdir, { issuer, serverDir }) {
  const dir = path.join(tmpdir, 'stubs')
  const bin = path.join(dir, 'bin')
  const claudeConfigDir = path.join(dir, 'claude-config')
  const codexHome = path.join(dir, 'codex-home')
  for (const folder of [dir, bin, claudeConfigDir, codexHome])
    mkdirSync(folder, { recursive: true, mode: 0o700 })
  const log = path.join(dir, 'recorder.log')
  rmSync(log, { recursive: true, force: true })
  const write = (file, lines) => {
    writeFileSync(file, lines.join('\n') + '\n', { mode: 0o700 })
    return file
  }
  const shell = path.join(dir, 'zsh')
  const env = daemonEnv({ issuer, serverDir, bin, shell, claudeConfigDir, codexHome })
  const envBlock = Object.keys(env)
    .sort()
    .map((key) => shQuote(`${key}=${env[key]}`))
    .join(' ')
  write(shell, [
    '#!/bin/sh',
    "# The daemon's login shell, stood in for. The daemon reads its login environment",
    "# through `$SHELL -lic 'env -0'`; this script prints a FIXED environment the stack",
    "# wrote into it at boot (the allowlist plus the stack's own variables), never the",
    '# environment of any process. A `-c` command runs with /bin/sh.',
    'cmd=""',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -c) shift; cmd="$1" ;;',
    '  esac',
    '  shift',
    'done',
    'case "$cmd" in',
    `  ""|"env -0") printf '%s\\0' ${envBlock} ;;`,
    '  *) exec /bin/sh -c "$cmd" ;;',
    'esac'
  ])
  const record = (name) =>
    `printf '%s %s %s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${name}" "$1" "$2" >> ${shQuote(log)}`
  const claude = write(path.join(bin, 'claude'), [
    '#!/bin/sh',
    '# The recorder for the claude CLI: never a real agent, never the machine login.',
    '# Every invocation is one line in the recorder log; --version answers a fixed line,',
    '# a one-shot (-p) drains its prompt and answers a fixed title.',
    record('claude'),
    'case " $* " in',
    `  *" --version "*) printf '%s\\n' '${PROBE_ANSWER}' ;;`,
    `  *" -p "*|*" --print "*) cat >/dev/null; printf '%s\\n' '${STUB_TITLE}' ;;`,
    'esac',
    'exit 0'
  ])
  const codex = write(path.join(bin, 'codex'), [
    '#!/bin/sh',
    '# The recorder for the codex CLI: never a real agent. Every invocation is one',
    '# line in the recorder log; it answers nothing and exits.',
    record('codex'),
    'exit 0'
  ])
  return { dir, bin, shell, claude, codex, log, claudeConfigDir, codexHome, env, envBlock }
}

/** The recorder log's lines; `null` when the file is absent; a throw when it cannot be read. */
export function readRecorder(stubs) {
  let info
  try {
    info = lstatSync(stubs.log)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  if (!info.isFile()) throw new Error(`${stubs.log} is not a regular file`)
  return readFileSync(stubs.log, 'utf8').split('\n').filter(Boolean)
}

/** Every entry under `folder`, relative, however deep (a sub-folder as `name/`);
 *  empty when the folder is. A folder that is missing, a symlink or unreadable
 *  throws: never "empty". */
function filesUnder(folder) {
  const info = lstatSync(folder)
  if (info.isSymbolicLink()) throw new Error(`${folder} is a symlink`)
  if (!info.isDirectory()) throw new Error(`${folder} is not a folder`)
  const out = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        // An empty folder is an entry too: something made it.
        out.push(`${rel}/`)
        walk(path.join(dir, entry.name), rel)
      } else out.push(rel)
    }
  }
  walk(folder, '')
  return out
}

/**
 * One read of the recorders and the two credential folders against the
 * baseline the probe left (`baseline.lines`, the probe's own line). Answers
 * `{ failure, violations }`: `failure` when the log cannot be read at all, is
 * absent after the probe, or lost the baseline, or when a credential folder
 * is missing, a symlink or unreadable (never "no calls", never "empty"); the
 * violations are every line beyond the baseline and every file in a folder.
 * Before the probe (`baseline` null) an absent log means no call yet.
 */
export function inspect(stubs, baseline) {
  let lines
  try {
    lines = readRecorder(stubs)
  } catch (err) {
    return { failure: `the recorder log cannot be read: ${err.message}`, violations: [] }
  }
  if (lines === null) {
    if (baseline) return { failure: 'the recorder log is missing after the probe', violations: [] }
    lines = []
  }
  const expected = baseline ? baseline.lines : []
  if (lines.length < expected.length || expected.some((line, i) => lines[i] !== line))
    return {
      failure: `the recorder log lost the probe's line: ${JSON.stringify(lines)}`,
      violations: []
    }
  const violations = lines.slice(expected.length).map((line) => `recorded: ${line}`)
  for (const [label, folder] of [
    ['the Claude config folder', stubs.claudeConfigDir],
    ['the Codex home', stubs.codexHome]
  ]) {
    let files
    try {
      files = filesUnder(folder)
    } catch (err) {
      return { failure: `${label} cannot be read: ${err.message}`, violations: [] }
    }
    for (const file of files) violations.push(`a file in ${label}: ${file}`)
  }
  return { failure: null, violations }
}

/** The problems of one inspection as lines, empty when there are none. */
export const problemsOf = ({ failure, violations }) =>
  failure ? [failure, ...violations] : violations

/** The first executable named `name` along `pathValue`, or null. */
export function locateOnPath(name, pathValue) {
  for (const folder of (pathValue ?? '').split(path.delimiter)) {
    if (!folder) continue
    const candidate = path.join(folder, name)
    try {
      const info = statSync(candidate)
      if (info.isFile() && info.mode & 0o111) return candidate
    } catch {
      /* not here */
    }
  }
  return null
}

const canonical = (p) => {
  try {
    return typeof p === 'string' ? realpathSync(p) : null
  } catch {
    return null
  }
}
const same = (a, b) => canonical(a) !== null && canonical(a) === canonical(b)
const sameList = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])

/** A child's environment, built from the allowlist and `extra`, nothing else of this process. */
function childEnv(extra = {}) {
  const env = {}
  for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key]
  return { ...env, ...extra }
}

/** The daemon's command: this checkout's server entry under Bun, Echo on, the three flags. */
export function daemonArgs({ serverDir, serverPort, relayUrl }) {
  return [
    // Bun loads .env, .env.<NODE_ENV> and .env.local from its working directory
    // unless told not to: the daemon gets exactly the environment it is handed.
    '--no-env-file',
    path.join(REPO, 'apps', 'server', 'src', 'main.ts'),
    '--data-dir',
    serverDir,
    '--daemon',
    '--port',
    String(serverPort),
    '--dev-echo-adapter',
    ...DAEMON_FLAGS,
    '--relay',
    relayUrl
  ]
}

/** The daemon's own environment: the allowlist, the issuer, a keychain FILE
 *  under its data folder, the stub as its login shell, the recorders first on
 *  PATH, the empty Claude config folder and Codex home. The same values are
 *  written into the stub shell, so the login environment the daemon reads is
 *  this one and no process's. */
export function daemonEnv({ issuer, serverDir, bin, shell, claudeConfigDir, codexHome }) {
  return childEnv({
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
    SHELL: shell,
    CLAVE_ANTASPHERE_ISSUER: issuer,
    CLAVE_KEYCHAIN_FILE: path.join(serverDir, 'keychain.json'),
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CODEX_HOME: codexHome
  })
}

/** The daemon's command as one shell line, the way the boot prints it. */
export function daemonCommandLine(args) {
  return [BUN, ...args].map((a) => (/[\s'"$]/.test(a) ? `'${a}'` : a)).join(' ')
}

/** One check: `check ok    <name> (<detail>)` or `check FAIL  <name>: <why>`, and its result kept. */
async function runCheck(results, log, name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail: detail ?? null })
    log(`check ok    ${name}${detail ? ` (${detail})` : ''}`)
  } catch (error) {
    results.push({ name, ok: false, detail: error.message })
    log(`check FAIL  ${name}: ${error.message}`)
  }
  return results[results.length - 1]
}

const expect = (condition, message) => {
  if (!condition) throw new Error(message)
}

/**
 * The two checks run BEFORE any process starts, on the very command and
 * environment the daemon gets: the command carries the three flags, and the
 * environment is the allowlist plus the stack's own variables, its SHELL the
 * stub, the first folder of its PATH the recorders', CLAUDE_CONFIG_DIR and
 * CODEX_HOME the empty folders the stack made. No shell is run here.
 */
export async function preBootChecks({ args, env, stubs, log }) {
  const results = []
  await runCheck(
    results,
    log,
    'the daemon command starts Bun with --no-env-file before the entry and carries --no-titles, --test-no-activate, --test-no-machine-usage and --dev-echo-adapter',
    () => {
      expect(
        args[0] === '--no-env-file' &&
          typeof args[1] === 'string' &&
          args[1].endsWith(path.join('apps', 'server', 'src', 'main.ts')),
        `the command does not start with --no-env-file and the server entry: ${JSON.stringify(args.slice(0, 2))}`
      )
      const literal = [
        '--no-titles',
        '--test-no-activate',
        '--test-no-machine-usage',
        '--dev-echo-adapter'
      ]
      const missing = literal.filter((flag) => !args.includes(flag))
      expect(missing.length === 0, `missing ${missing.join(', ')}`)
      expect(
        DAEMON_FLAGS.length === 3 && DAEMON_FLAGS.every((flag, i) => flag === literal[i]),
        `DAEMON_FLAGS drifted from the three flags: ${JSON.stringify(DAEMON_FLAGS)}`
      )
      return `--no-env-file, then the entry; flags: ${literal.join(' ')}`
    }
  )
  await runCheck(
    results,
    log,
    "the daemon's environment is the allowlist plus the stack's own: the stub shell, the recorders first on PATH, empty credential folders",
    () => {
      const allowed = new Set([...ENV_ALLOWLIST, ...DAEMON_OWN_KEYS])
      const stray = Object.keys(env).filter((key) => !allowed.has(key))
      expect(stray.length === 0, `the environment carries ${stray.join(', ')}`)
      expect(same(env.SHELL, stubs.shell), `SHELL is ${env.SHELL}`)
      const script = readFileSync(stubs.shell, 'utf8')
      expect(
        script.includes(`printf '%s\\0' ${stubs.envBlock} ;;`) && !script.includes('/usr/bin/env'),
        'the stub shell does not print the fixed environment the stack wrote, or still echoes a live one'
      )
      const first = (env.PATH ?? '').split(path.delimiter)[0]
      expect(same(first, stubs.bin), `the first folder of PATH is ${first}`)
      expect(
        same(locateOnPath('claude', env.PATH), stubs.claude),
        'claude on that PATH is not the recorder'
      )
      expect(
        same(locateOnPath('codex', env.PATH), stubs.codex),
        'codex on that PATH is not the recorder'
      )
      expect(
        same(env.CLAUDE_CONFIG_DIR, stubs.claudeConfigDir) &&
          filesUnder(stubs.claudeConfigDir).length === 0,
        `CLAUDE_CONFIG_DIR is ${env.CLAUDE_CONFIG_DIR ?? 'unset'} or not empty`
      )
      expect(
        same(env.CODEX_HOME, stubs.codexHome) && filesUnder(stubs.codexHome).length === 0,
        `CODEX_HOME is ${env.CODEX_HOME ?? 'unset'} or not empty`
      )
      return `${Object.keys(env).length} variables, all allowlisted or the stack's, the same written into the stub shell; claude and codex are the recorders under ${stubs.bin}`
    }
  )
  return results
}

/**
 * The source run INSIDE the daemon through POST /e2e/evaluate to read, not
 * run. Two roads, the facts naming which: on a daemon carrying lane C's title
 * hooks (`globalThis.__claveE2E.titles`, PR #354 from 33524ed6) the title
 * module itself answers `launch()` (the one-shot's executable, arguments and
 * PATH, resolved from the daemon's cached login environment by the one-shot's
 * own locate) and `locate(command)`; on a daemon without them, a dynamic
 * import by absolute path lands on the daemon's own module instances and the
 * launch is built the way the title path builds it. The cached login
 * environment is read from the daemon's own backend module either way.
 * Nothing is started.
 */
export function insideFactsSource() {
  return `async () => {
    const fs = await import('node:fs')
    const canonicalOf = (p) => { try { return typeof p === 'string' ? fs.realpathSync(p) : null } catch { return null } }
    const backend = await import(${JSON.stringify(PTY_BACKEND)})
    const login = backend.getLoginShellEnv()
    const cached = { PATH: login.PATH ?? null, SHELL: login.SHELL ?? null, CLAUDE_CONFIG_DIR: login.CLAUDE_CONFIG_DIR ?? null, CODEX_HOME: login.CODEX_HOME ?? null, keys: Object.keys(login).length }
    const base = { shell: process.env.SHELL ?? null, userShell: backend.getUserShell(), cached, envKeys: Object.keys(process.env).sort() }
    const hooks = globalThis.__claveE2E?.titles
    if (hooks && typeof hooks.launch === 'function' && typeof hooks.locate === 'function') {
      const launch = await hooks.launch()
      return {
        ...base,
        road: 'hooks',
        titlesDisabled: typeof hooks.disabled === 'function' ? hooks.disabled() : null,
        located: { claude: hooks.locate('claude'), codex: hooks.locate('codex') },
        oneShot: { file: launch.file, canonical: canonicalOf(launch.file), args: [...launch.args], PATH: launch.pathEnv ?? null }
      }
    }
    const oneShot = await import(${JSON.stringify(ONE_SHOT)})
    const profiles = await import(${JSON.stringify(PROFILE_MANAGER)})
    const shellLaunch = await import(${JSON.stringify(SHELL_LAUNCH)})
    const profile = profiles.launchProfileManager.resolveClaudeCli(null, ${JSON.stringify(ECHO_PROFILE_ID)})
    const launch = oneShot.buildOneShotLaunch({ profile, args: [], loginEnv: login, userShell: backend.getUserShell() })
    return {
      ...base,
      road: 'modules',
      titlesDisabled: null,
      located: { claude: shellLaunch.findExecutable('claude', login.PATH), codex: shellLaunch.findExecutable('codex', login.PATH) },
      profile: { id: profile.id, family: profile.family, command: profile.command },
      oneShot: {
        file: launch.file,
        canonical: canonicalOf(launch.file),
        args: launch.args,
        PATH: launch.env.PATH ?? null,
        CLAUDE_CONFIG_DIR: launch.env.CLAUDE_CONFIG_DIR ?? null,
        hasOauthToken: 'CLAUDE_CODE_OAUTH_TOKEN' in launch.env,
        hasApiKey: 'ANTHROPIC_API_KEY' in launch.env
      }
    }
  }`
}

/**
 * The source run INSIDE the daemon to execute the probe: the one-shot's
 * executable is resolved again the same way (the title hooks, else the
 * modules), its canonical path must equal the recorder's canonical path the
 * caller expects and the probe's arguments must be exactly --version, else it
 * is refused without starting anything; only then the daemon runs it, with
 * its cached login environment less any credential, and answers what it
 * printed.
 */
export function insideProbeSource() {
  return `async (expected) => {
    const fs = await import('node:fs')
    const cp = await import('node:child_process')
    const canonicalOf = (p) => { try { return typeof p === 'string' ? fs.realpathSync(p) : null } catch { return null } }
    const backend = await import(${JSON.stringify(PTY_BACKEND)})
    const login = backend.getLoginShellEnv()
    const hooks = globalThis.__claveE2E?.titles
    let file
    if (hooks && typeof hooks.launch === 'function') {
      file = (await hooks.launch()).file
    } else {
      const oneShot = await import(${JSON.stringify(ONE_SHOT)})
      const profiles = await import(${JSON.stringify(PROFILE_MANAGER)})
      const profile = profiles.launchProfileManager.resolveClaudeCli(null, ${JSON.stringify(ECHO_PROFILE_ID)})
      file = oneShot.buildOneShotLaunch({ profile, args: [], loginEnv: login, userShell: backend.getUserShell() }).file
    }
    const canonical = canonicalOf(file)
    const args = ${JSON.stringify(PROBE_ARGS)}
    const argsOk = Array.isArray(expected.args) && args.length === expected.args.length && args.every((a, i) => a === expected.args[i])
    if (canonical === null || canonical !== expected.canonical || !argsOk) return { refused: true, file, canonical, args }
    const env = { ...login }
    for (const key of ['CLAUDECODE', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[key]
    return await new Promise((resolve) => {
      cp.execFile(file, args, { env, encoding: 'utf8', timeout: 5000 }, (error, stdout, stderr) => {
        resolve({ executed: true, file, canonical, args, exitCode: error ? (error.code ?? -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '').slice(0, 300) })
      })
    })
  }`
}

/** Runs `source` inside the daemon through its test route, with `arg`; the awaited value. */
export async function evaluateInside(serverUrl, token, source, arg) {
  const response = await fetch(`${serverUrl}/e2e/evaluate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(arg === undefined ? { source } : { source, arg })
  })
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    /* not JSON */
  }
  if (response.status !== 200 || !body?.ok)
    throw new Error(`POST /e2e/evaluate answered ${response.status}: ${text.slice(0, 300)}`)
  return body.value
}

/** What the inside read must show, checked against the stubs by canonical path; the probe is not run yet. */
export function assertInside(inside, stubs, expectedEnvKeys = null) {
  expect(same(inside.shell, stubs.shell), `the daemon's SHELL is ${inside.shell}`)
  if (expectedEnvKeys) {
    const got = Array.isArray(inside.envKeys) ? inside.envKeys : []
    const extra = got.filter((k) => !expectedEnvKeys.includes(k))
    const missing = expectedEnvKeys.filter((k) => !got.includes(k))
    expect(
      extra.length === 0 && missing.length === 0,
      `the daemon's process.env keys differ from the allowlist plus the stack's own: extra [${extra.join(', ')}], missing [${missing.join(', ')}]`
    )
  }
  expect(same(inside.userShell, stubs.shell), `the daemon's login shell is ${inside.userShell}`)
  expect(
    same(inside.located?.claude, stubs.claude),
    `inside the daemon, claude on the cached login PATH is ${inside.located?.claude ?? 'nothing'}`
  )
  expect(
    same(inside.located?.codex, stubs.codex),
    `inside the daemon, codex on the cached login PATH is ${inside.located?.codex ?? 'nothing'}`
  )
  expect(
    same(locateOnPath('claude', inside.cached.PATH), stubs.claude),
    `claude on the cached login PATH is ${locateOnPath('claude', inside.cached.PATH) ?? 'nothing'}`
  )
  expect(
    same(locateOnPath('codex', inside.cached.PATH), stubs.codex),
    `codex on the cached login PATH is ${locateOnPath('codex', inside.cached.PATH) ?? 'nothing'}`
  )
  expect(
    same(inside.cached.CLAUDE_CONFIG_DIR, stubs.claudeConfigDir),
    `the cached CLAUDE_CONFIG_DIR is ${inside.cached.CLAUDE_CONFIG_DIR}`
  )
  expect(
    same(inside.cached.CODEX_HOME, stubs.codexHome),
    `the cached CODEX_HOME is ${inside.cached.CODEX_HOME}`
  )
  if (inside.road === 'hooks') {
    expect(
      typeof inside.titlesDisabled === 'string' && inside.titlesDisabled.length > 0,
      `the title hooks say titles are on (disabled() answered ${JSON.stringify(inside.titlesDisabled)})`
    )
    expect(
      Array.isArray(inside.oneShot.args) && ['-p', '--print'].includes(inside.oneShot.args[0]),
      `the one-shot's arguments start with ${JSON.stringify(inside.oneShot.args?.[0])}: a wrapper token before the one-shot's own`
    )
  } else {
    expect(
      inside.profile?.family === 'claude',
      `the resolver answered a ${inside.profile?.family} profile`
    )
    expect(
      Array.isArray(inside.oneShot.args) && inside.oneShot.args.length === 0,
      `the profile's command carries tokens beyond the executable: ${JSON.stringify(inside.oneShot.args)}`
    )
    expect(
      same(inside.oneShot.CLAUDE_CONFIG_DIR, stubs.claudeConfigDir),
      `the one-shot's CLAUDE_CONFIG_DIR is ${inside.oneShot.CLAUDE_CONFIG_DIR}`
    )
    expect(
      !inside.oneShot.hasOauthToken && !inside.oneShot.hasApiKey,
      'the one-shot environment carries a credential'
    )
  }
  expect(
    inside.oneShot.canonical !== null && inside.oneShot.canonical === canonical(stubs.claude),
    `the one-shot would start ${inside.oneShot.file} (canonical ${inside.oneShot.canonical}), not the recorder`
  )
  expect(
    same(locateOnPath('claude', inside.oneShot.PATH), stubs.claude),
    `claude on the one-shot's PATH is ${locateOnPath('claude', inside.oneShot.PATH) ?? 'nothing'}`
  )
  return `road ${inside.road}; ${Array.isArray(inside.envKeys) ? inside.envKeys.length : '?'} environment keys, exactly the allowlist plus the stack's own; SHELL ${path.basename(inside.shell)} under stubs; the daemon's own locate and its one-shot both name ${path.relative(stubs.dir, inside.oneShot.file)} by canonical path`
}

/** What the executed probe must show: run, the recorder's answer, and exactly one line in the log. */
export function assertProbe(probe, lines) {
  expect(
    !probe.refused,
    `the daemon refused the probe: ${probe.file} (canonical ${probe.canonical}) with ${JSON.stringify(probe.args)}`
  )
  expect(probe.executed === true, 'the daemon did not run the probe')
  expect(
    sameList(probe.args, PROBE_ARGS),
    `the probe ran with ${JSON.stringify(probe.args)}, not exactly ${JSON.stringify(PROBE_ARGS)}`
  )
  expect(probe.exitCode === 0, `the probe exited ${probe.exitCode}: ${probe.stderr}`)
  expect(
    probe.stdout.trim() === PROBE_ANSWER,
    `the probe answered ${JSON.stringify(probe.stdout.trim())}, not the recorder's line`
  )
  expect(lines !== null, 'the recorder log is missing after the probe')
  expect(
    lines.length === 1,
    `the recorder log holds ${lines.length} lines after the probe, not one: ${JSON.stringify(lines)}`
  )
  expect(
    /^\S+ claude --version ?$/.test(lines[0]),
    `the recorder's line is not the probe's: ${lines[0]}`
  )
  return `the daemon ran ${path.basename(probe.file)} ${probe.args.join(' ')}, got "${PROBE_ANSWER}", one line in the recorder log`
}

/** One authenticated call to the server: JSON in, JSON out, a thrown error on a non-2xx. */
export async function call(url, token, method, route, body) {
  const response = await fetch(`${url}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}: ${text}`)
  return text ? JSON.parse(text) : undefined
}

/** Makes `rootDir` a workspace of the server, named `name`, when it is not one yet. */
export async function ensureWorkspace(url, token, rootDir, name) {
  mkdirSync(rootDir, { recursive: true })
  const state = await call(url, token, 'GET', '/workspaces')
  const existing = state.workspaces.find((w) => w.rootDir === rootDir)
  if (existing) return existing
  const workspace = { id: randomUUID(), name, rootDir, profileFile: null, createdAt: Date.now() }
  const written = await call(url, token, 'POST', '/workspaces/registry', {
    workspaces: [...state.workspaces, workspace],
    base: { revision: state.revision, instance: state.instance }
  })
  if (!written.ok) throw new Error(`the server refused the workspace: ${written.reason}`)
  return workspace
}

/** Polls `probe` until it answers something truthy, or throws past `ms`. */
async function until(what, probe, { ms = STEP_MS, gapMs = 250 } = {}) {
  const deadline = Date.now() + ms
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (err) {
      lastError = err
    }
    await sleep(gapMs)
  }
  throw new Error(
    `${what}: not within ${ms / 1000} s${lastError ? ` (last error: ${lastError.message})` : ''}`
  )
}

/** A child process whose output goes to <logs>/<name>.log, the last lines
 *  of stderr kept for a failure, and every given secret redacted. Its
 *  environment is exactly `env`: nothing of this process beyond it. */
function startChild(name, cmd, args, { env, logsDir, secrets }) {
  const file = createWriteStream(path.join(logsDir, `${name}.log`), { flags: 'a' })
  const child = spawn(cmd, args, {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const tail = []
  const redact = (text) => {
    let out = text
    for (const s of secrets) if (s) out = out.split(s).join('<redacted>')
    return out
  }
  let stdoutBuffer = ''
  const stdoutLines = []
  const lineWaiters = []
  child.stdout.on('data', (d) => {
    const text = String(d)
    file.write(redact(text))
    stdoutBuffer += text
    let nl
    while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, nl)
      stdoutBuffer = stdoutBuffer.slice(nl + 1)
      stdoutLines.push(line)
      for (const w of lineWaiters.splice(0)) w()
    }
  })
  child.stderr.on('data', (d) => {
    const text = redact(String(d))
    file.write(text)
    for (const line of text.split('\n')) if (line.trim()) tail.push(line)
    if (tail.length > 20) tail.splice(0, tail.length - 20)
  })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  return {
    name,
    child,
    stdoutLines,
    tail: () => tail.slice(-12).join('\n'),
    alive: () => child.exitCode === null && child.signalCode === null,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const hard = setTimeout(() => child.kill('SIGKILL'), 8_000)
        child.kill('SIGTERM')
        await exited
        clearTimeout(hard)
      }
      await new Promise((r) => file.end(r))
    }
  }
}

async function readJson(url, bearer) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } })
  const text = await res.text()
  if (!res.ok)
    throw new Error(`GET ${new URL(url).pathname} answered ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

const itemsHolding = (page, text) =>
  (page?.items ?? []).filter((item) => JSON.stringify(item).includes(text))

/** The Echo adapter's answer: an assistant text repeating `text`. */
const echoReplyOf = (page, text) =>
  (page?.items ?? []).find(
    (item) => item.event?.type === 'assistant_text' && String(item.event.delta).includes(text)
  )

/**
 * Brings the whole stack up. Resolves the facts (the same as stack.json)
 * with `stop()` (the watch, the approver, the server, the relay, the
 * provider, in that order; it answers the problems latched or seen, empty
 * when none), `selfCheck()`, `problems` (the list latched by the watch) and
 * `died` (resolves `server`, `relay` or `recorder`). On any failure
 * everything started so far is stopped and the error thrown names the step,
 * the child's last stderr lines and the exit code.
 */
export async function startStack({
  serverPort = DEFAULTS.serverPort,
  relayPort = DEFAULTS.relayPort,
  tmpdir = DEFAULTS.tmpdir,
  approve = false,
  /** Proof runs only, every flag kept: a discovery read doctored before the
   *  third check, an inside read doctored before the fourth, a wrong expected
   *  canonical path handed to the daemon for the fifth. */
  injectDiscovery = null,
  injectInside = null,
  injectProbeExpectation = null,
  log = (line) => process.stdout.write(`fixture-stack: ${line}\n`)
} = {}) {
  const startedAt = Date.now()
  prepareRunFolder(tmpdir)
  const logsDir = path.join(tmpdir, 'logs')
  const serverDir = path.join(tmpdir, 'server')
  const relayDir = path.join(tmpdir, 'relay')
  const scratch = path.join(tmpdir, 'scratch')
  for (const dir of [logsDir, serverDir, relayDir, scratch])
    mkdirSync(dir, { recursive: true, mode: 0o700 })

  const secrets = []
  let provider = null
  let relay = null
  let server = null
  let approver = null
  let watch = null
  let stubs = null
  let baseline = null
  /** Latched by the watch: the first failure or violations it saw; never cleared. */
  let latched = null
  let stopped = false
  let resolveViolated
  const violated = new Promise((r) => {
    resolveViolated = r
  })
  const stop = async () => {
    if (stopped) return latched ?? []
    stopped = true
    inFlightStop = null
    if (watch) clearInterval(watch)
    if (approver) approver.stop()
    if (server) await server.stop()
    if (relay) await relay.stop()
    if (provider) await provider.close()
    if (latched) return latched
    return stubs && baseline ? problemsOf(inspect(stubs, baseline)) : []
  }

  inFlightStop = stop
  try {
    // 1. The provider.
    try {
      provider = await startOidcProvider({ registrationStatus: 200, user: OWNER })
    } catch (err) {
      throw fail('start the provider', err)
    }
    log(`provider up at ${provider.issuer} (port ${provider.port})`)

    // 2. The relay, trusting that provider.
    relay = startChild(
      'relay',
      BUN,
      [
        '--no-env-file',
        path.join(REPO, 'apps', 'relay', 'src', 'main.ts'),
        '--port',
        String(relayPort),
        '--data-dir',
        relayDir,
        '--issuer',
        provider.issuer
      ],
      { env: childEnv({ PATH: process.env.PATH ?? '/usr/bin:/bin' }), logsDir, secrets }
    )
    let relayUrl
    try {
      relayUrl = await until('the relay announcing its url', () => {
        if (!relay.alive()) throw new Error(`the relay exited (${relay.child.exitCode})`)
        const line = relay.stdoutLines.find((l) => l.trim().startsWith('{'))
        return line ? JSON.parse(line).url : null
      })
    } catch (err) {
      throw fail('start the relay', err, relay)
    }
    log(`relay up at ${relayUrl}`)

    // 3. The server daemon, Echo on, pointed at the provider and the relay,
    // naming no tab, the recorders catching any CLI call it makes anyway. The
    // two pre-boot checks run first, on the very command and environment the
    // daemon gets; one failing stops the boot before the daemon exists.
    stubs = writeStubs(tmpdir, { issuer: provider.issuer, serverDir })
    const args = daemonArgs({ serverDir, serverPort, relayUrl })
    const env = stubs.env
    log(`daemon command: ${daemonCommandLine(args)}`)
    const preBoot = await preBootChecks({ args, env, stubs, log })
    if (preBoot.some((c) => !c.ok))
      throw fail(
        'check the daemon before boot',
        new Error(
          preBoot
            .filter((c) => !c.ok)
            .map((c) => c.detail)
            .join('; ')
        ),
        null,
        CHECK_FAILED_EXIT
      )
    const serverStartedAt = Date.now()
    server = startChild('server', BUN, args, { env, logsDir, secrets })
    let discovery
    try {
      discovery = await until('the server announcing itself', () => {
        if (!server.alive()) throw new Error(`the server exited (${server.child.exitCode})`)
        const value = JSON.parse(readFileSync(path.join(serverDir, 'clave-server.json'), 'utf8'))
        return value.pid === server.child.pid && typeof value.token === 'string' ? value : null
      })
    } catch (err) {
      throw fail('start the server', err, server)
    }
    const token = discovery.token
    secrets.push(token)
    const serverUrl = discovery.url
    log(`server up at ${serverUrl} (serverId ${discovery.serverId})`)

    // 3b. The third check, after the daemon announced itself and before
    // anything is seeded: its discovery file says titles "off", testMode true
    // and machineUsage false. A daemon that does not say all three could
    // reach a provider, so the boot stops here, the three printed.
    const read = injectDiscovery ? { ...discovery, ...injectDiscovery } : discovery
    if (injectDiscovery)
      log(`discovery read doctored for a proof: ${JSON.stringify(injectDiscovery)}`)
    const announced = Object.fromEntries(PREREQUISITES.map(([key]) => [key, read[key]]))
    const postBoot = []
    const third = await runCheck(
      postBoot,
      log,
      'the daemon announces titles "off", testMode true and machineUsage false before anything is seeded',
      () => {
        const unmet = unmetPrerequisites(read)
        expect(
          unmet.length === 0,
          `the discovery file says ${unmet.map((key) => `${key} ${JSON.stringify(read[key])}`).join(', ')}; this daemon could reach a provider, so nothing is seeded`
        )
        return PREREQUISITES.map(([key]) => `${key}: ${JSON.stringify(read[key])}`).join(', ')
      }
    )
    if (!third.ok)
      throw fail(
        "read the daemon's prerequisites",
        new Error(third.detail),
        server,
        CHECK_FAILED_EXIT
      )

    // 3c. The fourth check, inside the daemon and still before anything is
    // seeded: its cached login environment and the one-shot launch the title
    // path would build both name the recorders, the launch's file is the
    // recorder's canonical path, its arguments exactly --version, and it
    // carries no credential. Nothing runs yet.
    let inside
    const fourth = await runCheck(
      postBoot,
      log,
      'inside the daemon, the cached login environment and the one-shot resolver name the recorders, the probe is the recorder with exactly --version',
      async () => {
        inside = await evaluateInside(serverUrl, token, insideFactsSource())
        if (injectInside) {
          inside = {
            ...inside,
            cached: { ...inside.cached, ...(injectInside.cached ?? {}) },
            oneShot: { ...inside.oneShot, ...(injectInside.oneShot ?? {}) }
          }
          log(`inside read doctored for a proof: ${JSON.stringify(injectInside)}`)
        }
        return assertInside(inside, stubs, Object.keys(env).sort())
      }
    )
    if (!fourth.ok)
      throw fail('read the daemon from inside', new Error(fourth.detail), server, CHECK_FAILED_EXIT)

    // 3d. The fifth check: the daemon itself runs the probe, after checking
    // once more inside that the launch's canonical path is the recorder's and
    // the arguments exactly --version (a wrapper or a foreign path is refused
    // without starting anything). Before it, the recorder log is absent, no
    // call yet; after it, exactly one line, the baseline of the watch.
    let probe
    const fifth = await runCheck(
      postBoot,
      log,
      "the daemon runs the probe through its own launch and the recorder answers; one line in the recorder log, the watch's baseline",
      async () => {
        const before = inspect(stubs, null)
        expect(
          !before.failure && before.violations.length === 0,
          `before the probe: ${problemsOf(before).join(' | ')}`
        )
        const expected = {
          canonical: canonical(stubs.claude),
          args: PROBE_ARGS,
          ...(injectProbeExpectation ?? {})
        }
        if (injectProbeExpectation)
          log(`probe expectation doctored for a proof: ${JSON.stringify(injectProbeExpectation)}`)
        probe = await evaluateInside(serverUrl, token, insideProbeSource(), expected)
        if (probe.refused) {
          const after = inspect(stubs, null)
          expect(
            false,
            `the daemon refused to run ${probe.file} (canonical ${probe.canonical}) with ${JSON.stringify(probe.args)}; recorder afterwards: ${after.failure ?? (after.violations.length ? after.violations.join(' | ') : 'no call')}`
          )
        }
        const lines = readRecorder(stubs)
        const detail = assertProbe(probe, lines)
        baseline = { lines }
        return detail
      }
    )
    if (!fifth.ok)
      throw fail(
        'run the probe inside the daemon',
        new Error(fifth.detail),
        server,
        CHECK_FAILED_EXIT
      )

    // 3e. The recorder watch starts here, on the probe's baseline, and covers
    // the sign-in, the seed and the whole run after: the recorders and the two
    // credential folders are read every half second. A line beyond the
    // baseline, a file in a folder, or a log or folder that cannot be read
    // stops the daemon, latches the problem through the cleanup and ends the
    // run.
    const onProblem = async (list) => {
      if (latched) return
      latched = list
      if (watch) clearInterval(watch)
      watch = null
      log(`recorder watch: ${list.join(' | ')}; stopping the daemon`)
      if (approver) approver.stop()
      await server.stop()
      resolveViolated('recorder')
    }
    watch = setInterval(() => {
      if (stopped || latched) return
      const list = problemsOf(inspect(stubs, baseline))
      if (list.length) void onProblem(list)
    }, WATCH_MS)
    log('recorder watch: on, every half second from here to the stop')

    // 4. The scratch workspace.
    let workspace
    try {
      workspace = await ensureWorkspace(serverUrl, token, scratch, 'scratch')
    } catch (err) {
      throw fail('register the scratch workspace', err, server)
    }
    log(`workspace "scratch" registered (${workspace.id})`)

    // 5. The owner signs in on the server, the provider playing the browser.
    try {
      const signIn = await call(serverUrl, token, 'POST', '/accounts/antasphere/sign-in', {})
      if (!signIn?.handoff?.url)
        throw new Error(`the sign-in answered no handoff (phase ${signIn?.status?.phase})`)
      await provider.browse(signIn.handoff.url)
      await until('the account reaching signed-in', async () => {
        const status = await call(serverUrl, token, 'GET', '/accounts/antasphere')
        return status?.phase === 'signed-in'
      })
    } catch (err) {
      throw fail('sign the owner in', err, server)
    }
    log(`owner ${OWNER.email} signed in`)

    // 6. The machine online on the relay, for the owner.
    const ownerBearer = provider.mintAccessToken({ sub: OWNER.sub })
    secrets.push(ownerBearer)
    let machine
    try {
      machine = await until('the machine online on the relay', async () => {
        const body = await readJson(`${relayUrl}/machines`, ownerBearer)
        const machines = body?.machines ?? []
        return machines.length === 1 && machines[0].online === true ? machines[0] : null
      })
    } catch (err) {
      throw fail('bring the machine online', err, server)
    }
    log(`machine ${machine.id} online on the relay ("${machine.name}", ${machine.platform})`)

    // 7. One Echo chat, seeded with a nonce.
    const nonce = `seeded-${randomBytes(4).toString('hex')}`
    let session
    try {
      session = await call(serverUrl, token, 'POST', '/sessions/start', {
        cwd: scratch,
        options: {
          claudeMode: true,
          launchProfileId: ECHO_PROFILE_ID,
          workspaceId: workspace.id
        }
      })
      await call(serverUrl, token, 'POST', '/sessions/write', {
        id: session.id,
        input: { type: 'user_message', text: nonce, clientMessageId: `m-seed-${nonce}` }
      })
      await until('the Echo reply to the nonce in the timeline', async () => {
        const page = await call(
          serverUrl,
          token,
          'GET',
          `/sessions/timeline?id=${encodeURIComponent(session.id)}`
        )
        return echoReplyOf(page, nonce)
      })
    } catch (err) {
      throw fail('seed the Echo chat', err, server)
    }
    log(`Echo chat ${session.id} seeded with ${nonce}`)

    // 7b. One explicit read after the seed, the moment a fresh chat would have
    // been named: nothing beyond the probe's line, and the watch has latched
    // nothing.
    if (latched)
      throw fail('read the recorders', new Error(latched.join(' | ')), server, CHECK_FAILED_EXIT)
    const seen = problemsOf(inspect(stubs, baseline))
    if (seen.length)
      throw fail('read the recorders', new Error(seen.join(' | ')), server, CHECK_FAILED_EXIT)
    log('recorder watch: nothing beyond the probe after the seed')

    // 8. The facts: the token to its own 0600 file, never anywhere else.
    const tokenFile = path.join(tmpdir, 'owner-token')
    writeFileSync(tokenFile, token, { mode: 0o600 })
    const facts = {
      issuer: provider.issuer,
      relay: relayUrl,
      server: serverUrl,
      serverId: discovery.serverId,
      machineId: machine.id,
      workspaceId: workspace.id,
      sessionId: session.id,
      nonce,
      scratch,
      tokenFile,
      announced,
      inside,
      probe: {
        file: probe.file,
        args: probe.args,
        exitCode: probe.exitCode,
        answer: probe.stdout.trim()
      },
      recorderLog: stubs.log,
      recorderClaude: stubs.claude,
      recorderBaseline: baseline.lines
    }
    writeFileSync(path.join(tmpdir, 'stack.json'), JSON.stringify(facts, null, 2) + '\n')

    if (approve) approver = startApprover({ serverUrl, token, log })

    const readyMs = Date.now() - startedAt
    log(`stack ready in ${(readyMs / 1000).toFixed(1)} s`)
    inFlightStop = null

    return {
      ...facts,
      readyMs,
      serverStartedAt,
      providerPort: provider.port,
      tmpdir,
      stop,
      get problems() {
        return latched
      },
      selfCheck: () => selfCheck({ facts, token, log }),
      /** Resolves when the server or the relay exits on its own, or the watch stopped the daemon. */
      died: Promise.race([
        violated,
        new Promise((r) => server.child.once('exit', () => r(latched ? 'recorder' : 'server'))),
        new Promise((r) => relay.child.once('exit', () => r('relay')))
      ])
    }
  } catch (err) {
    // The stop reads the recorders one last time: a problem seen there, or one
    // the watch latched, outranks the step it broke; the run ends on it, exit 2.
    const left = await stop()
    const problems = latched ?? (left.length ? left : null)
    if (problems && err.fixtureStep !== 'read the recorders')
      throw fail(
        'read the recorders',
        new Error(
          `${problems.join(' | ')} (while: ${err.fixtureStep ?? err.message.split('\n')[0]})`
        ),
        null,
        CHECK_FAILED_EXIT
      )
    throw err
  }
}

/** Approves every pending pairing, polling GET /devices every second. */
function startApprover({ serverUrl, token, log }) {
  let running = true
  const seen = new Set()
  ;(async () => {
    while (running) {
      try {
        const state = await call(serverUrl, token, 'GET', '/devices')
        for (const pending of state?.pending ?? []) {
          if (seen.has(pending.id)) continue
          seen.add(pending.id)
          try {
            await call(serverUrl, token, 'POST', '/devices/approve', { pairingId: pending.id })
            log(`approved pairing of "${pending.name}" (${pending.platform})`)
          } catch (err) {
            seen.delete(pending.id)
            log(`could not approve "${pending.name}": ${err.message}`)
          }
        }
      } catch (err) {
        if (running) log(`GET /devices failed: ${err.message}`)
      }
      await sleep(1000)
    }
  })()
  return {
    stop: () => {
      running = false
    }
  }
}

/** The end-to-end proof through the relay road. Resolves true on PASS. */
async function selfCheck({ facts, token, log }) {
  const road = `${facts.relay}/m/${facts.machineId}`
  const timeline = () =>
    readJson(`${road}/sessions/timeline?id=${encodeURIComponent(facts.sessionId)}`, token)
  let ok = true
  const report = (pass, what) => {
    process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${what}\n`)
    if (!pass) ok = false
  }

  try {
    const page = await timeline()
    report(
      itemsHolding(page, facts.nonce).length > 0,
      `the relay road reads the seeded chat's timeline holding ${facts.nonce} (${page.items?.length ?? 0} items)`
    )
  } catch (err) {
    report(false, `the relay road reads the seeded chat's timeline: ${err.message}`)
  }

  const text = `check-${randomBytes(4).toString('hex')}`
  try {
    const res = await fetch(`${road}/sessions/write`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: facts.sessionId,
        input: { type: 'user_message', text, clientMessageId: `m-check-${text}` }
      })
    })
    if (!res.ok)
      throw new Error(`the write answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const startedAt = Date.now()
    // The user's own message holds the text too; the proof is the assistant's.
    const reply = await until('the Echo reply', async () => echoReplyOf(await timeline(), text), {
      ms: 15_000,
      gapMs: 300
    })
    report(
      true,
      `a write through the relay road is answered by Echo (${reply.event.type} "${reply.event.delta}", sequence ${reply.position?.sequence}) in ${Date.now() - startedAt} ms`
    )
  } catch (err) {
    report(false, `a write through the relay road is answered by Echo: ${err.message}`)
  }
  log(ok ? 'self-check passed' : 'self-check failed')
  return ok
}

/** The prerequisites `discovery` does not announce as wanted, by key; empty when all three hold. */
export function unmetPrerequisites(discovery) {
  return PREREQUISITES.filter(([key, want]) => discovery?.[key] !== want).map(([key]) => key)
}

function parseArgs(argv) {
  const value = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
  }
  return {
    serverPort: Number(value('server', DEFAULTS.serverPort)),
    relayPort: Number(value('relay', DEFAULTS.relayPort)),
    tmpdir: path.resolve(value('tmpdir', DEFAULTS.tmpdir)),
    approve: argv.includes('--approve'),
    selfCheck: argv.includes('--self-check'),
    once: argv.includes('--once'),
    dryRun: argv.includes('--dry-run'),
    proveTmpdirGuard: argv.includes('--prove-tmpdir-guard'),
    proveEnvGuard: argv.includes('--prove-env-guard'),
    provePrerequisites: argv.includes('--prove-prerequisites'),
    proveInside: argv.includes('--prove-inside') ? value('prove-inside', 'resolver') : null,
    proveRecorderRead: argv.includes('--prove-recorder-read')
      ? value('prove-recorder-read', 'missing')
      : null,
    proveTitleGuard: argv.includes('--prove-title-guard')
  }
}
export { parseArgs as parseStackArgs }

/** The stdout lines another tool reads. */
export function factLines(facts) {
  return [
    `CLAVE_FIXTURE_ISSUER_URL=${facts.issuer}`,
    `CLAVE_FIXTURE_RELAY_URL=${facts.relay}`,
    `CLAVE_FIXTURE_SERVER_URL=${facts.server}`,
    `CLAVE_FIXTURE_MACHINE_ID=${facts.machineId}`,
    `CLAVE_FIXTURE_WORKSPACE_ID=${facts.workspaceId}`,
    `CLAVE_FIXTURE_SESSION_ID=${facts.sessionId}`,
    `CLAVE_FIXTURE_NONCE=${facts.nonce}`,
    `CLAVE_FIXTURE_TOKEN_FILE=${facts.tokenFile}`,
    `CLAVE_FIXTURE_RECORDER_LOG=${facts.recorderLog}`
  ]
}

/** The no-boot proofs of the run folder's guard, every folder made and removed
 *  under the system temp directory: a folder with files and no marker, one
 *  with a marker naming another owner, one whose marker is a symlink (to a
 *  file holding the exact owner id) are refused with their sentinels intact;
 *  a folder of the stack's own is emptied and reused; a dry run on a reused
 *  folder leaves it alone and works in a fresh sibling. Resolves true on PASS. */
export function proveTmpdirGuard(write = (line) => process.stdout.write(line + '\n')) {
  let ok = true
  const report = (pass, what) => {
    write(`${pass ? 'PASS' : 'FAIL'} ${what}`)
    if (!pass) ok = false
  }
  const made = []
  const folderWith = (label, setup) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `clave-fixture-guard-${label}-`))
    made.push(dir)
    const sentinel = path.join(dir, 'sentinel.txt')
    const content = `not the stack's: ${randomUUID()}\n`
    writeFileSync(sentinel, content)
    mkdirSync(path.join(dir, 'nested'))
    writeFileSync(path.join(dir, 'nested', 'also.txt'), 'kept\n')
    setup?.(dir)
    const intact = () =>
      existsSync(sentinel) &&
      readFileSync(sentinel, 'utf8') === content &&
      existsSync(path.join(dir, 'nested', 'also.txt'))
    return { dir, intact }
  }
  const refused = (what, { dir, intact }) => {
    try {
      prepareRunFolder(dir)
      report(false, `${what} was accepted`)
    } catch (err) {
      report(
        err.fixtureStep === 'prepare the run folder' && err.exitCode === 2 && intact(),
        `${what} is refused (exit ${err.exitCode}) and its sentinel is intact: ${err.message.split('\n')[0]}`
      )
    }
  }
  refused('a folder with files and no marker', folderWith('foreign'))
  refused(
    'a folder whose marker names another owner',
    folderWith('wrong-owner', (dir) =>
      writeFileSync(path.join(dir, OWNER_MARKER), 'somebody else\n')
    )
  )
  refused(
    'a folder whose marker is a symlink to a file holding the exact owner id',
    folderWith('symlink', (dir) => {
      writeFileSync(path.join(dir, 'real-marker'), `${OWNER_ID}\n`)
      symlinkSync(path.join(dir, 'real-marker'), path.join(dir, OWNER_MARKER))
    })
  )
  // The folder behind the link is the stack's own, so the refusal can only come
  // from the root being a symlink, never from a missing marker.
  const target = mkdtempSync(path.join(os.tmpdir(), 'clave-fixture-guard-target-'))
  made.push(target)
  writeFileSync(path.join(target, OWNER_MARKER), `${OWNER_ID}\n`)
  writeFileSync(path.join(target, 'sentinel.txt'), 'behind the link\n')
  const link = `${target}-link`
  symlinkSync(target, link)
  made.push(link)
  try {
    prepareRunFolder(link)
    report(false, 'a run root that is a symlink was accepted')
  } catch (err) {
    report(
      err.fixtureStep === 'prepare the run folder' &&
        err.exitCode === 2 &&
        /is a symlink; the run folder must be a real folder/.test(err.message) &&
        existsSync(path.join(target, 'sentinel.txt')),
      `a run root that is a symlink to an owned folder is refused (exit ${err.exitCode}) for being a symlink, and the folder behind it is intact: ${err.message.split('\n')[0]}`
    )
  }
  for (const [label, content] of [
    ['two newlines', `${OWNER_ID}\n\n`],
    ['no newline', OWNER_ID],
    ['a leading space', ` ${OWNER_ID}\n`],
    ['a CRLF line end', `${OWNER_ID}\r\n`]
  ]) {
    refused(
      `a folder whose marker holds the owner id with ${label}`,
      folderWith('inexact', (dir) => writeFileSync(path.join(dir, OWNER_MARKER), content))
    )
  }
  const owned = mkdtempSync(path.join(os.tmpdir(), 'clave-fixture-guard-owned-'))
  made.push(owned)
  try {
    prepareRunFolder(owned)
    const identity = statSync(owned).ino
    writeFileSync(path.join(owned, 'leftover.txt'), 'from a previous run\n')
    prepareRunFolder(owned)
    const entries = readdirSync(owned)
    report(
      entries.length === 1 &&
        entries[0] === OWNER_MARKER &&
        readFileSync(path.join(owned, OWNER_MARKER), 'utf8') === `${OWNER_ID}\n` &&
        statSync(owned).ino === identity,
      `a folder of the stack's own is emptied and reused as the same folder (same inode), its marker a regular file holding the owner id (entries after: ${entries.join(', ')})`
    )
    writeFileSync(path.join(owned, 'leftover.txt'), 'from a previous run\n')
    const dry = dryRunFolder(owned)
    made.push(dry.folder)
    report(
      dry.fresh &&
        dry.folder !== owned &&
        existsSync(path.join(owned, 'leftover.txt')) &&
        existsSync(dry.marker),
      `a dry run on a reused folder leaves it alone (leftover.txt kept) and works in a fresh sibling (${path.basename(dry.folder)})`
    )
  } catch (err) {
    report(false, `the owned folder cases threw: ${err.message}`)
  }
  for (const dir of made.reverse()) rmSync(dir, { recursive: true, force: true })
  return ok
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  let stack = null
  let ending = false
  const end = async (code) => {
    if (ending) return
    ending = true
    let left = []
    if (stack) left = await stack.stop()
    else if (inFlightStop) await inFlightStop()
    if (left.length) {
      process.stdout.write(
        `fixture-stack: the recorders or the credential folders were not silent: ${left.join(' | ')}\n`
      )
      code = CHECK_FAILED_EXIT
    }
    process.stdout.write('fixture-stack: stopped\n')
    process.exit(code)
  }
  process.on('SIGINT', () => void end(0))
  process.on('SIGTERM', () => void end(0))
  const log = (line) => process.stdout.write(`fixture-stack: ${line}\n`)
  if (options.proveTmpdirGuard) {
    process.exit(proveTmpdirGuard() ? 0 : 1)
  }
  if (options.proveEnvGuard) {
    // No boot: the second pre-boot check is handed the daemon's environment with
    // one stray variable added, and must fail naming that key and nothing else.
    const place = dryRunFolder(options.tmpdir)
    const serverDir = path.join(options.tmpdir, 'server')
    const stubs = writeStubs(place.folder, { issuer: 'http://127.0.0.1:0', serverDir })
    const args = daemonArgs({
      serverDir,
      serverPort: options.serverPort,
      relayUrl: `http://127.0.0.1:${options.relayPort}`
    })
    const env = { ...stubs.env, CLAVE_FIXTURE_STRAY_KEY: 'a value that must never be printed' }
    const results = await preBootChecks({ args, env, stubs, log })
    if (place.fresh) rmSync(place.folder, { recursive: true, force: true })
    const second = results[1]
    const red =
      second &&
      !second.ok &&
      /CLAVE_FIXTURE_STRAY_KEY/.test(second.detail) &&
      !/never be printed/.test(second.detail)
    process.stdout.write(
      `${red ? 'PASS' : 'FAIL'} the second pre-boot check goes red on one stray variable in the daemon's environment, naming the key and never its value (${second?.detail ?? 'no result'})\n`
    )
    process.exit(red ? 0 : 1)
  }
  if (options.dryRun) {
    // The two pre-boot checks on the very command and environment a boot would
    // use, nothing started: the provider, the relay and the daemon stay down,
    // and no process at all is run. A reused folder is never rewritten: the
    // dry run works in a fresh sibling when the folder already exists.
    let place
    try {
      place = dryRunFolder(options.tmpdir)
    } catch (err) {
      process.stderr.write(`fixture-stack: ${err.message}\n`)
      process.exit(err.exitCode ?? 1)
    }
    log(
      place.fresh
        ? `dry run in the fresh folder ${place.folder} (the boot's folder ${options.tmpdir} exists and is left alone); removed at the end`
        : `dry run in ${place.folder}, made and marked for the boot`
    )
    const serverDir = path.join(options.tmpdir, 'server')
    const stubs = writeStubs(place.folder, {
      issuer: 'http://127.0.0.1:<the free port the provider binds at boot>',
      serverDir
    })
    const args = daemonArgs({
      serverDir,
      serverPort: options.serverPort,
      relayUrl: `http://127.0.0.1:${options.relayPort}`
    })
    const env = stubs.env
    log(`dry run: nothing starts; the daemon command a boot runs is: ${daemonCommandLine(args)}`)
    const results = await preBootChecks({ args, env, stubs, log })
    log(
      'checks 3 to 5 run after the daemon announces itself and before anything is seeded: the discovery read (step 3b), the inside read through POST /e2e/evaluate (step 3c) and the probe the daemon runs itself (step 3d); the recorder watch runs from the probe to the stop (steps 3e and 7b)'
    )
    const ok = results.every((c) => c.ok)
    log(ok ? 'dry run: the two pre-boot checks pass' : 'dry run: a pre-boot check failed')
    if (place.fresh) rmSync(place.folder, { recursive: true, force: true })
    process.exit(ok ? 0 : CHECK_FAILED_EXIT)
  }
  const proof = async (name, options, step) => {
    try {
      stack = await startStack(options)
    } catch (err) {
      const red = err.fixtureStep === step
      process.stdout.write(`${red ? 'PASS' : 'FAIL'} ${name} (${err.message.split('\n')[0]})\n`)
      process.exit(red ? 0 : 1)
    }
    if (!step) return
    await stack.stop()
    process.stdout.write(`FAIL ${name}: the boot went on\n`)
    process.exit(1)
  }
  if (options.provePrerequisites) {
    // Every flag kept; the discovery read handed to the third check says
    // titles "on": the boot must refuse before anything is seeded.
    await proof(
      'the boot refuses before the seed when the discovery read says titles "on"',
      { ...options, injectDiscovery: { titles: 'on' } },
      "read the daemon's prerequisites"
    )
  }
  if (options.proveInside) {
    // Every flag kept. cache, resolver, args: the inside read handed to the
    // fourth check shows a cached login PATH without the recorders, a one-shot
    // whose file is not the recorder, or arguments other than --version, each
    // refused before the probe. probe: the daemon is handed a wrong expected
    // canonical path and must refuse to run its launch, nothing started.
    const doctored = {
      cache: { injectInside: { cached: { PATH: '/usr/bin:/bin' } } },
      resolver: {
        injectInside: {
          oneShot: { file: '/usr/local/bin/claude', canonical: '/usr/local/bin/claude' }
        }
      },
      args: { injectInside: { oneShot: { args: ['-p'] } } },
      probe: { injectProbeExpectation: { canonical: '/usr/local/bin/claude' } }
    }[options.proveInside]
    if (!doctored) {
      process.stderr.write(`fixture-stack: --prove-inside takes cache, resolver, args or probe\n`)
      process.exit(1)
    }
    await proof(
      `the boot refuses before the seed on a doctored ${options.proveInside} (${JSON.stringify(doctored)})`,
      { ...options, ...doctored },
      options.proveInside === 'probe'
        ? 'run the probe inside the daemon'
        : 'read the daemon from inside'
    )
  }
  if (options.proveRecorderRead) {
    // Every flag kept; the stack comes up, then the owned recorder log is
    // removed (missing) or replaced by a folder (unreadable): the watch must
    // latch a failure, never read it as "no calls", and stop the daemon.
    if (!['missing', 'unreadable'].includes(options.proveRecorderRead)) {
      process.stderr.write(`fixture-stack: --prove-recorder-read takes missing or unreadable\n`)
      process.exit(1)
    }
    await proof('the stack comes up for the recorder read proof', options, null)
    rmSync(stack.recorderLog, { force: true })
    if (options.proveRecorderRead === 'unreadable') mkdirSync(stack.recorderLog)
    const who = await Promise.race([stack.died, sleep(WATCH_MS * 10).then(() => 'nobody')])
    const left = await stack.stop()
    const red =
      who === 'recorder' &&
      left.length > 0 &&
      /cannot be read|missing after the probe/.test(left[0])
    process.stdout.write(
      `${red ? 'PASS' : 'FAIL'} a recorder log that is ${options.proveRecorderRead} is a latched failure, never "no calls" (died: ${who}; ${left.join(' | ')})\n`
    )
    process.exit(red ? 0 : 1)
  }
  if (options.proveTitleGuard) {
    // Every flag kept; the stack comes up, one line is planted in the
    // recorder log while it runs, and the watch must stop the daemon.
    await proof('the stack comes up for the recorder watch proof', options, null)
    // The claude RECORDER itself, run with -p the way a one-shot would be, never
    // a CLI: it drains the prompt, answers the fixed title and writes its line.
    const answer = execFileSync(stack.recorderClaude, ['-p'], {
      input: 'a foreign one-shot, planted by --prove-title-guard\n',
      env: { PATH: '/usr/bin:/bin' },
      encoding: 'utf8'
    })
    const who = await Promise.race([stack.died, sleep(WATCH_MS * 10).then(() => 'nobody')])
    const left = await stack.stop()
    const red =
      who === 'recorder' && left.length > 0 && left.some((l) => /recorded: .* claude -p/.test(l))
    process.stdout.write(
      `${red ? 'PASS' : 'FAIL'} the recorder watch stops the daemon when the claude recorder is run with -p while the stack runs (the recorder answered ${JSON.stringify(answer.trim())}; died: ${who}; ${left.join(' | ')})\n`
    )
    process.exit(red ? 0 : 1)
  }
  try {
    stack = await startStack(options)
  } catch (err) {
    process.stderr.write(`fixture-stack: ${err.message}\n`)
    process.exit(err.exitCode ?? 1)
  }
  process.stdout.write(factLines(stack).join('\n') + '\n')
  process.stdout.write('fixture-stack: ready\n')
  const minimumRun = async () => {
    const wait = stack.serverStartedAt + MIN_RUN_MS - Date.now()
    if (wait > 0) {
      log(`watching the recorders ${(wait / 1000).toFixed(1)} s more before stopping`)
      await Promise.race([sleep(wait), stack.died])
    }
  }
  if (options.selfCheck) {
    const ok = await stack.selfCheck()
    await minimumRun()
    await end(ok ? 0 : 1)
  } else if (options.once) {
    await minimumRun()
    await end(0)
  } else {
    const who = await stack.died
    if (who === 'recorder') {
      process.stderr.write('fixture-stack: the recorder watch stopped the daemon; stopping\n')
      await end(CHECK_FAILED_EXIT)
    } else {
      process.stderr.write(`fixture-stack: the ${who} exited on its own; stopping\n`)
      await end(1)
    }
  }
}

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
//        [--dry-run | --self-check | --once | --prove-tmpdir-guard | --prove-prerequisites
//         | --prove-inside cache|resolver | --prove-title-guard]
//
// Every boot runs four checks and refuses (exit 2) unless all pass, printing
// them first. Before any process starts: (1) the daemon's command carries
// --no-titles, --test-no-activate and --test-no-machine-usage; (2) the
// environment handed to the daemon is built from an allowlist, its SHELL is
// the stack's stub, the first folder of its PATH holds the claude and codex
// recorders, and CLAUDE_CONFIG_DIR and CODEX_HOME are empty folders the stack
// made. After the daemon announces itself and before anything is seeded:
// (3) its discovery file says titles "off", testMode true and machineUsage
// false; (4) read INSIDE the daemon through its test route (POST
// /e2e/evaluate, packages/server/src/fixtures/route.ts): its cached login
// environment (getLoginShellEnv) resolves claude and codex to the recorders
// and names the empty folders, and the one-shot launch the title path builds
// (buildOneShotLaunch over launchProfileManager.resolveClaudeCli) names the
// claude recorder as its executable. After the seed, the recorders and the
// two folders are read at once and then every half second for the whole
// run: one recorded call or one file in a folder stops the daemon and ends
// the run with exit 2. --once and --self-check keep the stack up at least
// 12 s (7 s past the usage clock's first tick at 5 s) under that watch.
//
// --dry-run runs the two pre-boot checks on the very command and environment
// a boot would use, prints that command and exits without starting anything.
// --approve approves every pending pairing as the owner (GET /devices every
// second). --self-check proves the relay road end to end, prints PASS/FAIL
// lines and exits. --once brings the stack up, prints it and tears it down.
// The proofs keep every flag (never a wrong-flags boot): --prove-tmpdir-guard
// starts nothing and shows a folder the stack does not own refused with its
// sentinel intact; --prove-prerequisites hands check 3 a discovery read
// saying titles "on"; --prove-inside cache|resolver hands check 4 a cached
// PATH without the recorders, or a one-shot executable that is not the
// recorder; --prove-title-guard plants one line in the recorder log while the
// stack runs and expects the watch to stop the daemon. Otherwise the stack
// runs until SIGINT/SIGTERM. The server's bearer token is written to
// <tmpdir>/owner-token (mode 0600) and nowhere else: never to stdout,
// stack.json or a log. Children's output goes to <tmpdir>/logs/.
//
// Import `startStack(options)` to drive the stack from another script.
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  createWriteStream,
  existsSync,
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
/** A failed check stops the boot with this exit code, as lane C's fixture does. */
export const CHECK_FAILED_EXIT = 2
/** The file that marks a run folder as this stack's own. */
export const OWNER_MARKER = '.clave-fixture-stack'
/** How often the recorders and the credential folders are read while the stack runs. */
const WATCH_MS = 500
/** The least a --once or --self-check run stays up under the watch: 7 s past
 *  the usage clock's first tick at 5 s (packages/host/src/usage-manager.ts). */
const MIN_RUN_MS = 12_000
/** The daemon's modules the inside check imports, by absolute path, so the
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

/** An error that names the step it failed and the exit code the process ends with. */
function fail(step, err, child, exitCode = 1) {
  const detail = child ? `\n--- last lines of ${child.name}'s stderr ---\n${child.tail()}` : ''
  const error = new Error(`${step} failed: ${err.message}${detail}`)
  error.fixtureStep = step
  error.exitCode = exitCode
  return error
}

/**
 * The run folder, owned: a folder this stack made carries OWNER_MARKER and is
 * emptied and reused; a folder that does not exist or is empty becomes one;
 * a folder that exists, holds anything and has no marker is refused before a
 * single entry is touched. Nothing here ever removes the folder itself or
 * anything above it.
 */
export function prepareRunFolder(tmpdir) {
  const marker = path.join(tmpdir, OWNER_MARKER)
  if (existsSync(tmpdir)) {
    if (!statSync(tmpdir).isDirectory())
      throw fail(
        'prepare the run folder',
        new Error(`${tmpdir} is not a folder`),
        null,
        CHECK_FAILED_EXIT
      )
    const entries = readdirSync(tmpdir)
    if (entries.length && !existsSync(marker))
      throw fail(
        'prepare the run folder',
        new Error(
          `${tmpdir} holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} this stack did not make (no ${OWNER_MARKER}); choose an empty folder or one of the stack's own, nothing was touched`
        ),
        null,
        CHECK_FAILED_EXIT
      )
    for (const entry of entries) rmSync(path.join(tmpdir, entry), { recursive: true, force: true })
  } else {
    mkdirSync(tmpdir, { recursive: true, mode: 0o700 })
  }
  writeFileSync(
    marker,
    `made by apps/mobile-ios/scripts/fixture-stack.mjs on ${new Date().toISOString()}; emptied at every run; safe to delete\n`,
    { mode: 0o600 }
  )
  return marker
}

/**
 * The daemon names every fresh Claude-mode chat by its first message with a
 * one-shot of the Claude CLI, the Echo fixture included
 * (packages/host/src/title-generator.ts), under the machine's own login, with
 * the PATH of the login shell (`$SHELL -lic 'env -0'`), unless `--no-titles`
 * says not to. A fixture boot must never make that call, flag or no flag. So
 * the daemon gets a SHELL, a script named `zsh` under <tmpdir>/stubs, that
 * prints the daemon's own environment whatever it is asked and runs a `-c`
 * command with /bin/sh; a PATH whose first folder holds `claude` and `codex`
 * RECORDERS, each appending one line (the time, the command, its first two
 * arguments, never the stdin) to <tmpdir>/stubs/recorder.log, the claude one
 * answering a one-shot with a fixed title; and an empty Claude config folder
 * and Codex home beside them, where a real CLI run with that environment
 * would leave its files. A stub on the daemon's PATH alone is not enough: the
 * login profile would put the real CLI back in front. The log is removed at
 * every boot.
 */
function writeStubs(tmpdir) {
  const dir = path.join(tmpdir, 'stubs')
  const bin = path.join(dir, 'bin')
  const claudeConfigDir = path.join(dir, 'claude-config')
  const codexHome = path.join(dir, 'codex-home')
  for (const folder of [dir, bin, claudeConfigDir, codexHome])
    mkdirSync(folder, { recursive: true, mode: 0o700 })
  const log = path.join(dir, 'recorder.log')
  rmSync(log, { force: true })
  const write = (file, lines) => {
    writeFileSync(file, lines.join('\n') + '\n', { mode: 0o700 })
    return file
  }
  const shell = write(path.join(dir, 'zsh'), [
    '#!/bin/sh',
    "# The daemon's login shell, stood in for: the daemon reads its login environment",
    "# through `$SHELL -lic 'env -0'`, and this environment is the fixture's own, its",
    '# PATH starting with the recorders. A `-c` command runs with /bin/sh.',
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
    'esac'
  ])
  const record = (name) =>
    `printf '%s %s %s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${name}" "$1" "$2" >> '${log}'`
  const claude = write(path.join(bin, 'claude'), [
    '#!/bin/sh',
    '# The recorder for the claude CLI: never a real agent, never the machine login.',
    '# Every invocation is one line in the recorder log; a one-shot (-p) drains its',
    '# prompt and answers a fixed title.',
    record('claude'),
    'case " $* " in',
    `  *" -p "*|*" --print "*) cat >/dev/null; printf '%s\\n' '${STUB_TITLE}' ;;`,
    `  *" --version "*) printf 'claude fixture-recorder\\n' ;;`,
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
  return { dir, bin, shell, claude, codex, log, claudeConfigDir, codexHome }
}

/** The lines the recorders wrote since the boot, never a prompt. */
function recorderLines(stubs) {
  if (!existsSync(stubs.log)) return []
  return readFileSync(stubs.log, 'utf8').split('\n').filter(Boolean)
}

/** Every file under `folder`, relative, however deep; empty when the folder is. */
function filesUnder(folder) {
  const out = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
      else out.push(rel)
    }
  }
  if (existsSync(folder)) walk(folder, '')
  return out
}

/** What the recorders and the two credential folders show: empty when nothing ran. */
export function violations(stubs) {
  const out = recorderLines(stubs).map((line) => `recorded: ${line}`)
  for (const file of filesUnder(stubs.claudeConfigDir))
    out.push(`a file in the Claude config folder: ${file}`)
  for (const file of filesUnder(stubs.codexHome)) out.push(`a file in the Codex home: ${file}`)
  return out
}

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

const same = (a, b) => {
  try {
    return typeof a === 'string' && typeof b === 'string' && realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/** A child's environment, built from the allowlist and `extra`, nothing else of this process. */
function childEnv(extra = {}) {
  const env = {}
  for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key]
  return { ...env, ...extra }
}

/** The daemon's command: this checkout's server entry under Bun, Echo on, the three flags. */
export function daemonArgs({ serverDir, serverPort, relayUrl }) {
  return [
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
 *  PATH, the empty Claude config folder and Codex home. */
export function daemonEnv({ issuer, serverDir, stubs }) {
  return childEnv({
    PATH: `${stubs.bin}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
    SHELL: stubs.shell,
    CLAVE_ANTASPHERE_ISSUER: issuer,
    CLAVE_KEYCHAIN_FILE: path.join(serverDir, 'keychain.json'),
    CLAUDE_CONFIG_DIR: stubs.claudeConfigDir,
    CODEX_HOME: stubs.codexHome
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
    'the daemon command carries --no-titles, --test-no-activate, --test-no-machine-usage and --dev-echo-adapter',
    () => {
      const missing = [...DAEMON_FLAGS, '--dev-echo-adapter'].filter((flag) => !args.includes(flag))
      expect(missing.length === 0, `missing ${missing.join(', ')}`)
      return `flags: ${DAEMON_FLAGS.join(' ')}`
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
      return `${Object.keys(env).length} variables, all allowlisted or the stack's; claude and codex are the recorders under ${stubs.bin}`
    }
  )
  return results
}

/**
 * The source run INSIDE the daemon through POST /e2e/evaluate: a dynamic
 * import by absolute path lands on the daemon's own module instances, so
 * getLoginShellEnv() answers the daemon's cached login environment, and the
 * launch the title path would build for the seeded chat's profile names the
 * executable the daemon would actually start. Nothing is started.
 */
export function insideSource() {
  return `async () => {
    const backend = await import(${JSON.stringify(PTY_BACKEND)})
    const oneShot = await import(${JSON.stringify(ONE_SHOT)})
    const profiles = await import(${JSON.stringify(PROFILE_MANAGER)})
    const login = backend.getLoginShellEnv()
    const profile = profiles.launchProfileManager.resolveClaudeCli(null, ${JSON.stringify(ECHO_PROFILE_ID)})
    const launch = oneShot.buildOneShotLaunch({ profile, args: ['-p'], loginEnv: login, userShell: backend.getUserShell() })
    return {
      shell: process.env.SHELL ?? null,
      userShell: backend.getUserShell(),
      cached: {
        PATH: login.PATH ?? null,
        SHELL: login.SHELL ?? null,
        CLAUDE_CONFIG_DIR: login.CLAUDE_CONFIG_DIR ?? null,
        CODEX_HOME: login.CODEX_HOME ?? null,
        keys: Object.keys(login).length
      },
      profile: { id: profile.id, family: profile.family, command: profile.command },
      oneShot: {
        file: launch.file,
        args: launch.args,
        PATH: launch.env.PATH ?? null,
        CLAUDE_CONFIG_DIR: launch.env.CLAUDE_CONFIG_DIR ?? null,
        hasOauthToken: 'CLAUDE_CODE_OAUTH_TOKEN' in launch.env,
        hasApiKey: 'ANTHROPIC_API_KEY' in launch.env
      }
    }
  }`
}

/** Runs `source` inside the daemon through its test route; the awaited value. */
export async function evaluateInside(serverUrl, token, source) {
  const response = await fetch(`${serverUrl}/e2e/evaluate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ source })
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

/** What the inside read must show, checked against the stubs. */
export function assertInside(inside, stubs) {
  expect(same(inside.shell, stubs.shell), `the daemon's SHELL is ${inside.shell}`)
  expect(same(inside.userShell, stubs.shell), `the daemon's login shell is ${inside.userShell}`)
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
  expect(
    inside.profile.family === 'claude',
    `the resolver answered a ${inside.profile.family} profile`
  )
  expect(same(inside.oneShot.file, stubs.claude), `the one-shot would start ${inside.oneShot.file}`)
  expect(
    same(inside.oneShot.CLAUDE_CONFIG_DIR, stubs.claudeConfigDir),
    `the one-shot's CLAUDE_CONFIG_DIR is ${inside.oneShot.CLAUDE_CONFIG_DIR}`
  )
  expect(
    !inside.oneShot.hasOauthToken && !inside.oneShot.hasApiKey,
    'the one-shot environment carries a credential'
  )
  return `SHELL ${path.basename(inside.shell)} under stubs; the cached login PATH and the resolver both name ${path.relative(stubs.dir, inside.oneShot.file)} for profile ${inside.profile.id}`
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
 * provider, in that order; it answers the violations seen, empty when none),
 * `selfCheck()`, `violation` (the list once the watch stopped the daemon)
 * and `died` (resolves `server`, `relay` or `recorder`). On any failure
 * everything started so far is stopped and the error thrown names the step,
 * the child's last stderr lines and the exit code.
 */
export async function startStack({
  serverPort = DEFAULTS.serverPort,
  relayPort = DEFAULTS.relayPort,
  tmpdir = DEFAULTS.tmpdir,
  approve = false,
  /** Proof runs only, every flag kept: a discovery read doctored before the
   *  third check, an inside read doctored before the fourth. */
  injectDiscovery = null,
  injectInside = null,
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
  let violation = null
  let stopped = false
  let resolveViolated
  const violated = new Promise((r) => {
    resolveViolated = r
  })
  const stop = async () => {
    if (stopped) return violation ?? []
    stopped = true
    if (watch) clearInterval(watch)
    if (approver) approver.stop()
    if (server) await server.stop()
    if (relay) await relay.stop()
    if (provider) await provider.close()
    return violation ?? (stubs ? violations(stubs) : [])
  }

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
    stubs = writeStubs(tmpdir)
    const args = daemonArgs({ serverDir, serverPort, relayUrl })
    const env = daemonEnv({ issuer: provider.issuer, serverDir, stubs })
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
    await runCheck(
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
    if (!postBoot[0].ok)
      throw fail(
        "read the daemon's prerequisites",
        new Error(postBoot[0].detail),
        server,
        CHECK_FAILED_EXIT
      )

    // 3c. The fourth check, inside the daemon and still before anything is
    // seeded: its cached login environment and the one-shot launch the title
    // path would build both name the recorders, and the one-shot carries no
    // credential.
    let inside
    await runCheck(
      postBoot,
      log,
      'inside the daemon, the cached login environment and the one-shot resolver name the recorders and the empty folders',
      async () => {
        inside = await evaluateInside(serverUrl, token, insideSource())
        if (injectInside) {
          inside = {
            ...inside,
            cached: { ...inside.cached, ...(injectInside.cached ?? {}) },
            oneShot: { ...inside.oneShot, ...(injectInside.oneShot ?? {}) }
          }
          log(`inside read doctored for a proof: ${JSON.stringify(injectInside)}`)
        }
        return assertInside(inside, stubs)
      }
    )
    if (!postBoot[1].ok)
      throw fail(
        'read the daemon from inside',
        new Error(postBoot[1].detail),
        server,
        CHECK_FAILED_EXIT
      )

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

    // 7b. The recorder watch: the recorders and the two credential folders
    // read now, then every half second for the whole run. One recorded call
    // or one file stops the daemon and ends the run.
    const seen = violations(stubs)
    if (seen.length)
      throw fail('read the recorders', new Error(seen.join(' | ')), server, CHECK_FAILED_EXIT)
    log(
      'recorder watch: nothing recorded after the seed; watching every half second until the stack stops'
    )
    const onViolation = async (list) => {
      if (violation) return
      violation = list
      clearInterval(watch)
      watch = null
      log(`recorder watch: ${list.join(' | ')}; stopping the daemon`)
      if (approver) approver.stop()
      await server.stop()
      resolveViolated('recorder')
    }
    watch = setInterval(() => {
      if (stopped || violation) return
      const list = violations(stubs)
      if (list.length) void onViolation(list)
    }, WATCH_MS)

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
      recorderLog: stubs.log
    }
    writeFileSync(path.join(tmpdir, 'stack.json'), JSON.stringify(facts, null, 2) + '\n')

    if (approve) approver = startApprover({ serverUrl, token, log })

    const readyMs = Date.now() - startedAt
    log(`stack ready in ${(readyMs / 1000).toFixed(1)} s`)

    return {
      ...facts,
      readyMs,
      serverStartedAt,
      providerPort: provider.port,
      tmpdir,
      stop,
      get violation() {
        return violation
      },
      selfCheck: () => selfCheck({ facts, token, log }),
      /** Resolves when the server or the relay exits on its own, or the watch stopped the daemon. */
      died: Promise.race([
        violated,
        new Promise((r) => server.child.once('exit', () => r(violation ? 'recorder' : 'server'))),
        new Promise((r) => relay.child.once('exit', () => r('relay')))
      ])
    }
  } catch (err) {
    await stop()
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
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
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
    provePrerequisites: argv.includes('--prove-prerequisites'),
    proveInside: argv.includes('--prove-inside') ? value('prove-inside', 'resolver') : null,
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

/** The no-boot proof of the run folder's guard: a folder with a sentinel and no
 *  marker is refused with the sentinel intact; a folder of the stack's own is
 *  emptied and reused. Both folders are made and removed under the system
 *  temp directory. Resolves true on PASS. */
export function proveTmpdirGuard(write = (line) => process.stdout.write(line + '\n')) {
  let ok = true
  const report = (pass, what) => {
    write(`${pass ? 'PASS' : 'FAIL'} ${what}`)
    if (!pass) ok = false
  }
  const foreign = mkdtempSync(path.join(os.tmpdir(), 'clave-fixture-guard-foreign-'))
  const sentinel = path.join(foreign, 'sentinel.txt')
  const content = `not the stack's: ${randomUUID()}\n`
  writeFileSync(sentinel, content)
  mkdirSync(path.join(foreign, 'nested'))
  writeFileSync(path.join(foreign, 'nested', 'also.txt'), 'kept\n')
  try {
    prepareRunFolder(foreign)
    report(false, 'a folder with files and no marker was accepted')
  } catch (err) {
    const intact =
      existsSync(sentinel) &&
      readFileSync(sentinel, 'utf8') === content &&
      existsSync(path.join(foreign, 'nested', 'also.txt'))
    report(
      err.fixtureStep === 'prepare the run folder' && err.exitCode === CHECK_FAILED_EXIT && intact,
      `a folder with files and no ${OWNER_MARKER} is refused (exit ${err.exitCode}) and its sentinel is intact: ${err.message.split('\n')[0]}`
    )
  }
  rmSync(foreign, { recursive: true, force: true })
  const owned = mkdtempSync(path.join(os.tmpdir(), 'clave-fixture-guard-owned-'))
  try {
    prepareRunFolder(owned)
    writeFileSync(path.join(owned, 'leftover.txt'), 'from a previous run\n')
    prepareRunFolder(owned)
    const entries = readdirSync(owned)
    report(
      entries.length === 1 && entries[0] === OWNER_MARKER,
      `a folder of the stack's own is emptied and reused (entries after: ${entries.join(', ')})`
    )
  } catch (err) {
    report(false, `a folder of the stack's own is emptied and reused: ${err.message}`)
  }
  rmSync(owned, { recursive: true, force: true })
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
  if (options.dryRun) {
    // The two pre-boot checks on the very command and environment a boot would
    // use, nothing started: the provider, the relay and the daemon stay down,
    // and no process at all is run.
    try {
      prepareRunFolder(options.tmpdir)
    } catch (err) {
      process.stderr.write(`fixture-stack: ${err.message}\n`)
      process.exit(err.exitCode ?? 1)
    }
    const serverDir = path.join(options.tmpdir, 'server')
    const stubs = writeStubs(options.tmpdir)
    const args = daemonArgs({
      serverDir,
      serverPort: options.serverPort,
      relayUrl: `http://127.0.0.1:${options.relayPort}`
    })
    const env = daemonEnv({
      issuer: 'http://127.0.0.1:<the free port the provider binds at boot>',
      serverDir,
      stubs
    })
    log(`dry run: nothing starts; the daemon command a boot runs is: ${daemonCommandLine(args)}`)
    const results = await preBootChecks({ args, env, stubs, log })
    log(
      'the third check reads the discovery file and the fourth reads inside the daemon through POST /e2e/evaluate, both after the daemon announces itself and before anything is seeded (startStack, steps 3b and 3c); the recorder watch runs from the seed to the stop (step 7b)'
    )
    const ok = results.every((c) => c.ok)
    log(ok ? 'dry run: the two pre-boot checks pass' : 'dry run: a pre-boot check failed')
    process.exit(ok ? 0 : CHECK_FAILED_EXIT)
  }
  const proof = async (name, options, step, expectedDeath = null) => {
    try {
      stack = await startStack(options)
    } catch (err) {
      const red = err.fixtureStep === step
      process.stdout.write(`${red ? 'PASS' : 'FAIL'} ${name} (${err.message.split('\n')[0]})\n`)
      process.exit(red ? 0 : 1)
    }
    if (expectedDeath) return
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
    // Every flag kept; the inside read handed to the fourth check shows a
    // cached login PATH without the recorders, or a one-shot that would start
    // something other than the recorder: the boot must refuse before the seed.
    const doctored =
      options.proveInside === 'cache'
        ? { cached: { PATH: '/usr/bin:/bin' } }
        : { oneShot: { file: '/usr/local/bin/claude' } }
    await proof(
      `the boot refuses before the seed when the inside read shows a ${options.proveInside === 'cache' ? 'divergent cached login PATH' : 'one-shot resolver naming another executable'}`,
      { ...options, injectInside: doctored },
      'read the daemon from inside'
    )
  }
  if (options.proveTitleGuard) {
    // Every flag kept; the stack comes up, one line is planted in the
    // recorder log while it runs, and the watch must stop the daemon.
    await proof('the stack comes up for the recorder watch proof', options, null, 'recorder')
    appendFileSync(
      stack.recorderLog,
      `${new Date().toISOString()} claude -p (planted by --prove-title-guard)\n`
    )
    const who = await Promise.race([stack.died, sleep(WATCH_MS * 10).then(() => 'nobody')])
    const left = await stack.stop()
    const red = who === 'recorder' && left.length > 0
    process.stdout.write(
      `${red ? 'PASS' : 'FAIL'} the recorder watch stops the daemon on a recorded CLI call while the stack runs (died: ${who}; ${left.join(' | ')})\n`
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

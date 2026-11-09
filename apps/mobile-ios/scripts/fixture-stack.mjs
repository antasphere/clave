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
//        [--dry-run | --self-check | --once | --prove-prerequisites | --prove-title-guard]
//
// Every boot runs three checks and refuses (exit 2) unless all pass, printing
// them first. Before any process starts: (1) the daemon's command carries
// --no-titles, --test-no-activate and --test-no-machine-usage; (2) the
// daemon's login environment, read the way the daemon reads it ($SHELL -lic
// 'env -0'), resolves claude and codex to the recorders and names the empty
// Claude config folder and Codex home, none of this Mac's agent logins in it.
// After the daemon announces itself and before anything is seeded: (3) its
// discovery file says titles "off", testMode true and machineUsage false.
// After the seed, the recorder interlock fails the boot on any recorded CLI
// call or any new transcript carrying the title prompt. --dry-run runs the two
// pre-boot checks on the very command and environment a boot would use,
// prints that command and exits without starting anything.
// --approve approves every pending pairing as the owner (GET /devices every
// second). --self-check proves the relay road end to end, prints PASS/FAIL
// lines and exits. --once brings the stack up, prints it and tears it down.
// The two proofs keep every flag (never a wrong-flags boot):
// --prove-prerequisites hands check 3 a discovery read saying titles "on" and
// expects the refusal before the seed; --prove-title-guard plants one line in
// the recorder log after the seed and expects the interlock to go red on it.
// Otherwise the stack runs until SIGINT/SIGTERM. The server's bearer token is
// written to <tmpdir>/owner-token (mode 0600) and nowhere else: never to
// stdout, stack.json or a log. Children's output goes to <tmpdir>/logs/.
//
// Import `startStack(options)` to drive the stack from another script.
import { execFileSync, spawn } from 'node:child_process'
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOidcProvider } from '../../../tests/e2e/fixtures/oidc-provider.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '..', '..', '..')
const BUN = path.join(REPO, 'node_modules', '.bin', 'bun')
const STEP_MS = 30_000
/** The opening line of the daemon's own title prompt (packages/host/src/session-history/index.ts). */
const TITLE_HELPER_MARKER = 'Generate a short 2-4 word title for this Claude Code terminal session'
const TRANSCRIPTS = path.join(homedir(), '.claude', 'projects')
/** What the daemon's discovery file must announce before anything is seeded
 *  (apps/server/src/main.ts under PR #354): no tab named, the test fixtures on,
 *  no usage read of the machine login. */
export const PREREQUISITES = [
  ['titles', 'off'],
  ['testMode', true],
  ['machineUsage', false]
]
/** The flags every daemon boot carries (apps/server/src/main.ts, packages/host/src/test-mode.ts). */
export const DAEMON_FLAGS = ['--no-titles', '--test-no-activate', '--test-no-machine-usage']
/** The variables of this Mac's agent logins, never handed to a child. */
const CREDENTIAL_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDECODE',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'OPENAI_API_KEY'
]
/** What the claude recorder answers a title one-shot with, were one ever asked. */
const STUB_TITLE = 'fixture chat'
/** A failed check stops the boot with this exit code, as lane C's fixture does. */
export const CHECK_FAILED_EXIT = 2
/** The recorders are read this long after the daemon started: 7 s past the
 *  usage clock's first tick at 5 s (packages/host/src/usage-manager.ts), the
 *  figure lane C's fixture uses. */
const SILENCE_MS = 12_000

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
 * and Codex home beside them. A stub on the daemon's PATH alone is not enough:
 * the login profile would put the real CLI back in front. Under `--no-titles`
 * a line in the log after the seed is a call the daemon should not have made,
 * and the boot fails on it. The log is removed at every boot.
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

/** Every transcript file under ~/.claude/projects, so a boot can tell a new one. */
function transcriptSnapshot() {
  const seen = new Set()
  if (!existsSync(TRANSCRIPTS)) return seen
  for (const dir of readdirSync(TRANSCRIPTS)) {
    const full = path.join(TRANSCRIPTS, dir)
    let entries
    try {
      if (!statSync(full).isDirectory()) continue
      entries = readdirSync(full)
    } catch {
      continue
    }
    for (const name of entries) if (name.endsWith('.jsonl')) seen.add(path.join(full, name))
  }
  return seen
}

/** The prerequisites `discovery` does not announce as wanted, by key; empty when all three hold. */
export function unmetPrerequisites(discovery) {
  return PREREQUISITES.filter(([key, want]) => discovery?.[key] !== want).map(([key]) => key)
}

/** The transcripts that appeared since `before` and carry the title prompt. */
function newTitleTranscripts(before) {
  const out = []
  for (const file of transcriptSnapshot()) {
    if (before.has(file)) continue
    try {
      if (readFileSync(file, 'utf8').includes(TITLE_HELPER_MARKER)) out.push(file)
    } catch {
      /* gone already */
    }
  }
  return out
}

/** The login environment as the daemon reads it: `$SHELL -lic 'env -0'` with `env`, parsed. */
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
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/** A child's environment: this process's, less the agent logins and the
 *  address of any server this shell is attached to, plus `extra`. */
function childEnv(extra = {}) {
  const env = { ...process.env }
  delete env.CLAVE_SERVER_URL
  delete env.CLAVE_SERVER_TOKEN
  for (const key of CREDENTIAL_KEYS) delete env[key]
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

/** The daemon's own environment: the issuer, a keychain FILE under its data
 *  folder, the stub as its login shell, the recorders first on PATH, the empty
 *  Claude config folder and Codex home. */
export function daemonEnv({ issuer, serverDir, stubs }) {
  return childEnv({
    CLAVE_ANTASPHERE_ISSUER: issuer,
    CLAVE_KEYCHAIN_FILE: path.join(serverDir, 'keychain.json'),
    SHELL: stubs.shell,
    PATH: `${stubs.bin}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
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
 * daemon's login environment, read the way the daemon reads it, resolves
 * `claude` and `codex` to the recorders, names the empty Claude config folder
 * and Codex home, and carries none of this Mac's agent logins.
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
    "the daemon's login environment resolves claude and codex to the recorders and names the empty Claude config folder and Codex home",
    () => {
      expect(same(env.SHELL, stubs.shell), `the daemon's SHELL is ${env.SHELL}`)
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
      expect(
        same(login.CLAUDE_CONFIG_DIR, stubs.claudeConfigDir) &&
          readdirSync(stubs.claudeConfigDir).length === 0,
        `CLAUDE_CONFIG_DIR is ${login.CLAUDE_CONFIG_DIR ?? 'unset'}`
      )
      expect(
        same(login.CODEX_HOME, stubs.codexHome) && readdirSync(stubs.codexHome).length === 0,
        `CODEX_HOME is ${login.CODEX_HOME ?? 'unset'}`
      )
      const leaked = CREDENTIAL_KEYS.filter(
        (key) => key !== 'CLAUDE_CONFIG_DIR' && key !== 'CODEX_HOME' && key in login
      )
      expect(leaked.length === 0, `the login environment carries ${leaked.join(', ')}`)
      expect(
        !('CLAVE_SERVER_URL' in login) && !('CLAVE_SERVER_TOKEN' in login),
        'the login environment carries a server address'
      )
      return `claude and codex are the recorders under ${stubs.bin}; CLAUDE_CONFIG_DIR and CODEX_HOME are the empty folders beside them`
    }
  )
  return results
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
 *  of stderr kept for a failure, and every given secret redacted. */
function startChild(name, cmd, args, { env, logsDir, secrets }) {
  const file = createWriteStream(path.join(logsDir, `${name}.log`), { flags: 'a' })
  const child = spawn(cmd, args, {
    cwd: REPO,
    env: childEnv(env),
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

/** What a failed step says: the error, and the child's last stderr lines. */
function fail(step, err, child, exitCode = 1) {
  const detail = child ? `\n--- last lines of ${child.name}'s stderr ---\n${child.tail()}` : ''
  const error = new Error(`${step} failed: ${err.message}${detail}`)
  error.fixtureStep = step
  error.exitCode = exitCode
  return error
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
 * with `stop()` (server, relay, provider, in that order) and `selfCheck()`.
 * On any failure everything started so far is stopped and the error thrown
 * names the step and the child's last stderr lines.
 */
export async function startStack({
  serverPort = DEFAULTS.serverPort,
  relayPort = DEFAULTS.relayPort,
  tmpdir = DEFAULTS.tmpdir,
  approve = false,
  /** Proof runs only, every flag kept: a discovery read doctored before the
   *  third check, and one line planted in the recorder log before the interlock. */
  injectDiscovery = null,
  plantRecorderLine = false,
  log = (line) => process.stdout.write(`fixture-stack: ${line}\n`)
} = {}) {
  const startedAt = Date.now()
  rmSync(tmpdir, { recursive: true, force: true })
  const logsDir = path.join(tmpdir, 'logs')
  const serverDir = path.join(tmpdir, 'server')
  const relayDir = path.join(tmpdir, 'relay')
  const scratch = path.join(tmpdir, 'scratch')
  for (const dir of [tmpdir, logsDir, serverDir, relayDir, scratch])
    mkdirSync(dir, { recursive: true, mode: 0o700 })

  const secrets = []
  let provider = null
  let relay = null
  let server = null
  let approver = null
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    if (approver) approver.stop()
    if (server) await server.stop()
    if (relay) await relay.stop()
    if (provider) await provider.close()
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
      { env: {}, logsDir, secrets }
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
    const stubs = writeStubs(tmpdir)
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
    const transcriptsBefore = transcriptSnapshot()
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
    // anything is seeded: its discovery file says titles "off", testMode
    // true and machineUsage false. A daemon that does not say all three could
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
          launchProfileId: 'dev-echo-adapter',
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

    // 7b. The recorder interlock: once the silence window since the daemon's
    // start has passed, the recorders wrote no line and no new transcript
    // carries the title prompt.
    try {
      const wait = serverStartedAt + SILENCE_MS - Date.now()
      if (wait > 0) await sleep(wait)
      if (plantRecorderLine) {
        appendFileSync(
          stubs.log,
          `${new Date().toISOString()} claude -p (planted by --prove-title-guard)\n`
        )
        log('one line planted in the recorder log for a proof')
      }
      const recorded = recorderLines(stubs)
      if (recorded.length)
        throw new Error(
          `the daemon called a CLI the recorders stood in for: ${recorded.join(' | ')}`
        )
      const leaked = newTitleTranscripts(transcriptsBefore)
      if (leaked.length)
        throw new Error(`a real title call left a transcript: ${leaked.join(', ')}`)
    } catch (err) {
      throw fail('read the recorders', err, server, CHECK_FAILED_EXIT)
    }
    log(
      `recorder interlock: no CLI call recorded ${SILENCE_MS / 1000} s after the daemon started, no new transcript carries the title prompt`
    )

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
      recorderLog: stubs.log
    }
    writeFileSync(path.join(tmpdir, 'stack.json'), JSON.stringify(facts, null, 2) + '\n')

    if (approve) approver = startApprover({ serverUrl, token, log })

    const readyMs = Date.now() - startedAt
    log(`stack ready in ${(readyMs / 1000).toFixed(1)} s`)

    return {
      ...facts,
      readyMs,
      providerPort: provider.port,
      tmpdir,
      stop,
      selfCheck: () => selfCheck({ facts, token, log }),
      /** Resolves when the server or the relay exits on its own. */
      died: Promise.race([
        new Promise((r) => server.child.once('exit', () => r('server'))),
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
    provePrerequisites: argv.includes('--prove-prerequisites'),
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
    `CLAVE_FIXTURE_TOKEN_FILE=${facts.tokenFile}`
  ]
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  let stack = null
  let ending = false
  const end = async (code) => {
    if (ending) return
    ending = true
    if (stack) await stack.stop()
    process.stdout.write('fixture-stack: stopped\n')
    process.exit(code)
  }
  process.on('SIGINT', () => void end(0))
  process.on('SIGTERM', () => void end(0))
  if (options.dryRun) {
    // The two pre-boot checks on the very command and environment a boot would
    // use, nothing started: the provider, the relay and the daemon stay down,
    // and no process but `env -0` through the stub shell runs.
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
    const log = (line) => process.stdout.write(`fixture-stack: ${line}\n`)
    log(`dry run: nothing starts; the daemon command a boot runs is: ${daemonCommandLine(args)}`)
    const results = await preBootChecks({ args, env, stubs, log })
    log(
      'the third check reads the discovery file after the daemon announces itself and before anything is seeded (startStack, step 3b)'
    )
    const ok = results.every((c) => c.ok)
    log(ok ? 'dry run: the two pre-boot checks pass' : 'dry run: a pre-boot check failed')
    process.exit(ok ? 0 : CHECK_FAILED_EXIT)
  }
  if (options.provePrerequisites) {
    // Every flag kept; the discovery read handed to the third check says
    // titles "on": the boot must refuse before anything is seeded.
    try {
      stack = await startStack({ ...options, injectDiscovery: { titles: 'on' } })
    } catch (err) {
      const red = err.fixtureStep === "read the daemon's prerequisites"
      process.stdout.write(
        `${red ? 'PASS' : 'FAIL'} the boot refuses before the seed when the discovery read says titles "on" (${err.message.split('\n')[0]})\n`
      )
      process.exit(red ? 0 : 1)
    }
    await stack.stop()
    process.stdout.write('FAIL the boot went on with a discovery read saying titles "on"\n')
    process.exit(1)
  }
  if (options.proveTitleGuard) {
    // Every flag kept; one line planted in the recorder log after the seed:
    // the interlock must go red on it.
    try {
      stack = await startStack({ ...options, plantRecorderLine: true })
    } catch (err) {
      const red = err.fixtureStep === 'read the recorders'
      process.stdout.write(
        `${red ? 'PASS' : 'FAIL'} the recorder interlock goes red on a recorded CLI call (${err.message.split('\n')[0]})\n`
      )
      process.exit(red ? 0 : 1)
    }
    await stack.stop()
    process.stdout.write(
      'FAIL the recorder interlock stayed green with a line in the recorder log\n'
    )
    process.exit(1)
  }
  try {
    stack = await startStack(options)
  } catch (err) {
    process.stderr.write(`fixture-stack: ${err.message}\n`)
    process.exit(err.exitCode ?? 1)
  }
  process.stdout.write(factLines(stack).join('\n') + '\n')
  process.stdout.write('fixture-stack: ready\n')
  if (options.selfCheck) {
    const ok = await stack.selfCheck()
    await end(ok ? 0 : 1)
  } else if (options.once) {
    await end(0)
  } else {
    const who = await stack.died
    process.stderr.write(`fixture-stack: the ${who} exited on its own; stopping\n`)
    await end(1)
  }
}

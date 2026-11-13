/**
 * A Clave server tells an agent what it can launch, and launches it on the
 * connection, the profile and the modes the agent names (PRDCT-4485). No
 * Mac: one daemon whose harness detection sees a directory of stand-ins
 * (`claude` and `codex` answering `--version`, `CLAVE_TEST_AGENT_PATH`), its
 * usage reads recorded (the machine login at 40% used, a token account
 * "Work" at 97%, out), a Codex API key added through the server's own
 * command, and a Claude chat on the stream stub as the caller, its own
 * `--mcp-config` read for the daemon MCP's url and bearer.
 *
 * Fails if: clave_launch_options loses a harness's presence or version, the
 * suggested connection or its headroom, an exhausted connection, a key's
 * connection, the harnesses not installed, a profile's form or the server's
 * name; clave_open_session lands on another connection than the one named
 * (by name or "any"), takes an unknown connection or a connection for a
 * terminal without saying why, or loses a profile named by its name;
 * clave_switch_account moves a tab while the server's switch mode is
 * propose, or does not move it once the mode is automatic.
 */
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { REPO, fixturePath, mcpHttpClient, toolErrored, toolPayload, until } from './harness.mjs'
import { fleetWorld, eventually, request } from './fixtures/fleet-world.mjs'

const WORK_TOKEN = `sk-ant-oat01-launch-options-work-${'w'.repeat(60)}`
const API_KEY = 'sk-launch-options-key-for-the-e2e-run-0123456789'
const CLAUDE_VERSION = '9.8.7'
const CODEX_VERSION = '0.987.6'
const STUB_ID = 'launch-options-stub'
const STUB_NAME = 'Launch options stream stub'
const SERVER_NAME = 'launch-options-server'
const PROPOSE_REFUSAL =
  'This server\'s switch mode is "propose", and a server has no window to propose to: move the tab from the Mac window, or set accountSwitchMode to "automatic" in the server\'s preferences.json, read when the server starts (a setting for it from the Mac\'s server pages is PRDCT-3318).'

const lines = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
const errorText = (rpc) =>
  rpc?.error?.message ?? rpc?.result?.content?.map((c) => c.text ?? '').join('\n') ?? ''

/** The stand-ins detection finds: each answers `--version`; `codex` also
 *  takes an API key the way the fleet world's own stand-in does, so the
 *  daemon's PATH and the detection's PATH name the same file. */
function seedAgents(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  const write = (name, body) => {
    const file = path.join(dir, name)
    writeFileSync(file, ['#!/bin/sh', ...body, ''].join('\n'))
    chmodSync(file, 0o755)
  }
  write('claude', [
    `if [ "$1" = --version ]; then echo "${CLAUDE_VERSION} (Claude Code)"; exit 0; fi`,
    'echo "claude stand-in: unsupported" >&2',
    'exit 1'
  ])
  write('codex', [
    `if [ "$1" = --version ]; then echo "codex-cli ${CODEX_VERSION}"; exit 0; fi`,
    'if [ "$1" = login ] && [ "$2" = --with-api-key ]; then',
    '  key=$(/bin/cat)',
    '  [ -n "$key" ] && [ -n "$CODEX_HOME" ] || { echo "codex: no key or no home" >&2; exit 1; }',
    '  case "$key" in sk-*) ;; *) echo "codex: invalid API key" >&2; exit 1 ;; esac',
    '  printf \'{"OPENAI_API_KEY":"stub"}\' > "$CODEX_HOME/auth.json"',
    '  exit 0',
    'fi',
    'echo "codex stand-in: unsupported" >&2',
    'exit 1'
  ])
  return dir
}

/** The server's own account command, as a person runs it on the server. */
function serverAccounts(server, args, stdin = '') {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [path.join(REPO, 'scripts/server-accounts.mjs'), '--data-dir', server.dataDir, ...args],
      { encoding: 'utf8', timeout: 20_000 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr })
    )
    child.stdin.end(stdin)
  })
}

/** Recorded usage reads: Claude's session window per account, Codex none. */
async function stubUsage(server, used) {
  await server.fixture.evaluate((used) => {
    const { usageClock } = globalThis.__claveE2E
    if (!usageClock) throw new Error('the daemon has no usage clock fixture')
    globalThis.__used = used
    usageClock.claude.source.read = async (accountId) => {
      const now = Date.now()
      return {
        windows: [
          {
            key: 'session:Current session (5h)',
            label: 'Current session (5h)',
            kind: 'session',
            scope: null,
            usedPercentage: globalThis.__used[accountId] ?? 0,
            resetsAt: now + 3_600_000,
            severity: null
          }
        ],
        fetchedAt: now
      }
    }
    usageClock.codex.source.read = async () => ({ windows: [], fetchedAt: Date.now() })
  }, used)
}
const refreshUsage = (server) =>
  server.fixture.evaluate(async () => {
    const { usageClock } = globalThis.__claveE2E
    await usageClock.claude.refreshAll()
    await usageClock.codex.refreshAll()
  })

export async function run(t) {
  const agents = seedAgents(fixturePath(`launch-options-agents-${process.pid}`))
  const world = await fleetWorld('launch-options', {
    count: 1,
    codexStub: true,
    env: {
      CLAVE_SERVER_NAME: SERVER_NAME,
      // Detection under --test-no-activate looks here and only here.
      CLAVE_TEST_AGENT_PATH: agents,
      // And the daemon's own PATH starts there too (it replaces the fleet
      // world's stand-in directory), so a `codex login` the server runs
      // finds the same file detection read the version of.
      PATH: `${agents}:${process.env.PATH ?? ''}`
    }
  })
  try {
    const [server] = world.servers
    const processes = () => lines(path.join(server.root, 'claude-stub-processes.jsonl'))

    // ── Setup: the usage, the accounts, the profile, the caller ──
    await stubUsage(server, { default: 40 })
    const work = await request(server, '/accounts/claude', { label: 'Work' })
    await server.fixture.evaluate((id) => {
      globalThis.__used[id] = 97
    }, work.id)
    await request(server, '/accounts/claude/token', { id: work.id, token: WORK_TOKEN })
    const keyed = await serverAccounts(server, ['codex', 'add-key', 'Billing key'], API_KEY)
    t.equal('the server command adds a Codex API-key account', keyed.code, 0, keyed.stderr)
    const billing = (await request(server, '/accounts/codex')).find(
      (a) => a.label === 'Billing key'
    )
    t.check('the Codex key account holds its credential', billing?.hasCredential === true, billing)
    await refreshUsage(server)

    await request(server, '/launch-profiles', {
      profile: {
        id: STUB_ID,
        name: STUB_NAME,
        family: 'claude',
        command: [process.execPath, path.join(REPO, 'tests/e2e/fixtures/claude-stream-stub.mjs')],
        additionalArgs: []
      }
    })
    const caller = await request(server, '/sessions/start', {
      cwd: server.root,
      options: { claudeMode: true, launchProfileId: `chat:claude:${STUB_ID}` }
    })
    await request(server, '/sessions/type', { id: caller.id, text: 'caller first message' })
    const callerConfig = path.join(server.dataDir, 'mcp-configs', `${caller.id}.json`)
    const callerLaunches = () => processes().filter((p) => p.argv.includes(callerConfig))
    await eventually(() => callerLaunches().length === 1, 'the caller CLI starts')
    const connect = async (file) => {
      const entry = JSON.parse(readFileSync(file, 'utf8')).mcpServers.clave
      const client = mcpHttpClient(entry.url, entry.headers.Authorization.replace(/^Bearer /, ''))
      await client.init()
      return client
    }
    let mcp = await connect(callerConfig)
    t.check('the caller reaches the daemon’s MCP through its own config', !!mcp)

    // ── clave_launch_options ──
    // The usage reads land asynchronously: read until Work shows as out.
    let options = null
    await until(
      async () => {
        const rpc = await mcp.call('clave_launch_options', {})
        options = toolPayload(rpc)
        const claude = options?.harnesses?.find((h) => h.id === 'claude')
        return claude?.connections?.find((c) => c.id === work.id)?.exhausted === true
      },
      { tries: 60, gapMs: 200 }
    )
    const harness = (id) => options?.harnesses?.find((h) => h.id === id)
    const claude = harness('claude')
    const codex = harness('codex')
    t.equal('clave_launch_options names this server', options?.machine?.name, SERVER_NAME)
    t.check(
      'Claude Code is listed installed, at the stand-in’s version',
      claude?.name === 'Claude Code' &&
        claude.installed === true &&
        claude.version === CLAUDE_VERSION,
      claude && { installed: claude.installed, version: claude.version }
    )
    const onDefault = claude?.connections?.find((c) => c.id === 'default')
    const onWork = claude?.connections?.find((c) => c.id === work.id)
    t.check(
      'the machine login is the suggested connection, with 60% left',
      onDefault?.suggested === true &&
        onDefault.exhausted === false &&
        /60% left/.test(onDefault.headroom ?? '') &&
        onDefault.windows?.[0]?.leftPercent === 60,
      onDefault
    )
    t.check(
      'Work is listed exhausted and not suggested',
      onWork?.label === 'Work' && onWork.exhausted === true && onWork.suggested === false,
      onWork
    )
    t.check(
      'an Opus model is served',
      claude?.models?.some((m) => /opus/i.test(`${m.id} ${m.family}`) && m.served === true),
      claude?.models
    )
    t.check(
      'the fixture profile is a Claude terminal profile',
      claude?.profiles?.some(
        (p) => p.id === STUB_ID && p.name === STUB_NAME && p.form === 'terminal'
      ),
      claude?.profiles
    )
    t.check(
      'Codex is listed installed, at the stand-in’s version',
      codex?.installed === true && codex.version === CODEX_VERSION,
      codex && { installed: codex.installed, version: codex.version }
    )
    const key = codex?.connections?.find((c) => c.id === billing?.id)
    t.check(
      'Codex lists its key connection, usable, with no usage windows',
      key?.label === 'Billing key' && key.usable === true && key.windows?.length === 0,
      key
    )
    // No custom profile of theirs exists, so the presence rule lists none of
    // the harnesses detection found absent.
    t.equal(
      'the harnesses with no stand-in are named not installed',
      [...(options?.notInstalled ?? [])].sort().join(', '),
      ['Antigravity', 'OpenCode', 'Pi'].sort().join(', ')
    )

    // ── clave_open_session: the connection, the profile, the modes ──
    const rowOf = async (id) =>
      (toolPayload(await mcp.call('clave_list', {}))?.sessions ?? []).find((s) => s.id === id)
    const openOn = async (args) =>
      mcp.call('clave_open_session', { cwd: server.root, mode: 'claude', chat: false, ...args })

    const workOpen = await openOn({ account: 'Work', name: 'On Work' })
    const workTab = toolPayload(workOpen)?.sessionId
    const workRow = await rowOf(workTab)
    t.check(
      'account "Work" by name: the tab runs on Work, exhausted, in mode claude',
      !toolErrored(workOpen) &&
        workRow?.account?.id === work.id &&
        workRow.account.exhausted === true &&
        workRow.mode === 'claude',
      { open: errorText(workOpen), row: workRow }
    )

    const anyOpen = await openOn({ account: 'any', name: 'On any' })
    const anyRow = await rowOf(toolPayload(anyOpen)?.sessionId)
    t.check(
      'account "any": the tab lands on the machine login, Work being out',
      !toolErrored(anyOpen) &&
        anyRow?.account?.id === 'default' &&
        anyRow.account.exhausted === false,
      { open: errorText(anyOpen), row: anyRow }
    )

    const nobody = await openOn({ account: 'nobody' })
    t.check(
      'an unknown connection errors and names Work',
      toolErrored(nobody) && errorText(nobody).includes('Work'),
      errorText(nobody)
    )

    const onTerminal = await mcp.call('clave_open_session', {
      cwd: server.root,
      mode: 'terminal',
      account: 'default'
    })
    t.check(
      'a connection for a terminal errors with the harnesses that have a pool',
      toolErrored(onTerminal) &&
        errorText(onTerminal).includes('Claude Code') &&
        errorText(onTerminal).includes('Codex'),
      errorText(onTerminal)
    )

    const before = processes().length
    const byName = await openOn({
      profile: STUB_NAME,
      permissionMode: 'plan',
      effort: 'high',
      name: 'By profile name'
    })
    const byNameId = toolPayload(byName)?.sessionId
    const byNameRow = await rowOf(byNameId)
    t.check(
      'a profile named by its name resolves to its id',
      !toolErrored(byName) && byNameRow?.launchProfileId === STUB_ID,
      { open: errorText(byName), row: byNameRow }
    )
    // The tab runs the stub in a terminal: its argv is what the modes became.
    const stubLaunch = await until(
      () =>
        processes()
          .slice(before)
          .find((p) => p.argv.includes('--permission-mode')),
      { tries: 60, gapMs: 200 }
    )
    const flag = (name) => stubLaunch?.argv[stubLaunch.argv.indexOf(name) + 1]
    t.check(
      'permissionMode "plan" and effort "high" are accepted and reach the CLI',
      !toolErrored(byName) && flag('--permission-mode') === 'plan' && flag('--effort') === 'high',
      stubLaunch?.argv
    )

    // ── clave_switch_account: refused in propose, made in automatic ──
    const proposed = await mcp.call('clave_switch_account', {
      sessionId: workTab,
      account: 'default'
    })
    t.check(
      'with the server’s switch mode at propose, the switch is refused in the exact words',
      toolErrored(proposed) && errorText(proposed).includes(PROPOSE_REFUSAL),
      errorText(proposed)
    )
    t.equal('and the tab stays on Work', (await rowOf(workTab))?.account?.id, work.id)
    // The mode is read first, as on the Mac: a switch to the connection the
    // tab already runs on is refused in the same words.
    const toCurrent = await mcp.call('clave_switch_account', {
      sessionId: workTab,
      account: work.id
    })
    t.check(
      'with the switch mode at propose, a switch to the current connection is refused too',
      toolErrored(toCurrent) && errorText(toCurrent).includes(PROPOSE_REFUSAL),
      errorText(toCurrent)
    )

    // No route sets a daemon's switch mode: it is a preference of its own
    // store (`preferences.json` in its data folder, cached once read), so
    // the store is written and the daemon restarted to read it at boot.
    const prefsFile = path.join(server.dataDir, 'preferences.json')
    const prefs = existsSync(prefsFile) ? JSON.parse(readFileSync(prefsFile, 'utf8')) : {}
    writeFileSync(prefsFile, JSON.stringify({ ...prefs, accountSwitchMode: 'automatic' }))
    await world.restart(0)
    await stubUsage(server, { default: 40, [work.id]: 97 })
    await refreshUsage(server)
    // The caller ended with the daemon; it is resumed and reads its tools again.
    await request(server, '/sessions/restart', { id: caller.id, account: {} })
    await eventually(
      async () =>
        (await request(server, '/sessions')).find((s) => s.id === caller.id)?.state !== 'ended',
      'the caller runs again'
    )
    await request(server, '/sessions/type', { id: caller.id, text: 'caller after restart' })
    await eventually(() => callerLaunches().length === 2, 'the caller CLI starts again')
    mcp = await connect(callerConfig)

    const switched = await mcp.call('clave_switch_account', {
      sessionId: workTab,
      account: 'default'
    })
    const answer = toolPayload(switched)
    t.check(
      'with the switch mode automatic, the tab is switched to the machine login',
      !toolErrored(switched) && answer?.switched === true && answer.account?.id === 'default',
      errorText(switched)
    )
    const movedRow = await until(
      async () => {
        const row = await rowOf(workTab)
        return row?.account?.id === 'default' ? row : null
      },
      { tries: 40, gapMs: 200 }
    )
    t.check('clave_list shows the tab on the machine login', !!movedRow, await rowOf(workTab))
  } finally {
    await world.close()
  }
}

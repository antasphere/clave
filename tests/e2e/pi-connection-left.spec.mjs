// A Pi tab that leaves its stored connection stops naming it (PRDCT-4540).
// Real hidden Electron, the in-process server, the stand-in Pi (tests/e2e/
// fixtures/pi-rpc-agent.mjs), which loads Clave's Pi extension from its
// command line as Pi does and runs each provider request through it.
//
// A Pi TERMINAL on a stored connection: the stand-in's terminal form makes
// one request each time the spec names a provider in its control file (the
// person's `/model` and a prompt). On the connection's provider the header's
// badge, the sidebar's foot and `clave_list` (the window's road and the
// Mac's served road) name the connection; on another provider they stop
// naming it and say the provider in one sentence; back on it, the name comes
// back. A Pi CHAT on the connection whose stand-in moves to another provider
// before each run (the verifier's R3-1): nothing is sent, and the turn ends
// with the sentence. A Pi CHAT whose stand-in selects a virtual model listed
// under the connection's provider (the verifier's finding 1): nothing is
// sent, and the turn ends with the "could not check" sentence. No provider
// is called; every value is made up.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  REPO,
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  until,
  userDataDir,
  fixturePath,
  mcpEndpoint,
  mcpHttpClient,
  toolPayload
} from './harness.mjs'

const DIR = userDataDir('pi-connection-left')
const ROOT = fixturePath('pi-connection-left-root')
const PI_HOME = path.join(ROOT, 'pi-agent')
const CONTROL = path.join(ROOT, 'terminal-control')
const MOVE_MARK = path.join(ROOT, 'move-chat')
const VIRTUAL_MARK = path.join(ROOT, 'virtual-chat')
const PI_AGENT = path.join(REPO, 'tests/e2e/fixtures/pi-rpc-agent.mjs')
const PI_CWD_FOLDER = `--${ROOT.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
const WS = { id: 'left-ws', name: 'Left', rootDir: ROOT, profileFile: null, createdAt: 1 }
const KIMI = 'e2e-made-up-left-kimi-0001'
const LEFT = "Pi runs on anthropic now, not on this tab's connection."
const LOGIN = "Pi runs on kimi-coding with another credential now, not with this tab's connection."
const UNCHECKED =
  'Clave could not check which credential Pi uses now, so this tab no longer names its connection.'
const CHAT_LEFT =
  "Pi was about to send this turn to anthropic, not to this chat's connection (kimi-coding): nothing was sent, and the turn ended."
const CHAT_UNCHECKED =
  'Clave could not check which credential this turn would use: nothing was sent, and the turn ended.'

const CATALOGUE = {
  fetchedAt: Date.now(),
  providers: [
    {
      id: 'kimi-code-plan-global',
      name: 'Kimi For Coding',
      env: ['KIMI_API_KEY'],
      models: [{ id: 'k-first', name: 'Kimi First', reasoning: false, toolCall: true }]
    }
  ]
}

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

function writeFixtures() {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(`${ROOT}/bin`, { recursive: true })
  mkdirSync(PI_HOME, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  writeFileSync(path.join(DIR, 'models-catalog.json'), JSON.stringify(CATALOGUE))
  seedTrustedRoots(DIR, [ROOT])
  writeFileSync(
    `${ROOT}/bin/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  writeFileSync(
    `${ROOT}/bin/pi`,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "1.5.2"; exit 0; fi
PI_STAND_IN_STATE="\${PI_CODING_AGENT_DIR}/sessions/${PI_CWD_FOLDER}"
PI_STAND_IN_ANY_PROVIDER=1
export PI_STAND_IN_STATE PI_STAND_IN_ANY_PROVIDER
case " $* " in
  *" --mode rpc "*)
    if [ -f ${quote(MOVE_MARK)} ]; then
      PI_STAND_IN_MOVE_BEFORE_RUN=anthropic/claude-stand-in
      export PI_STAND_IN_MOVE_BEFORE_RUN
    fi
    if [ -f ${quote(VIRTUAL_MARK)} ]; then
      PI_STAND_IN_VIRTUAL_BEFORE_RUN=auto
      export PI_STAND_IN_VIRTUAL_BEFORE_RUN
    fi
    exec ${quote(process.execPath)} ${quote(PI_AGENT)} "$@"
    ;;
esac
PI_STAND_IN_TERMINAL=1
PI_STAND_IN_TERMINAL_CONTROL=${quote(CONTROL)}
PI_STAND_IN_TERMINAL_USAGE=1
export PI_STAND_IN_TERMINAL PI_STAND_IN_TERMINAL_CONTROL PI_STAND_IN_TERMINAL_USAGE
exec ${quote(process.execPath)} ${quote(PI_AGENT)} "$@"
`,
    { mode: 0o755 }
  )
}

export async function run(t) {
  writeFixtures()
  const env = {
    SHELL: `${ROOT}/bin/bash`,
    PATH: `${ROOT}/bin:${process.env.PATH}`,
    PI_CODING_AGENT_DIR: PI_HOME
  }
  let app = null
  const opened = []
  try {
    const launched = await launchApp(DIR, {
      server: 'in-process',
      args: ['--test-no-machine-usage'],
      env
    })
    app = launched.app
    const win = launched.win
    await win.evaluate(() => window.electronAPI.preferencesSet('tmuxMode', false))
    await until(async () => {
      try {
        return await callMcp(app, 'list', {})
      } catch {
        return false
      }
    })
    const kimiId = await win.evaluate(async (key) => {
      const api = window.electronAPI
      const created = await api.providerConnectionAdd({ company: 'moonshot', label: 'Kimi work' })
      return (await api.providerConnectionSetKey(created.id, key)).id
    }, KIMI)
    t.check('a Kimi connection is stored', typeof kimiId === 'string' && kimiId.length > 0)

    // ── 1. A Pi terminal on Kimi ──
    const term = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'pi',
      chat: false,
      workspace: WS.id,
      account: 'Kimi work',
      name: 'Pi terminal on Kimi'
    })
    const termId = term?.sessionId
    t.check('the Pi terminal opened', !!termId, term)
    opened.push(termId)
    await callMcp(app, 'focus', { sessionId: termId })
    const header = win.locator(`[data-terminal-tile="${termId}"] .pane-header`)
    const badge = header.locator('[data-connection-badge]')
    const headerLeft = header.locator('[data-connection-left]')
    const footLine = win.locator('[data-connection-line]')
    const footLeft = win.locator('.sidebar-footer-row [data-connection-left]')
    // One request in the terminal, and the moment its usage record lands.
    const control = async (line) => {
      writeFileSync(CONTROL, line)
      await new Promise((resolve) => setTimeout(resolve, 2500))
    }
    const listed = async () =>
      ((await callMcp(app, 'list', {}))?.sessions ?? []).find((s) => s.id === termId)
    // PRDCT-4551, the verifier's finding 2: after each request, the requests
    // counted to the connection and to Pi's own sign-in. The stand-in stamps
    // each record with the time its request left, earlier than the folder's
    // watch sees the report: the request that MAKES a change must be counted
    // to the side it went to, not the side it left.
    const usageRead = () =>
      win.evaluate(() => window.electronAPI.harnessUsageRead({ range: 'today' }))
    const countedAs = async (onConnection, signIn) => {
      let last = null
      const ok = await until(
        async () => {
          last = await usageRead()
          const req = (id) =>
            last.rows.find((r) => r.harness === 'pi' && r.connectionId === id)?.requests ?? 0
          return req(kimiId) === onConnection && req(null) === signIn ? true : null
        },
        { tries: 30 }
      )
      t.check(
        `counted so far: ${onConnection} to the connection, ${signIn} to the sign-in`,
        !!ok,
        last?.rows
      )
    }
    // The Mac's served road: the terminal's own token (it has Clave's tools).
    const token = await until(() => {
      const file = path.join(DIR, 'mcp-configs', `${termId}.json`)
      return existsSync(file)
        ? JSON.parse(readFileSync(file, 'utf8')).mcpServers.clave.headers.Authorization.slice(7)
        : null
    })
    const served = async () => {
      const client = mcpHttpClient(mcpEndpoint(DIR), token)
      await client.init()
      return (toolPayload(await client.call('clave_list', {}))?.sessions ?? []).find(
        (s) => s.id === termId
      )
    }

    await control('kimi-coding')
    const named = await until(async () => ((await badge.count()) > 0 ? true : null), {
      tries: 60
    })
    t.check('on its connection, the header names it', !!named)
    t.equal('the badge reads Kimi work', await badge.innerText(), 'Kimi work')
    t.check('the sidebar foot names it', (await footLine.count()) > 0)
    t.equal("the window's clave_list names it", (await listed())?.account?.label, 'Kimi work')
    await countedAs(1, 0)

    // ── The person's /model to another provider, and a prompt ──
    await control('anthropic')
    const left = await until(async () => ((await headerLeft.count()) > 0 ? true : null), {
      tries: 60
    })
    t.check('off its connection, the header says so', !!left)
    t.equal('in one sentence naming the provider', await headerLeft.innerText(), LEFT)
    t.equal('and no longer names the connection', await badge.count(), 0)
    t.equal('the sidebar foot says the same', await footLeft.innerText(), LEFT)
    t.equal('and names no connection', await footLine.count(), 0)
    const windowRow = await listed()
    t.equal("the window's clave_list names no connection", windowRow?.account ?? null, null)
    t.equal('and says the same sentence', windowRow?.connectionLeft, LEFT)
    const servedRow = await served()
    t.equal("the Mac's served clave_list names no connection", servedRow?.account ?? null, null)
    t.equal('and says the same sentence', servedRow?.connectionLeft, LEFT)
    await countedAs(1, 1)

    // ── Back on the connection ──
    await control('kimi-coding')
    const back = await until(async () => ((await badge.count()) > 0 ? true : null), {
      tries: 60
    })
    t.check('back on its connection, the name comes back', !!back)
    t.equal('the sentence is gone', await headerLeft.count(), 0)
    t.equal(
      "clave_list names it again (window's road)",
      (await listed())?.account?.label,
      'Kimi work'
    )
    t.equal("and on the Mac's served road", (await served())?.account?.label, 'Kimi work')
    // The request that brought it back counts to the connection.
    await countedAs(2, 1)

    // ── A /login in the tab: the same provider, another credential ──
    const sentenceIs = async (expected) =>
      until(
        async () =>
          (await headerLeft.count()) > 0 && (await headerLeft.innerText()) === expected
            ? true
            : null,
        { tries: 60 }
      )
    await control('kimi-coding credential')
    t.check('a sign-in in the tab: the header names what changed', !!(await sentenceIs(LOGIN)))
    t.equal('the foot says the same', await footLeft.innerText(), LOGIN)
    t.equal("clave_list says the same (window's road)", (await listed())?.connectionLeft, LOGIN)
    t.equal("and on the Mac's served road", (await served())?.connectionLeft, LOGIN)
    // The sign-in's first request, on the same provider, counts to the sign-in.
    await countedAs(2, 2)

    // ── A credential Clave cannot check ──
    await control('kimi-coding unchecked')
    t.check('a credential not checked: the header says so', !!(await sentenceIs(UNCHECKED)))
    t.equal('clave_list says the same', (await listed())?.connectionLeft, UNCHECKED)
    t.equal('and names no connection', (await listed())?.account ?? null, null)
    await countedAs(2, 3)
    await control('kimi-coding')
    t.check(
      'back on it once more, the name comes back',
      !!(await until(async () => ((await badge.count()) > 0 ? true : null), { tries: 60 }))
    )
    await countedAs(3, 3)

    // ── Usage follows the report (PRDCT-4551): of the six requests, the
    // three made on the connection count to it; the three made off it (another
    // provider, another credential, a credential not checked) to Pi's own
    // sign-in, the sign-in road included ──
    const counted = await until(
      async () => {
        const v = await win.evaluate(() => window.electronAPI.harnessUsageRead({ range: 'today' }))
        const req = (id) =>
          v.rows.find((r) => r.harness === 'pi' && r.connectionId === id)?.requests ?? 0
        return req(kimiId) === 3 && req(null) === 3 ? v : null
      },
      { tries: 60 }
    )
    t.check(
      'a record written while the tab is off counts to the sign-in, one after its return to the connection',
      !!counted,
      counted ?? (await win.evaluate(() => window.electronAPI.harnessUsageRead({ range: 'today' })))
    )

    // ── 2. A Pi chat whose Pi moves to another provider before each run ──
    writeFileSync(MOVE_MARK, '')
    const chat = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'pi',
      chat: true,
      workspace: WS.id,
      account: 'Kimi work',
      name: 'Pi chat on Kimi'
    })
    const chatId = chat?.sessionId
    t.check('the Pi chat opened', !!chatId, chat)
    opened.push(chatId)
    await callMcp(app, 'focus', { sessionId: chatId })
    const view = win.locator(`.chat-host[data-session-id="${chatId}"] [data-testid="chat-view"]`)
    await view.first().waitFor({ timeout: 20_000 })
    await win.evaluate(
      async ({ id }) =>
        window.electronAPI.sessionsWrite(id, { type: 'user_message', text: 'hello moved' }),
      { id: chatId }
    )
    const text = async () =>
      view
        .first()
        .innerText()
        .catch(() => '')
    const ended = await until(async () => ((await text()).includes(CHAT_LEFT) ? true : null), {
      tries: 80
    })
    t.check(
      'the turn ends with one sentence naming where Pi was',
      !!ended,
      (await text()).slice(-600)
    )
    t.check('and nothing was answered', !(await text()).includes('You said: hello moved'))
    t.check('and no "put it back" is said', !/put it back/.test(await text()))

    // ── 3. A Pi chat whose Pi selects a virtual model listed under the
    // connection's provider before each run (the verifier's finding 1): the
    // router would send elsewhere, so nothing is sent ──
    rmSync(MOVE_MARK, { force: true })
    writeFileSync(VIRTUAL_MARK, '')
    const vchat = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'pi',
      chat: true,
      workspace: WS.id,
      account: 'Kimi work',
      name: 'Pi chat on Kimi, virtual'
    })
    const vchatId = vchat?.sessionId
    t.check('the second Pi chat opened', !!vchatId, vchat)
    opened.push(vchatId)
    await callMcp(app, 'focus', { sessionId: vchatId })
    const vview = win.locator(`.chat-host[data-session-id="${vchatId}"] [data-testid="chat-view"]`)
    await vview.first().waitFor({ timeout: 20_000 })
    await win.evaluate(
      async ({ id }) =>
        window.electronAPI.sessionsWrite(id, { type: 'user_message', text: 'hello virtual' }),
      { id: vchatId }
    )
    const vtext = async () =>
      vview
        .first()
        .innerText()
        .catch(() => '')
    const vended = await until(
      async () => ((await vtext()).includes(CHAT_UNCHECKED) ? true : null),
      { tries: 80 }
    )
    t.check(
      'a virtual model under the connection: the turn ends with the "could not check" sentence',
      !!vended,
      (await vtext()).slice(-600)
    )
    t.check('and nothing was answered', !(await vtext()).includes('You said: hello virtual'))
  } finally {
    for (const id of opened) await callMcp(app, 'closeSession', { sessionId: id }).catch(() => {})
    await app?.close()
  }
}

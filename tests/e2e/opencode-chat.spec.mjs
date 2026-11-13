// OpenCode opens in Clave's chat view through the ACP adapter (lane D,
// PRDCT-4427). `opencode` on the PATH is a shell script: `opencode acp` runs
// the stand-in ACP agent (tests/e2e/fixtures/acp-agent.mjs, which never calls
// a provider), `--version` prints a version, and anything else (the TUI,
// `opencode --session <id>`) records its argv and waits. An OpenCode chat
// answers one message with a tool card, its record keeps the OpenCode
// session the agent opened; the pane menu's « Terminal » restarts the SAME
// tab as an OpenCode terminal on that session (`--session <id>`), its record
// keeping the id; « Chat » on that terminal brings the same tab back into
// the chat on that session (`session/load`, its past shown); « Chat » on an
// OpenCode terminal that was never a chat is refused (nothing to carry); and
// an OpenCode chat comes back after a relaunch on the
// same user-data folder, its session loaded (`session/load`) and its past
// shown. Pinned to the in-process server like chat-terminal-switch: the stub
// is found on the PATH the app was launched with. tmux is off for the run.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  REPO,
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  openWindow,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('opencode-chat')
const ROOT = fixturePath('opencode-chat-root')
const STATE = path.join(ROOT, 'acp-state')
const FRAMES = path.join(STATE, 'frames.jsonl')
const TUI_ARGV = path.join(ROOT, 'tui-argv.jsonl')
const AGENT = path.join(REPO, 'tests/e2e/fixtures/acp-agent.mjs')
const WS = { id: 'opencode-ws', name: 'OpenCode', rootDir: ROOT, profileFile: null, createdAt: 1 }
const NO_CONVERSATION = 'This terminal has no conversation to carry into a chat yet.'

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

function writeFixtures() {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(`${ROOT}/bin`, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  writeFileSync(
    `${ROOT}/bin/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  writeFileSync(
    `${ROOT}/bin/opencode`,
    `#!/bin/sh
if [ "$1" = "acp" ]; then
  ACP_STAND_IN_STATE=${quote(STATE)}
  export ACP_STAND_IN_STATE
  exec ${quote(process.execPath)} ${quote(AGENT)} acp
fi
if [ "$1" = "--version" ]; then
  echo "opencode 2.3.0"
  exit 0
fi
${quote(process.execPath)} -e 'require("node:fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' ${quote(TUI_ARGV)} "$@"
echo "stub opencode terminal"
exec sleep 600
`,
    { mode: 0o755 }
  )
}

const lines = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

/** Every session record in a user-data folder that carries this tab's id. */
function recordsOf(userData, id) {
  const dir = path.join(userData, 'session-records')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')))
    .filter((record) => record.id === id)
}

export async function run(t) {
  writeFixtures()
  const env = {
    SHELL: `${ROOT}/bin/bash`,
    PATH: `${ROOT}/bin:${process.env.PATH}`
  }
  let app = null
  const errors = []
  try {
    let launched = await launchApp(DIR, {
      server: 'in-process',
      args: ['--test-no-machine-usage'],
      env
    })
    app = launched.app
    let win = launched.win
    win.on('pageerror', (e) => errors.push(e.message))
    await win.evaluate(() => window.electronAPI.preferencesSet('tmuxMode', false))
    await until(async () => {
      try {
        return await callMcp(app, 'list', {})
      } catch {
        return false
      }
    })
    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    const folders = [...new Set([userData, DIR])]
    const records = (id) => folders.flatMap((folder) => recordsOf(folder, id))
    const tile = (id) => win.locator(`[data-terminal-tile="${id}"]`)
    const pane = (id) => win.locator(`.chat-host[data-session-id="${id}"]`)
    const chat = (id) => pane(id).locator('[data-testid="chat-view"]').first()
    const isTerminalPane = async (id) =>
      (await pane(id).count()) === 0 && (await tile(id).locator('.xterm').count()) > 0
    const say = (id, text) =>
      win.evaluate(
        async ({ id, text }) =>
          window.electronAPI.sessionsWrite(id, { type: 'user_message', text }),
        { id, text }
      )

    // ── 1. An OpenCode chat opens in the chat view ──
    const opened = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'opencode',
      chat: true,
      name: 'OpenCode chat'
    })
    const id = opened.sessionId
    t.check('the OpenCode chat opened', !!id, opened)
    await callMcp(app, 'focus', { sessionId: id })
    await chat(id).waitFor({ timeout: 20_000 })
    const kernel = (await win.evaluate(() => window.electronAPI.sessionsList())).find(
      (s) => s.id === id
    )
    t.check(
      'the tab runs on the opencode-chat adapter, events transport',
      kernel?.adapterId === 'opencode-chat' &&
        kernel?.transport === 'events' &&
        kernel?.provider === 'opencode',
      kernel
    )
    const spawnedAcp = lines(FRAMES).some((f) => f.frame?.method === 'initialize')
    t.check('the agent was started as `opencode acp` and initialized', spawnedAcp)

    // ── 2. One message: the echo, a tool card, the chip ──
    await say(id, 'hello from the spec')
    await chat(id).getByText('You said: hello from the spec').waitFor({ timeout: 15_000 })
    t.check('the pane shows the agent’s answer', true)
    const toolCard = await until(
      async () => ((await chat(id).getByText('Read README.md').count()) > 0 ? true : null),
      { tries: 40 }
    )
    t.check('the pane shows the tool card', !!toolCard, (await chat(id).innerText()).slice(0, 600))
    const chipText = async () =>
      chat(id).locator('.chat-model-trigger[aria-label="Model"]').first().innerText()
    // The model by the name the agent gives it (`stand-in/One`, its provider
    // prefix off), the way the menu lists it (PRDCT-4427).
    const chipOk = await until(async () => (await chipText()) === 'OpenCode · One', { tries: 40 })
    t.check('the chip names the model the agent runs (OpenCode · One)', !!chipOk, await chipText())
    t.check(
      'a chat on no stored connection names none',
      (await pane(id).locator('[data-connection-chip]').count()) === 0
    )
    await chat(id).locator('.chat-model-trigger[aria-label="Model"]').first().click()
    const ownRow = win.locator('.chat-model-provider[data-adapter="opencode-chat"]')
    await ownRow.waitFor({ timeout: 5_000 })
    await ownRow.hover()
    const offered = await until(
      async () => {
        const rows = await win.locator('[aria-label="Models"] .chat-model-option').allInnerTexts()
        return rows.length >= 3 ? rows : null
      },
      { tries: 30 }
    )
    t.equal(
      'the chip’s menu lists the models the agent offers',
      JSON.stringify((offered ?? []).map((text) => text.trim())),
      JSON.stringify(['One', 'Two', 'Three'])
    )
    // Picking one switches: the agent is told, the chip follows.
    await win.locator('[aria-label="Models"] .chat-model-option', { hasText: 'Two' }).click()
    const switched = await until(
      () =>
        lines(FRAMES).find(
          (f) =>
            f.frame?.method === 'session/set_config_option' &&
            f.frame?.params?.configId === 'model' &&
            f.frame?.params?.value === 'stand-in/two'
        ) ?? null,
      { tries: 40 }
    )
    t.check('the pick reaches the agent (session/set_config_option stand-in/two)', !!switched)
    const followed = await until(async () => (await chipText()) === 'OpenCode · Two', {
      tries: 40
    })
    t.check('the chip follows the switch (OpenCode · Two)', !!followed, await chipText())
    await win.keyboard.press('Escape').catch(() => undefined)

    // ── 2b. A subscriber that comes after the session said its model ──
    // A second window subscribes to the chat the way a pane does, on its own
    // connection to the server: the agent named its model once, at its
    // handshake, long before. (The views of one pane all stay mounted, and a
    // chat off tmux cannot move windows, so this is the late subscriber the
    // app can make here.)
    const windowB = await openWindow(app, win, WS.id)
    const heard = await windowB.page.evaluate(async (id) => {
      const models = []
      const stop = window.electronAPI.onSessionStream(id, (stream) => {
        if (stream.kind === 'event' && stream.event.type === 'session_meta')
          models.push(stream.event.model)
      })
      await window.electronAPI.sessionsSubscribe(id)
      await new Promise((resolve) => setTimeout(resolve, 800))
      stop()
      await window.electronAPI.sessionsUnsubscribe(id)
      return models
    }, id)
    t.equal(
      'a subscriber that comes after the session is ready is told its model (stand-in/two)',
      JSON.stringify(heard),
      JSON.stringify(['stand-in/two'])
    )
    await windowB.page.close().catch(() => undefined)

    // ── 3. The record keeps the OpenCode session ──
    const chatRecord = await until(async () => records(id).find((r) => r.opencodeSessionId))
    const conversation = chatRecord?.opencodeSessionId
    t.check(
      'the record is an OpenCode chat’s, with its OpenCode session',
      chatRecord?.adapterId === 'opencode-chat' &&
        chatRecord?.transport === 'events' &&
        chatRecord?.opencodeMode === true &&
        chatRecord?.claudeMode === false &&
        typeof conversation === 'string' &&
        conversation.startsWith('ses_'),
      records(id)
    )

    // ── 4. « Terminal »: the same tab, an OpenCode terminal on that session ──
    await pane(id).getByLabel('Session menu', { exact: true }).click()
    const terminalTile = win.locator('.view-tile[data-transport="pty"]')
    await terminalTile.waitFor()
    await win.waitForTimeout(300)
    await terminalTile.click({ force: true })
    const becameTerminal = await until(() => isTerminalPane(id), { tries: 80 })
    t.check('the pane is now a terminal pane', !!becameTerminal)
    const tui = await until(() => (lines(TUI_ARGV).length ? lines(TUI_ARGV) : null), {
      tries: 80
    })
    t.check(
      'the terminal is `opencode --session <the chat’s session>`, once',
      tui?.length === 1 && tui[0][tui[0].indexOf('--session') + 1] === conversation,
      tui
    )
    const listed = (await callMcp(app, 'list', {})).sessions.find((s) => s.id === id)
    t.check('the tab keeps its id', !!listed, listed)

    // The terminal's record keeps the OpenCode session it resumed (verifier
    // round 1, Major 1): a Resume or a restore of the terminal resumes it.
    const terminalRecord = await until(async () =>
      records(id).find((r) => r.adapterId === 'pty' && r.opencodeSessionId === conversation)
    )
    t.check('the terminal’s record carries the OpenCode session', !!terminalRecord, records(id))

    // ── 5. « Chat » on that terminal: the same tab back in the chat, on the same session ──
    await win.keyboard.press('Escape')
    const chatTileOf = () =>
      win
        .locator('.view-tile[data-transport="events"]')
        .filter({ has: win.locator('.view-tile-name', { hasText: /^Chat$/ }) })
    const framesBeforeChat = lines(FRAMES).length
    await tile(id).getByLabel('Terminal session menu', { exact: true }).click()
    await chatTileOf().waitFor()
    await win.waitForTimeout(300)
    await chatTileOf().click({ force: true })
    await chat(id).waitFor({ timeout: 20_000 })
    t.check('the same tab is a chat again', (await pane(id).count()) === 1)
    const reloaded = await until(
      () =>
        lines(FRAMES)
          .slice(framesBeforeChat)
          .find(
            (f) => f.frame?.method === 'session/load' && f.frame?.params?.sessionId === conversation
          ) ?? null,
      { tries: 80 }
    )
    t.check(
      'the agent was asked to load the chat’s session (session/load)',
      !!reloaded,
      lines(FRAMES).slice(framesBeforeChat)
    )
    const history = await until(
      async () =>
        (await chat(id)
          .getByText('You said: hello from the spec')
          .count()
          .catch(() => 0)) > 0,
      { tries: 60 }
    )
    t.check(
      'the chat shows the conversation’s past',
      !!history,
      await chat(id)
        .innerText()
        .catch(() => '')
    )

    // ── 5b. « Chat » on a terminal that was never a chat: refused, the reason on the row ──
    const fresh = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'opencode',
      chat: false,
      name: 'OpenCode terminal'
    })
    const freshId = fresh.sessionId
    t.check('an OpenCode terminal opened', !!freshId, fresh)
    await callMcp(app, 'focus', { sessionId: freshId })
    const freshIsTerminal = await until(() => isTerminalPane(freshId), { tries: 80 })
    t.check('it is a terminal pane', !!freshIsTerminal)
    await tile(freshId).getByLabel('Terminal session menu', { exact: true }).click()
    await chatTileOf().waitFor()
    await win.waitForTimeout(300)
    await chatTileOf().click({ force: true })
    const refusal = await until(
      async () => {
        const text = await win
          .locator('.session-menu-failure')
          .innerText()
          .catch(() => '')
        return text.includes(NO_CONVERSATION) ? text : null
      },
      { tries: 60 }
    )
    t.check('the move into a chat is refused, the reason shown', !!refusal)
    t.check('the tab is still a terminal', await isTerminalPane(freshId))
    await win.keyboard.press('Escape')

    // ── 6. An OpenCode chat comes back after a relaunch ──
    const second = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'opencode',
      chat: true,
      name: 'OpenCode restored'
    })
    const restoredId = second.sessionId
    await callMcp(app, 'focus', { sessionId: restoredId })
    await chat(restoredId).waitFor({ timeout: 20_000 })
    await say(restoredId, 'before the relaunch')
    await chat(restoredId).getByText('You said: before the relaunch').waitFor({ timeout: 15_000 })
    const savedRecord = await until(async () =>
      records(restoredId).find((r) => r.opencodeSessionId)
    )
    const savedSession = savedRecord?.opencodeSessionId
    t.check('the second chat has its OpenCode session on its record', !!savedSession, savedRecord)

    await app.close()
    app = null
    const framesBefore = lines(FRAMES).length
    launched = await launchApp(DIR, {
      server: 'in-process',
      args: ['--test-no-machine-usage'],
      env,
      settleMs: 3000
    })
    app = launched.app
    win = launched.win
    win.on('pageerror', (e) => errors.push(e.message))
    const back = await until(async () =>
      (await callMcp(app, 'list', {})).sessions.find((s) => s.id === restoredId)
    )
    t.check('the OpenCode chat is back under its own id', !!back, back)
    await callMcp(app, 'focus', { sessionId: restoredId })
    const restoredKernel = await until(async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).find((s) => s.id === restoredId)
    )
    t.check(
      'it is an opencode-chat events session again',
      restoredKernel?.adapterId === 'opencode-chat' && restoredKernel?.transport === 'events',
      restoredKernel
    )
    const load = await until(
      () =>
        lines(FRAMES)
          .slice(framesBefore)
          .find(
            (f) => f.frame?.method === 'session/load' && f.frame?.params?.sessionId === savedSession
          ) ?? null,
      { tries: 80 }
    )
    t.check(
      'the agent was asked to load the saved session',
      !!load,
      lines(FRAMES).slice(framesBefore)
    )
    const shown = await until(
      async () =>
        (await chat(restoredId)
          .getByText('You said: before the relaunch')
          .count()
          .catch(() => 0)) > 0,
      { tries: 60 }
    )
    t.check(
      'the pane shows the conversation’s past',
      !!shown,
      await chat(restoredId)
        .innerText()
        .catch(() => '')
    )
    t.check('no renderer error during the run', errors.length === 0, errors)
  } finally {
    if (app) await app.close()
  }
}

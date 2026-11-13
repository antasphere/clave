// Pi opens in Clave's chat view through the Pi rpc adapter (lane D,
// PRDCT-4427). `pi` on the PATH is a shell script: `pi … --mode rpc` runs the
// stand-in Pi (tests/e2e/fixtures/pi-rpc-agent.mjs, which never calls a
// provider), `--version` prints a version, and anything else (the TUI,
// `pi --session <id>`) records its argv and waits. A Pi chat answers one
// message with a tool card; its record keeps the Pi session id, Clave's own;
// the pane menu's « Terminal » restarts the SAME tab as a Pi terminal on that
// session (`--session <id>`); « Chat » on that terminal brings it back into
// the chat on the same session, its past shown (the stand-in wrote the
// session's file where Pi keeps it, so the chat resumes); and the Pi chat
// comes back after a relaunch on the same user-data folder, its history
// shown. Pi's home is `PI_CODING_AGENT_DIR` under the fixture root, and the
// stand-in keeps its sessions in that home's folder for the root, the one
// Pi itself would use. Pinned to the in-process server like
// chat-terminal-switch: the stub is found on the PATH the app was launched
// with. tmux is off for the run.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  REPO,
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('pi-chat')
const ROOT = fixturePath('pi-chat-root')
const PI_HOME = path.join(ROOT, 'pi-agent')
// Pi's own folder for a working directory's sessions (session-history/pi.ts,
// piSessionDir): the cwd without its leading slash, every / \ : turned into -.
const STATE = path.join(
  PI_HOME,
  'sessions',
  `--${ROOT.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
)
const FRAMES = path.join(STATE, 'frames.jsonl')
const TUI_ARGV = path.join(ROOT, 'tui-argv.jsonl')
const AGENT = path.join(REPO, 'tests/e2e/fixtures/pi-rpc-agent.mjs')
const WS = { id: 'pi-ws', name: 'Pi', rootDir: ROOT, profileFile: null, createdAt: 1 }

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
    `${ROOT}/bin/pi`,
    `#!/bin/sh
case " $* " in
  *" --mode rpc "*)
    PI_STAND_IN_STATE=${quote(STATE)}
    export PI_STAND_IN_STATE
    exec ${quote(process.execPath)} ${quote(AGENT)} "$@"
    ;;
esac
if [ "$1" = "--version" ]; then
  echo "1.5.2"
  exit 0
fi
${quote(process.execPath)} -e 'require("node:fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' ${quote(TUI_ARGV)} "$@"
echo "stub pi terminal"
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
    PATH: `${ROOT}/bin:${process.env.PATH}`,
    PI_CODING_AGENT_DIR: PI_HOME
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
    const chatText = async (id) =>
      chat(id)
        .innerText()
        .catch(() => '')

    // ── 1. A Pi chat opens in the chat view ──
    const opened = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'pi',
      chat: true,
      name: 'Pi chat'
    })
    const id = opened.sessionId
    t.check('the Pi chat opened', !!id, opened)
    await callMcp(app, 'focus', { sessionId: id })
    await chat(id).waitFor({ timeout: 20_000 })
    const kernel = (await win.evaluate(() => window.electronAPI.sessionsList())).find(
      (s) => s.id === id
    )
    t.check(
      'the tab runs on the pi-chat adapter, events transport',
      kernel?.adapterId === 'pi-chat' &&
        kernel?.transport === 'events' &&
        kernel?.provider === 'pi',
      kernel
    )
    const handshake = await until(
      () => (lines(FRAMES).some((f) => f.frame?.type === 'get_state') ? true : null),
      { tries: 60 }
    )
    t.check('the stand-in was started in rpc mode and asked its state', !!handshake)

    // ── 2. One message: the echo, a tool card, the chip ──
    await say(id, 'hello from the spec')
    await chat(id).getByText('You said: hello from the spec').waitFor({ timeout: 15_000 })
    t.check('the pane shows the agent’s answer', true)
    const toolCard = await until(
      async () => {
        const rows = await chat(id).locator('.chat-tool-row').allInnerTexts()
        return rows.some((row) => /read/i.test(row)) ? rows : null
      },
      { tries: 40 }
    )
    t.check('the pane shows the read tool card', !!toolCard, (await chatText(id)).slice(0, 600))
    console.log(`      tool rows: ${JSON.stringify(toolCard)}`)
    const chipText = async () =>
      chat(id).locator('.chat-model-trigger[aria-label="Model"]').first().innerText()
    const chipOk = await until(async () => /stand-in\/one/.test(await chipText()), { tries: 40 })
    t.check('the chip reads the model Pi runs (stand-in/one)', !!chipOk, await chipText())
    console.log(`      chip reads: ${JSON.stringify(await chipText())}`)

    // ── 3. The record keeps the Pi session, Clave's own id ──
    const chatRecord = await until(async () => records(id).find((r) => r.piSessionId))
    const conversation = chatRecord?.piSessionId
    t.check(
      'the record is a Pi chat’s, with its Pi session',
      chatRecord?.adapterId === 'pi-chat' &&
        chatRecord?.transport === 'events' &&
        chatRecord?.piMode === true &&
        chatRecord?.claudeMode === false &&
        typeof conversation === 'string' &&
        conversation.length > 0,
      records(id)
    )
    const sessionFile = existsSync(STATE)
      ? readdirSync(STATE).find((name) => name.endsWith(`_${conversation}.jsonl`))
      : undefined
    t.check('the stand-in wrote the session where Pi keeps it', !!sessionFile, STATE)

    // ── 4. « Terminal »: the same tab, a Pi terminal on that session ──
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
      'the terminal is `pi --session <the chat’s session>`, once',
      tui?.length === 1 && tui[0][tui[0].indexOf('--session') + 1] === conversation,
      tui
    )
    const listed = (await callMcp(app, 'list', {})).sessions.find((s) => s.id === id)
    t.check('the tab keeps its id', !!listed, listed)

    // ── 5. « Chat » on that terminal: the same id back in the chat, its past shown ──
    await win.keyboard.press('Escape')
    await tile(id).getByLabel('Terminal session menu', { exact: true }).click()
    const chatTile = win
      .locator('.view-tile[data-transport="events"]')
      .filter({ has: win.locator('.view-tile-name', { hasText: /^Chat$/ }) })
    await chatTile.waitFor()
    await win.waitForTimeout(300)
    await chatTile.click({ force: true })
    await chat(id).waitFor({ timeout: 20_000 })
    t.check('the pane is the chat view again', (await pane(id).count()) === 1)
    const replayed = await until(
      async () => {
        const text = await chatText(id)
        return /hello from the spec/.test(text) && /You said:/.test(text) ? text : null
      },
      { tries: 60 }
    )
    t.check(
      'the conversation shows the message and the answer, resumed from Pi’s session',
      !!replayed,
      (await chatText(id)).slice(0, 600)
    )
    const backRecord = await until(async () => {
      const found = records(id)
      return found.length === 1 && found[0].adapterId === 'pi-chat' ? found[0] : null
    })
    t.check(
      'the record is a Pi chat record under the same id, on the same Pi session',
      backRecord?.piSessionId === conversation && backRecord?.piMode === true,
      records(id)
    )

    // ── 6. The Pi chat comes back after a relaunch, its history shown ──
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
      (await callMcp(app, 'list', {})).sessions.find((s) => s.id === id)
    )
    t.check('the Pi chat is back under its own id', !!back, back)
    await callMcp(app, 'focus', { sessionId: id })
    const restoredKernel = await until(async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).find((s) => s.id === id)
    )
    t.check(
      'it is a pi-chat events session again',
      restoredKernel?.adapterId === 'pi-chat' && restoredKernel?.transport === 'events',
      restoredKernel
    )
    const asked = await until(
      () =>
        lines(FRAMES)
          .slice(framesBefore)
          .find((f) => f.frame?.type === 'get_messages') ?? null,
      { tries: 80 }
    )
    t.check('Pi was asked for the resumed conversation', !!asked, lines(FRAMES).slice(framesBefore))
    const shown = await until(
      async () => {
        const text = await chatText(id)
        return /hello from the spec/.test(text) && /You said:/.test(text) ? true : null
      },
      { tries: 60 }
    )
    t.check('the pane shows the conversation’s past', !!shown, (await chatText(id)).slice(0, 600))
    t.check('no renderer error during the run', errors.length === 0, errors)
  } finally {
    if (app) await app.close()
  }
}

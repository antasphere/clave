// A tab opens a tab of another harness (PRDCT-4507). The tester's pass: an
// OpenCode chat asked to open an OpenCode tab called `clave_open_session`,
// each call answered "OpenCode exchange capture is unsupported" while the tab
// opened anyway with no parent, and the model retried: ten stray tabs.
//
// Real hidden Electron, the real in-process tool server, and the stand-in
// harnesses calling it with what their tab was handed
// (tests/e2e/fixtures/clave-tools-call.mjs): a prompt `clave-open {…}` makes
// the stand-in model call `clave_open_session` once with those arguments.
//
// What it proves: an OpenCode chat opens an OpenCode tab and a Pi tab, and a
// Pi chat opens an OpenCode tab; each call is answered the new tab's id with
// no error, exactly one tab exists per call, and `clave_list` names its
// caller as its parentId. Three passes: in process with a saved Clave server
// (the fleet's road through the window, where the tester met the error), in
// process alone, and on the app's own separate server. No provider is
// called; tmux off.
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
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('open-between-harnesses')
const ROOT = fixturePath('open-between-harnesses-root')
const BIN = path.join(ROOT, 'bin')
const LOG = path.join(ROOT, 'clave-tools.jsonl')
const PI_HOME = path.join(ROOT, 'pi-agent')
const PI_STATE = path.join(ROOT, 'pi-state')
const ACP_STATE = path.join(ROOT, 'acp-state')
const PI_AGENT = path.join(REPO, 'tests/e2e/fixtures/pi-rpc-agent.mjs')
const ACP_AGENT = path.join(REPO, 'tests/e2e/fixtures/acp-agent.mjs')
const WS = { id: 'open-ws', name: 'Opens', rootDir: ROOT, profileFile: null, createdAt: 1 }

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

function writeFixtures() {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  mkdirSync(PI_HOME, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  writeFileSync(
    path.join(BIN, 'bash'),
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  writeFileSync(
    path.join(BIN, 'pi'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "1.5.2"; exit 0; fi
PI_STAND_IN_STATE=${quote(PI_STATE)}
export PI_STAND_IN_STATE
exec ${quote(process.execPath)} ${quote(PI_AGENT)} "$@"
`,
    { mode: 0o755 }
  )
  writeFileSync(
    path.join(BIN, 'opencode'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.3.0"; exit 0; fi
ACP_STAND_IN_STATE=${quote(ACP_STATE)}
export ACP_STAND_IN_STATE
exec ${quote(process.execPath)} ${quote(ACP_AGENT)} acp
`,
    { mode: 0o755 }
  )
}

const records = () =>
  existsSync(LOG)
    ? readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

// In process, and on the app's own separate server (the packaged default, the
// tester's trial): the tab's call can take another road there.
// With a saved Clave server, as on the tester's Mac, an open and a listing
// take the window's road (the fleet's merged inventory): where the error was.
export async function run(t) {
  for (const [server, saved] of [
    ['in-process', true],
    ['in-process', false],
    ['separate', false]
  ]) {
    const named = (name) => `(${server}${saved ? ', a saved server' : ''}) ${name}`
    await pass(
      {
        check: (name, ...rest) => t.check(named(name), ...rest),
        equal: (name, ...rest) => t.equal(named(name), ...rest)
      },
      server,
      saved
    )
  }
}

async function pass(t, server, saved) {
  writeFixtures()
  const env = {
    SHELL: path.join(BIN, 'bash'),
    PATH: `${BIN}:${process.env.PATH}`,
    PI_CODING_AGENT_DIR: PI_HOME,
    CLAVE_TOOLS_STAND_IN_LOG: LOG
  }
  let app = null
  const errors = []
  try {
    const launched = await launchApp(DIR, {
      server,
      args: ['--test-no-machine-usage'],
      env
    })
    app = launched.app
    const win = launched.win
    win.on('pageerror', (e) => errors.push(e.message))
    await win.evaluate(() => window.electronAPI.preferencesSet('tmuxMode', false))
    await until(async () => {
      try {
        return await callMcp(app, 'list', {})
      } catch {
        return false
      }
    })
    if (saved) {
      // A saved server that is not running: enough for the fleet's road.
      await win.evaluate(() =>
        window.electronAPI.fleetSave({
          name: 'Made-up server',
          url: 'http://127.0.0.1:9',
          token: 'e2e-made-up-token'
        })
      )
      t.check(
        'the saved server is listed',
        (await win.evaluate(() => window.electronAPI.fleetList())).length === 1
      )
    }
    const listed = async () => (await callMcp(app, 'list', {}))?.sessions ?? []

    /** A caller chat, opened from outside, whose stand-in has reached
     *  Clave's tools as itself. */
    const caller = async (name, mode) => {
      const opened = await callMcp(app, 'openSession', { cwd: ROOT, mode, chat: true, name })
      const id = opened?.sessionId
      t.check(`${name}: opened`, !!id, opened)
      await callMcp(app, 'focus', { sessionId: id })
      const ready = await until(
        () => records().find((r) => r.kind !== 'tool' && r.callerSessionId === id) ?? null,
        { tries: 80 }
      )
      t.check(`${name}: its stand-in reached Clave's tools as itself`, !!ready, records())
      return id
    }

    /** The caller's model calls clave_open_session once; the answer, and the
     *  tabs named `name` a few seconds later. */
    const openFrom = async (callerId, mode, name) => {
      const before = records().filter((r) => r.kind === 'tool').length
      const args = { cwd: ROOT, mode, chat: true, name }
      await win.evaluate(
        ({ id, text }) => window.electronAPI.sessionsWrite(id, { type: 'user_message', text }),
        { id: callerId, text: `clave-open ${JSON.stringify(args)}` }
      )
      const answer = await until(
        () =>
          records()
            .filter((r) => r.kind === 'tool')
            .slice(before)
            .find((r) => r.args?.name === name) ?? null,
        { tries: 80 }
      )
      // Long enough for a stray retry or a second tab to show.
      await new Promise((resolve) => setTimeout(resolve, 2500))
      const tabs = (await listed()).filter((s) => s.name === name)
      return { answer, tabs }
    }

    const ocCaller = await caller('OpenCode caller', 'opencode')
    const piCaller = await caller('Pi caller', 'pi')

    for (const [callerName, callerId, mode, name] of [
      ['an OpenCode chat', ocCaller, 'opencode', 'oc-from-oc'],
      ['an OpenCode chat', ocCaller, 'pi', 'pi-from-oc'],
      ['a Pi chat', piCaller, 'opencode', 'oc-from-pi']
    ]) {
      const { answer, tabs } = await openFrom(callerId, mode, name)
      const id = answer?.payload?.sessionId
      t.check(
        `${callerName} opens a ${mode} tab: answered its id, no error`,
        answer?.ok === true && typeof id === 'string' && id.length > 0,
        answer
      )
      t.equal(`${callerName} opens a ${mode} tab: exactly one tab exists`, tabs.length, 1)
      t.equal(
        `${callerName} opens a ${mode} tab: the answered id is that tab`,
        tabs[0]?.id ?? null,
        id ?? null
      )
      t.equal(
        `${callerName} opens a ${mode} tab: clave_list names the caller as its parent`,
        tabs[0]?.parentId ?? null,
        callerId
      )
    }
    t.check('no renderer error during the run', errors.length === 0, errors)
  } finally {
    await app?.close()
  }
}

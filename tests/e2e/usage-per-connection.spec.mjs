// Usage is counted per connection for every harness (PRDCT-4551). Two stored
// connections of ONE provider (Moonshot's coding plan: Kimi A and Kimi B), a
// Pi chat on A, an OpenCode chat on B, and a Pi and an OpenCode chat on no
// connection. `pi` and `opencode` on the PATH are lane D's stand-ins
// (tests/e2e/fixtures/pi-rpc-agent.mjs, acp-agent.mjs), which leave usage
// records as the real programs do: Pi on each assistant message of its
// session file, OpenCode per message, read back through `opencode api` and
// `opencode session export`. They never call a provider.
//
// What it proves: each connection shows its own tabs' usage and not the
// other's, in the launcher's connection row, at the sidebar's foot for the
// focused tab and in `clave_launch_options`; a plan connection shows no cost;
// a tab on no connection shows under the harness's own sign-in.
//
// Fails if: a record is counted to the other connection of the provider, to
// both, or to none; the foot shows Pi's total of every session; OpenCode's
// records are not read; a plan connection says a dollar figure.
//
// Every value is made up. Pinned to the in-process server; tmux off.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
  markHarnessesInstalled
} from './harness.mjs'

const DIR = userDataDir('usage-per-connection')
const ROOT = fixturePath('usage-per-connection-root')
const PI_HOME = path.join(ROOT, 'pi-agent')
const ACP_STATE = path.join(ROOT, 'acp-state')
const ACP_AGENT = path.join(REPO, 'tests/e2e/fixtures/acp-agent.mjs')
const PI_AGENT = path.join(REPO, 'tests/e2e/fixtures/pi-rpc-agent.mjs')
const WS = { id: 'usage-conn-ws', name: 'Usage', rootDir: ROOT, profileFile: null, createdAt: 1 }
const PI_CWD_FOLDER = `--${ROOT.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
const KIMI_A = 'e2e-made-up-usage-kimi-a-0001'
const KIMI_B = 'e2e-made-up-usage-kimi-b-0001'

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
  // The person's Pi home has a sessions folder: a connection's directory
  // links it, so every Pi session lands in one place, as on a real Mac.
  mkdirSync(path.join(PI_HOME, 'sessions'), { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  writeFileSync(path.join(DIR, 'models-catalog.json'), JSON.stringify(CATALOGUE))
  seedTrustedRoots(DIR, [ROOT])
  writeFileSync(
    `${ROOT}/bin/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  // OpenCode: the chat's agent, and the two reads Clave makes of its records.
  writeFileSync(
    `${ROOT}/bin/opencode`,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "opencode 2.3.0"; exit 0; fi
ACP_STAND_IN_STATE=${quote(ACP_STATE)}
export ACP_STAND_IN_STATE
case "$1" in
  acp|api|session) exec ${quote(process.execPath)} ${quote(ACP_AGENT)} "$@" ;;
esac
echo "stub opencode terminal"
exec sleep 600
`,
    { mode: 0o755 }
  )
  writeFileSync(
    `${ROOT}/bin/pi`,
    `#!/bin/sh
case " $* " in
  *" --mode rpc "*)
    PI_STAND_IN_STATE="\${PI_CODING_AGENT_DIR}/sessions/${PI_CWD_FOLDER}"
    PI_STAND_IN_ANY_PROVIDER=1
    export PI_STAND_IN_STATE PI_STAND_IN_ANY_PROVIDER
    exec ${quote(process.execPath)} ${quote(PI_AGENT)} "$@"
    ;;
esac
if [ "$1" = "--version" ]; then echo "1.5.2"; exit 0; fi
echo "stub pi terminal"
exec sleep 600
`,
    { mode: 0o755 }
  )
}

/** What a stand-in OpenCode turn on `text` uses: input 100 + its length,
 *  output its echo (`You said: ` + text), 20 read from cache. */
const opencodeTokens = (text) => 100 + text.length + ('You said: '.length + text.length) + 20

export async function run(t) {
  writeFixtures()
  const env = {
    SHELL: `${ROOT}/bin/bash`,
    PATH: `${ROOT}/bin:${process.env.PATH}`,
    PI_CODING_AGENT_DIR: PI_HOME,
    // Under test, Clave reads only the folders and the stand-in a spec names.
    CLAVE_PI_ROOT: path.join(PI_HOME, 'sessions'),
    CLAVE_E2E_OPENCODE_USAGE: '1'
  }
  let app = null
  const errors = []
  try {
    const launched = await launchApp(DIR, {
      server: 'in-process',
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
    const chat = (id) =>
      win
        .locator(`.chat-host[data-session-id="${id}"]`)
        .locator('[data-testid="chat-view"]')
        .first()
    const chatText = async (id) =>
      chat(id)
        .innerText()
        .catch(() => '')

    // ── Two connections of one provider, stored the way Settings stores them ──
    const C = await win.evaluate(
      async ({ a, b }) => {
        const api = window.electronAPI
        const add = async (label, key) => {
          const created = await api.providerConnectionAdd({ company: 'moonshot', label })
          return (await api.providerConnectionSetKey(created.id, key)).id
        }
        return { a: await add('Kimi A', a), b: await add('Kimi B', b) }
      },
      { a: KIMI_A, b: KIMI_B }
    )
    t.check('two Moonshot connections are stored', !!C.a && !!C.b && C.a !== C.b, C)

    /** Open a chat on the agent's road, focus it (its pane binds the turn's
     *  state), say each prompt and wait for each echo. */
    const chatOn = async (name, mode, account, prompts) => {
      const opened = await callMcp(app, 'openSession', {
        cwd: ROOT,
        mode,
        chat: true,
        workspace: WS.id,
        ...(account ? { account } : {}),
        // The connection's own model: what the stand-ins then name as the
        // provider's (Pi's `kimi-coding`, OpenCode's `kimi-code-plan-global`).
        ...(account ? { model: 'k-first' } : {}),
        name
      }).catch((e) => ({ error: String(e?.message ?? e) }))
      const id = opened?.sessionId
      t.check(`${name}: opened`, !!id, opened)
      if (!id) return null
      await callMcp(app, 'focus', { sessionId: id })
      await chat(id).waitFor({ timeout: 20_000 })
      for (const text of prompts) {
        await until(
          async () =>
            (await win
              .evaluate(
                ({ id, text }) =>
                  window.electronAPI.sessionsWrite(id, { type: 'user_message', text }),
                { id, text }
              )
              .then(() => true)
              .catch(() => null)) ?? null,
          { tries: 40 }
        )
        const echoed = await until(
          async () => ((await chatText(id)).includes(`You said: ${text}`) ? true : null),
          { tries: 80 }
        )
        t.check(`${name}: answered "${text}"`, !!echoed, (await chatText(id)).slice(-300))
      }
      return id
    }

    const piA = await chatOn('Pi on Kimi A', 'pi', 'Kimi A', ['first a', 'second a'])
    const ocB = await chatOn('OpenCode on Kimi B', 'opencode', 'Kimi B', ['hello b'])
    const piOwn = await chatOn('Pi on its own sign-in', 'pi', null, ['own pi'])
    const ocOwn = await chatOn('OpenCode on its own sign-in', 'opencode', null, ['own oc'])

    // ── The answer the host gives (the source every place reads) ──
    // A stand-in Pi turn is two model calls (a tool call, then the answer),
    // each its own record of 130 tokens, as real Pi writes one per call; a
    // stand-in OpenCode turn is one.
    const view = await until(
      async () => {
        const v = await win.evaluate(() => window.electronAPI.harnessUsageRead({ range: 'today' }))
        const req = (harness, id) =>
          v.rows.find((r) => r.harness === harness && r.connectionId === id)?.requests ?? 0
        return req('pi', C.a) === 4 &&
          req('opencode', C.b) === 1 &&
          req('pi', null) === 2 &&
          req('opencode', null) === 1
          ? v
          : null
      },
      { tries: 80 }
    )
    t.check('the host counts each record to the connection its tab ran on', !!view, view)
    const rowOf = (harness, id) =>
      view?.rows.find((r) => r.harness === harness && r.connectionId === id)
    t.check(
      'Kimi A has its Pi tab and none of Kimi B’s OpenCode tab',
      rowOf('pi', C.a)?.totalTokens === 520 && (rowOf('opencode', C.a)?.requests ?? 0) === 0,
      { pi: rowOf('pi', C.a), oc: rowOf('opencode', C.a) }
    )
    t.check(
      'Kimi B has its OpenCode tab and none of Kimi A’s Pi tab',
      rowOf('opencode', C.b)?.totalTokens === opencodeTokens('hello b') &&
        (rowOf('pi', C.b)?.requests ?? 0) === 0,
      { pi: rowOf('pi', C.b), oc: rowOf('opencode', C.b) }
    )
    t.equal('a Moonshot connection is billed as a plan', rowOf('pi', C.a)?.billing, 'plan')

    const LINE_A = '4 requests · 520 tokens today'
    const LINE_B = `1 request · ${opencodeTokens('hello b')} tokens today`
    const LINE_PI_OWN = '260 tokens · $0.00 today'
    const LINE_OC_OWN = `${opencodeTokens('own oc')} tokens · $0.00 today`

    // ── The sidebar's foot, for the focused tab ──
    const foot = win.locator('.sidebar-footer-line[data-connection-usage]')
    const footOf = async (id, expected) => {
      await callMcp(app, 'focus', { sessionId: id })
      const shown = await until(
        async () => {
          const text = (await foot.innerText().catch(() => '')).trim()
          return text === expected ? text : null
        },
        { tries: 80 }
      )
      return shown ?? (await foot.innerText().catch((e) => `(${e.message})`))
    }
    t.equal(
      'the foot of the Pi tab on Kimi A says Kimi A’s today',
      await footOf(piA, LINE_A),
      LINE_A
    )
    t.equal(
      'the foot of the OpenCode tab on Kimi B says Kimi B’s today',
      await footOf(ocB, LINE_B),
      LINE_B
    )
    t.equal(
      'the foot of a Pi tab on no connection says Pi’s own sign-in’s today',
      await footOf(piOwn, LINE_PI_OWN),
      LINE_PI_OWN
    )
    t.equal(
      'the foot of an OpenCode tab on no connection says OpenCode’s own sign-in’s today',
      await footOf(ocOwn, LINE_OC_OWN),
      LINE_OC_OWN
    )
    t.check(
      'no foot says a cost for a plan connection',
      !LINE_A.includes('$') && !LINE_B.includes('$')
    )

    // ── The launcher: each connection's row, its own line ──
    await markHarnessesInstalled(win)
    const rowLines = async (harness) => {
      for (let i = 0; i < 10; i++) {
        await win.keyboard.press('Escape')
        await until(async () => (await win.locator('[role="menu"]').count()) === 0, {
          tries: 30,
          gapMs: 100
        })
        await win.locator('.launcher-caret:not([disabled])').waitFor()
        await win.click('.launcher-caret')
        const row = win.locator(`[data-harness-row="${harness}"]`).first()
        if (
          !(await row.waitFor({ timeout: 1_500 }).then(
            () => true,
            () => false
          ))
        )
          continue
        await row.hover()
        const models = win.locator('[role="menu"]').nth(1)
        const model = models.locator('[data-harness-model="k-first"]').first()
        if (
          !(await model.waitFor({ timeout: 3_000 }).then(
            () => true,
            () => false
          ))
        )
          continue
        await model.hover()
        const connections = win.locator('[role="menu"]').nth(2)
        const read = await until(
          async () => {
            const a = await connections
              .locator(`[data-connection-usage="${C.a}"]`)
              .innerText()
              .catch(() => null)
            const b = await connections
              .locator(`[data-connection-usage="${C.b}"]`)
              .innerText()
              .catch(() => null)
            return a === LINE_A && b === LINE_B ? { a, b } : null
          },
          { tries: 40 }
        )
        if (read) return read
        return {
          a: await connections
            .locator(`[data-connection-usage="${C.a}"]`)
            .innerText()
            .catch((e) => e.message),
          b: await connections
            .locator(`[data-connection-usage="${C.b}"]`)
            .innerText()
            .catch((e) => e.message)
        }
      }
      return null
    }
    for (const harness of ['pi', 'opencode']) {
      const lines = await rowLines(harness)
      t.equal(`the launcher's ${harness} row of Kimi A says Kimi A's own`, lines?.a, LINE_A)
      t.equal(`the launcher's ${harness} row of Kimi B says Kimi B's own`, lines?.b, LINE_B)
    }
    await win.keyboard.press('Escape')

    // ── clave_launch_options: what an agent reads is what a person sees ──
    const options = await callMcp(app, 'launchOptions', {})
    const harness = (id) => options?.harnesses?.find((h) => h.id === id)
    for (const id of ['pi', 'opencode']) {
      const conn = (cid) => harness(id)?.connections?.find((c) => c.id === cid)
      t.equal(`clave_launch_options: ${id}'s Kimi A`, conn(C.a)?.usedToday?.line, LINE_A)
      t.equal(`clave_launch_options: ${id}'s Kimi B`, conn(C.b)?.usedToday?.line, LINE_B)
      t.equal(`clave_launch_options: ${id}'s plan says no cost`, conn(C.a)?.usedToday?.cost, null)
    }
    t.equal(
      "clave_launch_options: Pi's own sign-in",
      harness('pi')?.signInUsedToday?.line,
      LINE_PI_OWN
    )
    t.equal(
      "clave_launch_options: OpenCode's own sign-in",
      harness('opencode')?.signInUsedToday?.line,
      LINE_OC_OWN
    )
    t.check('no renderer error during the run', errors.length === 0, errors)
  } finally {
    if (app) await app.close()
  }
}

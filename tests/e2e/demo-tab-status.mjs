// A live demo of the sidebar tab status (PRDCT-2940): one tab per behaviour,
// driven by fake CLIs so nothing calls a model. Run from the repo after
// `npx electron-vite build`:  node tests/e2e/demo-tab-status.mjs
// It opens its own window on an isolated data folder and stays up until that
// window is closed.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('tab-status-demo')
const ROOT = fixturePath('tab-status-demo-root')
const WS = {
  id: 'demo-ws',
  name: 'Tab status demo',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(`${ROOT}/bin`, { recursive: true })

// Codex stand-in: every stdin line becomes the terminal title Clave reads.
writeFileSync(
  `${ROOT}/codex.py`,
  `import sys
def title(v):
    sys.stdout.write('\\x1b]0;' + v + '\\x07'); sys.stdout.flush()
title('codex | Ready')
print('A stand-in for Codex: the demo drives this tab through its title.', flush=True)
for line in sys.stdin:
    v = line.strip()
    if v == 'exit': break
    title(v)
`
)

// Claude chat stand-in: a turn that leaves two background tasks running for a
// minute, then reports them finished — the counter appears, then goes.
writeFileSync(
  `${ROOT}/bin/claude`,
  `#!${process.execPath}
const readline = require('node:readline')
if (!process.argv.includes('--session-id')) { process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('demo title\\n'); process.exit(0) }); return }
const argv = process.argv.slice(2); const sid = argv[argv.indexOf('--session-id') + 1]
const emit = (f) => process.stdout.write(JSON.stringify({ session_id: sid, ...f }) + '\\n')
const tasks = [
  { task_id: 'bdemo1', task_type: 'local_bash', description: 'npm run dev' },
  { task_id: 'adem02', task_type: 'local_agent', description: 'verifier' }
]
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line)
  if (input.type === 'control_request' && input.request.subtype === 'initialize')
    emit({ type: 'control_response', response: { subtype: 'success', request_id: input.request_id, response: { models: [{ value: 'fable', displayName: 'Fable' }] } } })
  else if (input.type === 'control_request')
    emit({ type: 'control_response', response: { subtype: 'success', request_id: input.request_id } })
  if (input.type !== 'user') return
  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), model: 'fable', tools: [], mcp_servers: [], permissionMode: 'default' })
  setTimeout(() => {
    emit({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_demo', type: 'message', role: 'assistant', model: 'fable', content: [{ type: 'text', text: 'I started a dev server and a verifier in the background. They finish in about a minute; watch the counter on this tab.' }] } })
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks })
    for (const t of tasks) emit({ type: 'system', subtype: 'task_started', task_id: t.task_id, description: t.description, task_type: t.task_type, is_backgrounded: true })
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'Started.', num_turns: 1 })
  }, 2500)
  setTimeout(() => {
    for (const t of tasks) {
      emit({ type: 'system', subtype: 'task_updated', task_id: t.task_id, patch: { status: 'completed' } })
      emit({ type: 'system', subtype: 'task_notification', task_id: t.task_id, status: 'completed' })
    }
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
  }, 62_000)
})
setInterval(() => {}, 1000)
`,
  { mode: 0o755 }
)
// The login-shell probe must keep the stub-first PATH (same trick as the e2e specs).
writeFileSync(
  `${ROOT}/bin/bash`,
  '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
  { mode: 0o755 }
)
writeFileSync(
  `${ROOT}/legend.txt`,
  `Tab status demo (PRDCT-2940). Each tab on the left shows one behaviour:

  Working ............... grey logo inside a spinning ring
  Needs you ............. amber logo (a permission or a question waits)
  New to read ........... blue logo: a turn ended while you were here;
                          click it and it goes back to grey
  Idle .................. grey logo
  Cycles ................ goes working -> needs you -> working -> done, every ~16s
                          (it lands blue each time because you are not on it)
  Message from a tab .... blue logo: another tab wrote to it; click to clear
  Ended ................. dimmed logo (its process exited)
  Chat · background ..... finished chat turn with 2 tasks still running:
                          the counter on the right, then gone after ~60s;
                          its account is at its limit: the warning icon,
                          hover it for the account card

Close this window to end the demo.
`
)

seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
seedTrustedRoots(DIR, [ROOT])
const { app, win } = await launchApp(DIR, {
  env: { SHELL: `${ROOT}/bin/bash`, PATH: `${ROOT}/bin:${process.env.PATH}` }
})

// A test instance starts hidden with no Dock icon; this one is for looking at.
await app.evaluate(({ app: electronApp, BrowserWindow }) => {
  electronApp.setActivationPolicy?.('regular')
  electronApp.dock?.show()
  const w = BrowserWindow.getAllWindows()[0]
  w.setSize(1180, 760)
  w.center()
  w.show()
  w.focus()
})

// The Claude account at its limit: every read of the machine login answers 97% used.
await app.evaluate(({ ipcMain, BrowserWindow }) => {
  const reading = () => ({
    windows: [
      {
        key: 'session:demo',
        label: 'session',
        kind: 'session',
        scope: null,
        usedPercentage: 97,
        resetsAt: Date.now() + 2 * 3600_000,
        severity: null
      }
    ],
    fetchedAt: Date.now()
  })
  ipcMain._invokeHandlers.set('usage:get-limits', () => reading())
  globalThis.__demoPushLimit = () => {
    for (const w of BrowserWindow.getAllWindows())
      w.webContents.send('usage:claude-account', { accountId: 'default', result: reading() })
  }
})

await win.evaluate(async (script) => {
  await window.electronAPI.launchProfileUpsert({
    id: 'demo-codex',
    name: 'Demo Codex',
    family: 'codex',
    command: ['/usr/bin/python3', script],
    additionalArgs: []
  })
  await window.electronAPI.launchProfileSetGlobal('codex', 'demo-codex')
}, `${ROOT}/codex.py`)

const open = async (payload) =>
  (await callMcp(app, 'openSession', { cwd: ROOT, ...payload })).sessionId
const title = (id, value) =>
  win.evaluate(({ id, value }) => window.electronAPI.writeSession(id, value + '\r'), { id, value })

const { groupId } = await callMcp(app, 'createGroup', { name: 'Tab status demo' })
const ids = {}
ids.guide = await open({
  mode: 'terminal',
  name: 'Guide',
  command: `cat ${ROOT}/legend.txt`,
  autoRun: true
})
for (const name of ['Working', 'Needs you', 'New to read', 'Idle', 'Cycles', 'Ended'])
  ids[name] = await open({ mode: 'codex', name })
ids.message = await open({ mode: 'codex', name: 'Message from a tab' })
ids.chat = await open({ mode: 'claude', chat: true, name: 'Chat · background + limit' })
for (const id of Object.values(ids)) await callMcp(app, 'moveSession', { sessionId: id, groupId })
await callMcp(app, 'focus', { sessionId: ids.guide })
await sleep(2500)

await title(ids['Working'], 'codex | Working ⠋')
await title(ids['Needs you'], '[ ! ] Action Required | codex')
await title(ids['New to read'], 'codex | Working')
await title(ids['Ended'], 'codex | Working')
await win.evaluate(
  (id) => window.electronAPI.sessionsWrite(id, { type: 'user_message', text: 'start the servers' }),
  ids.chat
)
await callMcp(app, 'sendToSession', {
  sessionId: ids.message,
  message: 'A message from the Guide tab.',
  callerSessionId: ids.guide
})
await callMcp(app, 'focus', { sessionId: ids.guide })
await sleep(1500)
await title(ids['New to read'], 'codex | Ready')
await sleep(1500)
await title(ids['Ended'], 'exit')
await app.evaluate(() => globalThis.__demoPushLimit())

// What each row shows, as the DOM says it — the demo's own check.
await sleep(1500)
const rows = await win.evaluate(() =>
  [...document.querySelectorAll('.sidebar-item')].map((row) => ({
    name: row.querySelector('[data-testid="session-tab-name"]')?.textContent,
    status: row.querySelector('.tab-status')?.getAttribute('data-status'),
    background: row.querySelector('[data-background]')?.getAttribute('data-background') ?? null,
    limit: !!row.querySelector('[data-account-limit]')
  }))
)
console.log(JSON.stringify(rows.filter((r) => r.name)))
// The close button's glyph should sit as far from the row's right edge as
// from its top and bottom.
const idleRow = win.locator('.sidebar-item').filter({ hasText: 'Idle' }).first()
await idleRow.hover()
const insets = await idleRow.evaluate((row) => {
  const r = row.getBoundingClientRect()
  const x = row.querySelector('.sidebar-item-close svg')?.getBoundingClientRect()
  return x && { top: x.top - r.top, bottom: r.bottom - x.bottom, right: r.right - x.right }
})
console.log('close glyph insets', JSON.stringify(insets))
await win.screenshot({ path: '/tmp/tab-status-demo.png' })
console.log('Demo running. Close the Clave window to stop it.')
let closed = false
app.on('close', () => (closed = true))
const cycle = [
  ['codex | Working', 5000],
  ['[ ! ] Action Required | codex', 4000],
  ['codex | Working', 3000],
  ['codex | Ready', 4000]
]
while (!closed) {
  for (const [value, ms] of cycle) {
    if (closed) break
    await title(ids['Cycles'], value).catch(() => (closed = true))
    await sleep(ms)
  }
  await app.evaluate(() => globalThis.__demoPushLimit()).catch(() => (closed = true))
}
process.exit(0)

#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by npm run try */
// `npm run try`: this checkout's Clave, ready to try, with nothing set up by hand (PRDCT-4490).
//
//   npm run try                          the dev app (hot reload) attached to a server of its own:
//                                        enough for a change to the window
//   npm run try -- --server              the same, plus a second server from this checkout, the
//                                        other machine, already saved in the app and shown
//   npm run try -- --prompt "<text>"     a Claude chat started on the server the trial is about
//                                        (the second one with --server), the text its first
//                                        message, its tab selected: the demo plays as the window
//                                        opens. --prompt-file <file> reads the text from a file.
//   npm run try -- --account <label>     the Claude account that chat runs on (default: the first)
//   npm run try -- --model <alias>       the model that chat runs on (default: sonnet; a demo
//                                        never needs the frontier model)
//   npm run try -- --workspace <dir>     the workspace's folder (default: a scratch folder)
//   npm run try -- --stop                stop the trial of this checkout started elsewhere
//
// Everything lives under ~/.clave/try/<checkout>/ (CLAVE_TRY_HOME moves it): the app's profile,
// each server's data, a keychain file, the scratch workspaces, the logs. A second run keeps all of
// it (the window, the tabs, the saved server); delete the folder to start over.
//
// The Claude accounts are this Mac's Clave server's (~/.local/share/clave-server, or
// CLAVE_TRY_ACCOUNTS_FROM): their list is merged into each trial server's data, and their tokens
// are copied at every run from the login keychain into the trial's own keychain file, from
// `security` to `security`, never printed. The trial's servers and app use that file alone
// (CLAVE_KEYCHAIN_FILE), so removing or signing in again to an account in a trial changes the
// trial's copy and never the Mac's own. The file's password is kept in the login keychain.
//
// Ctrl-C here, or `npm run try -- --stop` from anywhere, ends the app, then the servers; a --stop
// after the trial's own process died stops what it had started, from the pids it recorded.
//
// The trial window opens a DevTools port on the loopback for as long as it runs (the script drives
// it: the server saved in the app, the workspace shown, the chat's tab selected). Any process of
// this Mac can reach that port: a trial is for a developer's own machine.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readServerDiscovery,
  serverCommand,
  startServerProcess,
  terminalProcessBundle
} from './server-process.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2).filter((a) => a !== '--')
const flag = (name) => argv.includes(`--${name}`)
function option(name) {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value`)
  return value
}
function fail(message) {
  process.stderr.write(`try: ${message}\n`)
  process.exit(1)
}
const say = (line) => process.stdout.write(`try: ${line}\n`)

const HOME =
  process.env.CLAVE_TRY_HOME ?? path.join(os.homedir(), '.clave', 'try', path.basename(REPO))
const P = {
  app: path.join(HOME, 'app'),
  mac: path.join(HOME, 'mac'),
  server: path.join(HOME, 'server'),
  keychain: path.join(HOME, 'keychain', 'try.keychain-db'),
  logs: path.join(HOME, 'logs'),
  state: path.join(HOME, 'try.json')
}
const ACCOUNTS_FROM =
  process.env.CLAVE_TRY_ACCOUNTS_FROM ?? path.join(os.homedir(), '.local', 'share', 'clave-server')
const SERVER_NAME = 'Trial server'

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}
function writePrivate(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** The pid of a trial of this checkout still running, read off its state file. */
function runningTrial() {
  const pid = readJson(P.state)?.pid
  if (!Number.isInteger(pid) || !alive(pid)) return null
  const command = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' })
  return command.stdout?.includes('scripts/try.mjs') ? pid : null
}

/** The app's process group and the second server a trial recorded, when they outlived it. */
async function stopLeftovers() {
  const state = readJson(P.state) ?? {}
  const left = []
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const groupUp = (pgid) => {
    try {
      process.kill(-pgid, 0)
      return true
    } catch {
      return false
    }
  }
  if (Number.isInteger(state.appGroup) && groupUp(state.appGroup)) {
    process.kill(-state.appGroup, 'SIGTERM')
    for (let i = 0; i < 60 && groupUp(state.appGroup); i++) await sleep(250)
    if (groupUp(state.appGroup)) process.kill(-state.appGroup, 'SIGKILL')
    left.push('the app')
  }
  if (Number.isInteger(state.serverPid)) {
    const command = spawnSync('ps', ['-o', 'command=', '-p', String(state.serverPid)], {
      encoding: 'utf-8'
    }).stdout
    if (command?.includes(P.server)) {
      process.kill(state.serverPid, 'SIGTERM')
      left.push('the trial server')
    }
  }
  writePrivate(P.state, { ...state, appGroup: null, serverPid: null })
  return left.join(' and ')
}

// ── --stop ──
if (flag('stop')) {
  const pid = runningTrial()
  if (!pid) {
    // The trial's own process may have died without its stop (a SIGKILL): what it
    // started is stopped from the pids it recorded (verifier round 4, finding 4).
    const left = await stopLeftovers()
    say(
      left
        ? `stopped what an ended trial had left: ${left}`
        : 'no trial of this checkout is running'
    )
    process.exit(0)
  }
  process.kill(pid, 'SIGTERM')
  for (let i = 0; i < 100 && alive(pid); i++) await delay(250)
  say(alive(pid) ? `the trial (pid ${pid}) is still stopping` : 'stopped')
  process.exit(0)
}
if (runningTrial()) fail(`a trial of this checkout already runs: npm run try -- --stop`)

const withServer = flag('server')
const promptFile = option('prompt-file')
const prompt = promptFile
  ? readFileSync(path.resolve(promptFile), 'utf-8').trim()
  : option('prompt')
const accountLabel = option('account')
const model = option('model') ?? 'sonnet'
const workspaceOption = option('workspace')
const workspaceRoot = (which) =>
  workspaceOption ? path.resolve(workspaceOption) : path.join(HOME, 'workspaces', which)

// ── The keychain file of the trial, and the accounts it holds ──
const SECURITY = '/usr/bin/security'
const SECRET_SERVICE = 'Clave server' // src/main/ports/standalone.ts
const PASSWORD_SERVICE = 'Clave try'
const quote = (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
/** Commands on `security -i`'s standard input: the values never reach a command line. */
function securityInput(lines) {
  const run = spawnSync(SECURITY, ['-i'], {
    input: lines.join('\n') + '\n',
    stdio: ['pipe', 'ignore', 'ignore']
  })
  return run.status === 0
}
function securityRead(args) {
  const run = spawnSync(SECURITY, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
  return run.status === 0 ? run.stdout.replace(/\n$/, '') : null
}
const securityHas = (args) => spawnSync(SECURITY, args, { stdio: 'ignore' }).status === 0

function openTrialKeychain() {
  mkdirSync(path.dirname(P.keychain), { recursive: true, mode: 0o700 })
  let password = securityRead([
    'find-generic-password',
    '-s',
    PASSWORD_SERVICE,
    '-a',
    P.keychain,
    '-w'
  ])
  if (!existsSync(P.keychain) || password === null) {
    if (existsSync(P.keychain))
      spawnSync(SECURITY, ['delete-keychain', P.keychain], { stdio: 'ignore' })
    password = randomBytes(24).toString('hex')
    securityInput([
      `add-generic-password -U -s ${quote(PASSWORD_SERVICE)} -a ${quote(P.keychain)} -w ${quote(password)}`,
      `create-keychain -p ${quote(password)} ${quote(P.keychain)}`
    ])
  }
  securityInput([`unlock-keychain -p ${quote(password)} ${quote(P.keychain)}`])
  spawnSync(SECURITY, ['set-keychain-settings', P.keychain], { stdio: 'ignore' })
  if (!existsSync(P.keychain)) fail(`the trial's keychain file could not be made at ${P.keychain}`)
}

/** Merge the Mac's accounts into a trial server's data (an account the trial already has is
 *  kept as the trial left it); answers the Keychain handles the trial's credentials name. */
function seedAccounts(dataDir) {
  const list = readJson(path.join(ACCOUNTS_FROM, 'claude-accounts.json'))
  const credentials = readJson(path.join(ACCOUNTS_FROM, 'claude-accounts-credentials.json')) ?? {}
  const listFile = path.join(dataDir, 'claude-accounts.json')
  const credentialsFile = path.join(dataDir, 'claude-accounts-credentials.json')
  const mine = readJson(listFile) ?? { v: list?.v ?? 1, accounts: [] }
  const mineCredentials = readJson(credentialsFile) ?? {}
  const known = new Set(mine.accounts.map((account) => account.id))
  for (const account of Array.isArray(list?.accounts) ? list.accounts : []) {
    if (known.has(account.id)) continue
    mine.accounts.push(account)
    if (credentials[account.id]) mineCredentials[account.id] = credentials[account.id]
  }
  writePrivate(listFile, mine)
  writePrivate(credentialsFile, mineCredentials)
  return Object.values(mineCredentials)
    .map((entry) => (typeof entry?.token === 'string' ? entry.token : ''))
    .filter((sealed) => sealed.startsWith('keychain:'))
    .map((sealed) => sealed.slice('keychain:'.length))
}

/** Copy each handle's token from the login keychain into the trial's file; a handle the
 *  login keychain does not hold (an account signed in inside the trial) is left alone. */
function copyTokens(handles) {
  const lines = []
  for (const handle of new Set(handles)) {
    const value = securityRead(['find-generic-password', '-s', SECRET_SERVICE, '-a', handle, '-w'])
    if (value === null || !/^[\x20-\x7e]+$/.test(value)) continue
    lines.push(
      `add-generic-password -U -s ${quote(SECRET_SERVICE)} -a ${quote(handle)} -w ${quote(value)} ${quote(P.keychain)}`
    )
  }
  if (lines.length) securityInput(lines)
  return [...new Set(handles)].filter((handle) =>
    securityHas(['find-generic-password', '-s', SECRET_SERVICE, '-a', handle, P.keychain])
  ).length
}

/** One workspace on a scratch folder (or --workspace), trusted, the one the server opens on. */
function seedWorkspace(dataDir, { id, name, root }) {
  mkdirSync(root, { recursive: true })
  const file = path.join(dataDir, 'workspace-state.json')
  const state = readJson(file) ?? { version: 1, workspaces: [], pins: [], pinsMigrated: true }
  state.workspaces ??= []
  if (!state.workspaces.some((w) => w.rootDir === root)) {
    const free = state.workspaces.some((w) => w.id === id) ? `${id}-${Date.now()}` : id
    state.workspaces.push({
      id: free,
      name,
      rootDir: root,
      profileFile: null,
      createdAt: Date.now()
    })
  }
  const workspace = state.workspaces.find((w) => w.rootDir === root)
  state.activeWorkspaceId ??= workspace.id
  state.lastActiveWorkspaceId ??= workspace.id
  writePrivate(file, state)
  const trustedFile = path.join(dataDir, 'clave-trusted-roots.json')
  const trusted = readJson(trustedFile) ?? []
  if (!trusted.includes(root)) writePrivate(trustedFile, [...trusted, root])
  return workspace.id
}
/** The first-run walk and the two first-run cards are not what a trial is for
 *  (`src/main/preferences-manager.ts`); a value already there is left alone. */
function skipFirstRun(dir) {
  const file = path.join(dir, 'preferences.json')
  const preferences = readJson(file) ?? {}
  writePrivate(file, {
    onboarding: 'done',
    telemetryNoticeShown: true,
    feedbackPromptCollapsed: true,
    ...preferences
  })
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
const portFree = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })

async function api(server, route, body) {
  const response = await fetch(server.url + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000)
  })
  const text = await response.text()
  if (response.status !== 200 && response.status !== 204)
    throw new Error(
      `${route}: ${response.status} ${text.replaceAll(server.token, '[token]').slice(0, 300)}`
    )
  return text ? JSON.parse(text) : undefined
}

// ── The window, driven once over its DevTools port: the saved server, the workspace, the tab ──
function devtools(socketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl)
    const pending = new Map()
    let next = 1
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      const waiting = pending.get(message.id)
      if (!waiting) return
      pending.delete(message.id)
      if (message.error) waiting.reject(new Error(message.error.message))
      else waiting.resolve(message.result)
    }
    socket.onerror = () => reject(new Error('the DevTools socket failed'))
    socket.onopen = () =>
      resolve({
        async evaluate(expression) {
          const id = next++
          const result = await new Promise((done, failed) => {
            pending.set(id, { resolve: done, reject: failed })
            socket.send(
              JSON.stringify({
                id,
                method: 'Runtime.evaluate',
                params: { expression, awaitPromise: true, returnByValue: true }
              })
            )
          })
          if (result.exceptionDetails)
            throw new Error(
              result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
            )
          return result.result.value
        },
        close: () => socket.close()
      })
  })
}
async function theWindow(port) {
  const ready = `typeof window.electronAPI === 'object' && document.readyState === 'complete' && !!document.querySelector('[aria-label="Switch workspace"]')`
  for (let attempt = 0; attempt < 360; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      for (const target of targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)) {
        const page = await devtools(target.webSocketDebuggerUrl)
        if (await page.evaluate(ready).catch(() => false)) return page
        page.close()
      }
    } catch {
      // Not listening yet.
    }
    await delay(500)
  }
  throw new Error('the app window did not come up within three minutes')
}
/** The loops below wait on this process's clock, never on the page's: a window behind others
 *  is hidden, and Chromium slows a hidden page's own timers to one a minute. */
/** Put the window on a workspace through the toolbar switcher, as a person would. */
async function switchTo(page, workspaceId) {
  const item = `document.querySelector('[data-workspace-id="' + CSS.escape(${JSON.stringify(workspaceId)}) + '"]')`
  for (let i = 0; i < 40; i++) {
    const seen = await page.evaluate(
      `(() => { const item = ${item}; return item ? item.getAttribute('data-selected') === 'true' ? 'selected' : 'listed' : 'closed' })()`
    )
    if (seen === 'selected') {
      await page.evaluate(
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
      )
      return true
    }
    await page.evaluate(
      seen === 'closed'
        ? `document.querySelector('[aria-label="Switch workspace"]')?.click()`
        : `${item}?.click()`
    )
    await delay(400)
  }
  return false
}
/** Select the chat's tab; a tab in a folded group is not drawn, so a group that shows no tab is
 *  unfolded once (a click on its header unfolds it and selects its tabs). */
async function selectTab(page, sessionId) {
  const find = `(() => {
    const id = ${JSON.stringify(sessionId)}
    const tail = ':' + encodeURIComponent(id)
    const row = [...document.querySelectorAll('[data-sidebar-item-type="session"][data-sidebar-item-id]')].find((el) => {
      const key = el.getAttribute('data-sidebar-item-id')
      return key === id || key.endsWith(tail)
    })
    if (!row) return false
    ;(row.querySelector(':scope > button') ?? row).click()
    return true
  })()`
  const unfold = `for (const header of document.querySelectorAll('[data-sidebar-item-type="group"]'))
    if (!header.parentElement?.querySelector('[data-sidebar-item-type="session"]'))
      header.querySelector(':scope > button')?.click()`
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate(find)) return true
    if (i === 4 || i === 20) await page.evaluate(unfold)
    await delay(500)
  }
  return false
}

/** One call to the app's own agent tools (the MCP server of the profile, `mcp-server.json`),
 *  with the app's token; answers the tool's JSON. */
async function appTool(name, args) {
  const { url, token } = readJson(path.join(P.app, 'mcp-server.json')) ?? {}
  if (!url || !token) throw new Error("the app's agent tools are not up")
  const post = async (body, session) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session && { 'mcp-session-id': session })
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    })
    const text = await response.text()
    const data = text.trim().startsWith('{')
      ? text
      : (text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5))
          .pop() ?? 'null')
    return { session: response.headers.get('mcp-session-id') ?? session, answer: JSON.parse(data) }
  }
  const opened = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'clave-try', version: '1' }
    }
  })
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, opened.session)
  const { answer } = await post(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    opened.session
  )
  const text = answer?.result?.content?.[0]?.text
  if (answer?.error || answer?.result?.isError || !text)
    throw new Error(
      `${name}: ${String(text ?? answer?.error?.message ?? 'no answer')
        .replaceAll(token, '[token]')
        .slice(0, 300)}`
    )
  return JSON.parse(text)
}
const openThroughApp = async (args) => (await appTool('clave_open_session', args)).sessionId

// ── The run ──
mkdirSync(P.logs, { recursive: true, mode: 0o700 })
const state = readJson(P.state) ?? {}
writePrivate(P.state, { ...state, pid: process.pid })

const built = spawnSync(path.join(REPO, 'node_modules', '.bin', 'electron-vite'), ['build'], {
  cwd: REPO,
  stdio: 'inherit'
})
if (built.status !== 0) process.exit(built.status ?? 1)

openTrialKeychain()
const handles = seedAccounts(P.mac)
const macWorkspace = seedWorkspace(P.mac, {
  id: 'try-mac',
  name: 'Trial',
  root: workspaceRoot('trial')
})
skipFirstRun(P.mac)
skipFirstRun(P.app)
let serverWorkspace = null
if (withServer) {
  handles.push(...seedAccounts(P.server))
  serverWorkspace = seedWorkspace(P.server, {
    id: 'try-server',
    name: 'Trial on the server',
    root: workspaceRoot('trial-server')
  })
  skipFirstRun(P.server)
}
const accounts = copyTokens(handles)
say(
  accounts
    ? `${accounts} Claude account(s) from ${ACCOUNTS_FROM}, in the trial's own keychain`
    : `no Claude account found in ${ACCOUNTS_FROM}: add one in the app, Settings, Usage`
)

const env = { ...process.env, CLAVE_KEYCHAIN_FILE: P.keychain }
let app = null
let second = null
let own = null
let stopping = false
/** The app runs in a process group of its own (electron-vite and the Electron it starts):
 *  electron-vite ends on a SIGTERM without ending the app, so the whole group is told. */
const groupAlive = (pgid) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}
async function stopApp() {
  if (!app?.pid || !groupAlive(app.pid)) return
  process.kill(-app.pid, 'SIGTERM')
  for (let i = 0; i < 60 && groupAlive(app.pid); i++) await delay(250)
  if (groupAlive(app.pid)) process.kill(-app.pid, 'SIGKILL')
}
async function stop(code) {
  if (stopping) return
  stopping = true
  await stopApp()
  if (second && second.exitCode === null && second.signalCode === null) {
    second.kill('SIGTERM')
    for (let i = 0; i < 40 && second.exitCode === null && second.signalCode === null; i++)
      await delay(250)
    if (second.exitCode === null && second.signalCode === null) second.kill('SIGKILL')
  }
  await own?.stop()
  // The app may have been started while this ran: stopped again, once it exists.
  await stopApp()
  writePrivate(P.state, { ...readJson(P.state), pid: null, appGroup: null, serverPid: null })
  process.exit(code)
}
process.on('SIGINT', () => void stop(0))
process.on('SIGTERM', () => void stop(0))
// Closing the terminal the trial runs in ends it the same way.
process.on('SIGHUP', () => void stop(0))

try {
  own = await startServerProcess({ repo: REPO, dataDir: P.mac, env })
  say(`the app's own server: ${own.url} (data in ${P.mac})`)

  let trial = null
  if (withServer) {
    let port =
      Number.isInteger(state.serverPort) && (await portFree(state.serverPort))
        ? state.serverPort
        : await freePort()
    const { cmd, args } = serverCommand({
      repo: REPO,
      dataDir: P.server,
      port,
      env,
      terminalProcess: terminalProcessBundle(REPO),
      args: ['--daemon', '--server-name', 'trial-server']
    })
    second = spawn(cmd, args, {
      cwd: REPO,
      env,
      stdio: [
        'ignore',
        openSync(path.join(P.logs, 'server.log'), 'a'),
        openSync(path.join(P.logs, 'server.log'), 'a')
      ]
    })
    writePrivate(P.state, { ...readJson(P.state), serverPid: second.pid })
    for (let i = 0; i < 120; i++) {
      const found = readServerDiscovery(P.server)
      if (found?.ok && found.pid === second.pid) break
      if (second.exitCode !== null)
        fail(`the trial server ended at its start: see ${P.logs}/server.log`)
      await delay(250)
    }
    const found = readServerDiscovery(P.server)
    if (!(found?.ok && found.pid === second.pid))
      fail(`the trial server did not start: see ${P.logs}/server.log`)
    const identity = readJson(path.join(P.server, 'daemon', 'identity.json'))
    trial = { url: found.url, token: identity.token }
    writePrivate(P.state, { ...readJson(P.state), serverPort: port })
    say(`the trial server: ${trial.url} (data in ${P.server}, log ${P.logs}/server.log)`)
  }

  const debugPort = await freePort()
  app = spawn(
    path.join(REPO, 'node_modules', '.bin', 'electron-vite'),
    ['dev', '--', `--user-data-dir=${P.app}`, `--remote-debugging-port=${debugPort}`],
    {
      cwd: REPO,
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...env, CLAVE_SERVER_URL: own.url, CLAVE_SERVER_TOKEN: own.token }
    }
  )
  writePrivate(P.state, { ...readJson(P.state), appGroup: app.pid })
  app.once('exit', (code) => void stop(code ?? 0))

  const page = await theWindow(debugPort)
  let shownWorkspace = macWorkspace
  if (trial) {
    const saved = await page.evaluate(`(async () => {
      const wanted = ${JSON.stringify({ name: SERVER_NAME, url: trial.url, token: trial.token })}
      const list = await window.electronAPI.fleetList()
      const old = list.find((c) => c.name === wanted.name)
      if (old && old.url === wanted.url) return old.id
      return (await window.electronAPI.fleetSave(old ? { ...wanted, id: old.id } : wanted)).id
    })()`)
    let workspaces = null
    for (let i = 0; i < 120 && !workspaces; i++) {
      workspaces = await page
        .evaluate(`window.electronAPI.fleetWorkspaces(${JSON.stringify(saved)})`)
        .catch(() => null)
      if (!workspaces) await delay(500)
    }
    const remote = workspaces?.find((w) => w.rootDir === workspaceRoot('trial-server'))
    if (!remote) fail('the app did not reach the trial server')
    shownWorkspace = remote.id
    say(`the trial server is saved in the app as "${SERVER_NAME}"`)
  }
  if (trial) await switchTo(page, shownWorkspace)

  if (prompt) {
    const target = trial ?? own
    const listed = await api(target, '/accounts/claude')
    const all = (Array.isArray(listed) ? listed : (listed?.accounts ?? [])).filter(
      (a) => a.hasToken
    )
    const account = accountLabel ? all.find((a) => a.label === accountLabel) : all[0]
    if (accountLabel && !account) fail(`no account "${accountLabel}" with a token on the server`)
    // A tab on the second server is the server's: started over its API, every window attached
    // to it lists it. A tab on the app's own server belongs to a window, and only the window
    // adds it: it is opened through the app's agent tools, as an agent opens one.
    const sessionId = trial
      ? (
          await api(trial, '/sessions/start', {
            cwd: workspaceRoot('trial-server'),
            options: {
              claudeMode: true,
              launchProfileId: 'claude-chat',
              dangerousMode: true,
              model,
              workspaceId: serverWorkspace,
              initialPrompt: prompt,
              ...(account && { claudeProfileId: account.id, claudeProfileLabel: account.label })
            }
          })
        ).id
      : await openThroughApp({
          cwd: workspaceRoot('trial'),
          mode: 'claude',
          model,
          dangerous: true,
          name: 'Demo',
          prompt,
          ...(account && { account: account.label })
        })
    const selected = await selectTab(page, sessionId)
    say(
      `a Claude chat on ${trial ? 'the trial server' : "the app's server"} (${account?.label ?? 'the machine login'}, ${model}) is playing the prompt`
    )
    if (!selected) say('its tab could not be selected: it is in the sidebar')
  }
  page.close()
  say('ready. Ctrl-C here, or `npm run try -- --stop`, ends the app and the servers')
} catch (error) {
  process.stderr.write(`try: ${error instanceof Error ? error.message : String(error)}\n`)
  await stop(1)
}

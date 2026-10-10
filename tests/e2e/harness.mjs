// Shared harness for the Electron end-to-end checks.
//
// These drive the REAL app — real main process, real `window.electronAPI`, real
// PTYs — against an isolated `--user-data-dir`, so they never touch the user's
// installed Clave. The regular `playwright` MCP opens the renderer in Chrome
// where `window.electronAPI` is undefined and none of this works.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright-core'
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  copyFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { fixturePath, fixtureRoot, fixtureTmuxName, namespaceOf } from './namespace.mjs'
import { startServerProcess } from '../../scripts/server-process.mjs'
import { boundedClose } from './bounds.mjs'

// Where a run keeps its fixtures (PRDCT-2615): every path a spec seeds goes
// through `fixturePath`, so a CLAVE_E2E_NS set by the runner moves the whole
// run under /tmp/<namespace>/ and two worktrees never share a folder.
export { fixturePath, fixtureRoot, fixtureTmuxName }

/** `n` TCP ports free on 127.0.0.1 right now, asked of the OS rather than
 *  fixed: two runs at once must not both serve (or probe) the same port. All
 *  `n` are held open until each is known, so they are distinct. */
export async function freePorts(n = 1) {
  const servers = []
  try {
    for (let i = 0; i < n; i++) {
      const srv = createServer()
      servers.push(srv)
      await new Promise((resolve, reject) => {
        srv.once('error', reject)
        srv.listen(0, '127.0.0.1', resolve)
      })
    }
    return servers.map((s) => s.address().port)
  } finally {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))))
  }
}

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON_BIN = path.join(
  REPO,
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
)

/** A user-data dir of this spec's own, so specs never collide — and, under
 *  the run's namespace, so two runs never collide either. */
export function userDataDir(name) {
  return fixturePath(name)
}

/** Seed the workspace registry the app boots from. Without this the app starts
 *  in no-workspace mode, where "launch at the workspace root" has no root and
 *  correctly falls back to the folder picker. */
export function seedWorkspaces(dir, { workspaces, activeWorkspaceId, fresh = false }) {
  if (fresh) rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'workspace-state.json'),
    JSON.stringify(
      { version: 1, workspaces, activeWorkspaceId, pins: [], pinsMigrated: true },
      null,
      2
    )
  )
}

/** Mark roots as trusted so the elevated-content review dialog does not appear.
 *  Pass nothing to leave every root UNTRUSTED — which is what the trust-gate
 *  spec needs. */
export function seedTrustedRoots(dir, roots) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'clave-trusted-roots.json'), JSON.stringify(roots))
}

// ── The server (ADR 0003, PRDCT-3154) ────────────────────────────────────────
// The app runs on a server: in-process by default, or ATTACHED to one started
// elsewhere (`CLAVE_SERVER_URL` + `CLAVE_SERVER_TOKEN`). The suite runs both
// ways, and the way is `CLAVE_E2E_SERVER`: `in-process` (the default, what the
// shipped app does) or `attached` (one server per spec, its own process on its
// own data directory and port, started before the app and stopped with it).
// The server's HTTP API is how a spec asserts on it (`serverClient`), never a
// hook inside the main process; `clave-server.json` in the app's user data
// says which server the app ended up on (`serverEndpoint`).

export const SERVER_MODE_ENV = 'CLAVE_E2E_SERVER'

/** The suite's server mode. Anything but the two names is refused loudly: a
 *  typo must not silently run the suite the default way. */
export function serverMode(env = process.env) {
  const raw = (env[SERVER_MODE_ENV] ?? 'in-process').trim() || 'in-process'
  if (raw !== 'in-process' && raw !== 'attached')
    throw new Error(
      `${SERVER_MODE_ENV} must be "in-process" or "attached", got ${JSON.stringify(raw)}`
    )
  return raw
}

// The servers this run started and has not stopped yet, so the end of the
// run can sweep what a spec that threw before `app.close()` left behind.
const liveServers = new Set()

/** The settings documents a spec seeds into the app's data folder that the
 *  separate server must find in its own: the server reads its `--data-dir`
 *  and nothing of the app's (ADR 0003), so a workspace seeded for the app
 *  alone left an attached window saying "No workspaces configured" (five
 *  specs red attached on dev at 7be32fd, measured by the wave on 8 October
 *  2026). The accounts' credentials are not among them: the app's are sealed
 *  by safeStorage, which the server cannot open. */
export const SEEDED_DOCUMENTS = [
  'workspace-state.json',
  'clave-trusted-roots.json',
  'preferences.json',
  'agent-launch-profiles.json',
  'claude-accounts.json',
  'codex-accounts.json'
]

/** Another domain's seeded documents, registered by name (a file name
 *  relative to the data folder, a folder's files one by one): a lane whose
 *  files move to the server's storage adds its names here, or from its own
 *  spec before `launchApp`, and the copy picks them up. Idempotent. */
export function registerSeededDocuments(...names) {
  for (const name of names) if (!SEEDED_DOCUMENTS.includes(name)) SEEDED_DOCUMENTS.push(name)
  return [...SEEDED_DOCUMENTS]
}
// The workspace files' trust store (wave 3, lane A, PRDCT-3291): the trusted
// roots are listed above; the trusted content hashes travel with them, so a
// spec that seeds a trusted `.clave` content reaches the attached server too.
registerSeededDocuments('clave-trusted.json')

/** Copy the seeded documents of an app data folder into a server's, before
 *  the server starts. Only what exists is copied; nothing is removed. */
export function seedServerDataDir(from, to) {
  if (!from || !existsSync(from)) return []
  mkdirSync(to, { recursive: true })
  const copied = []
  for (const name of SEEDED_DOCUMENTS) {
    const source = path.join(from, name)
    if (!existsSync(source)) continue
    mkdirSync(path.dirname(path.join(to, name)), { recursive: true })
    copyFileSync(source, path.join(to, name))
    copied.push(name)
  }
  return copied
}

/** Start a server of this spec's own, on `<fixture>/clave-e2e-<name>-server`.
 *  Resolves once it announced its url and token. `env` is extra environment
 *  for the server process, the way `launchApp`'s is for the app: a spec that
 *  names a local issuer or a keychain file of the run's own names it to both.
 *  `args` are extra flags for the entry (`launchApp` passes the app's own test
 *  flags); `seedFrom` is the app data folder whose seeded documents the
 *  server starts on. */
export async function startE2eServer(
  name,
  { timeoutMs = 15_000, env = {}, args = [], seedFrom = null, keep = false } = {}
) {
  const dataDir = fixturePath(`${name}-server`)
  // `keep`: an app RESTARTED on its data folder gets its server's data back
  // too (its session records, its settings as the window left them), the
  // way the in-process app finds its own; a fresh start wipes and seeds.
  if (!keep) {
    rmSync(dataDir, { recursive: true, force: true })
    seedServerDataDir(seedFrom, dataDir)
  }
  const started = await startServerProcess({
    repo: REPO,
    dataDir,
    timeoutMs,
    env: { ...process.env, ...env },
    args
  })
  const server = {
    ...started,
    stop: async () => {
      liveServers.delete(server)
      await started.stop()
    }
  }
  liveServers.add(server)
  return server
}

/** SIGTERM every server a spec left running (sync, for the end of the run). */
export function killLeakedServers() {
  for (const s of [...liveServers]) {
    liveServers.delete(s)
    try {
      process.kill(s.pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
}

/** What `clave-server.json` says in an isolated instance's user data: the
 *  url, the token, the mode, `ok`, or null while the app has not written it. */
export function serverEndpoint(dir) {
  const f = path.join(dir, 'clave-server.json')
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : null
}

/** A client of the server's HTTP API, bound to one token (null = none). Every
 *  call answers `{ status, body }` and never throws on a non-2xx, so a spec
 *  asserts the status it expects (a 401 included). */
export function serverClient(url, token) {
  const base = String(url).replace(/\/+$/, '')
  const headers = token ? { authorization: `Bearer ${token}` } : {}
  const request = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        ...headers,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = { raw: text }
    }
    return { status: res.status, body: parsed }
  }
  return {
    live: () => request('GET', '/health/live'),
    ready: () => request('GET', '/health/ready'),
    clients: () => request('GET', '/clients'),
    register: (identity) => request('POST', '/clients', identity),
    deregister: (id) => request('POST', '/clients/unregister', { id })
  }
}

/** The TCP ports a process is LISTENING on, sorted, asked of the OS (`lsof`).
 *  This is how a spec proves what a main process serves: the MCP server's
 *  port, the in-process server's port, and nothing else; in particular no
 *  server started "in place of" one that could not be reached. A probe of
 *  the url that failed proves nothing about a fallback on another port. */
/** How long a synchronous child call of the harness (lsof, tmux) may take. */
export const CHILD_CALL_TIMEOUT_MS = 10_000

export function listeningPorts(pid, { timeoutMs = 2 * CHILD_CALL_TIMEOUT_MS } = {}) {
  let out
  try {
    // A timeout on every synchronous child call of the harness: a hung lsof
    // or tmux blocks the runner's own event loop, and no in-process deadline
    // can fire while it does (wave 3's 13-minute launch had that shape).
    out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid), '-Fn'], {
      encoding: 'utf-8',
      timeout: timeoutMs
    })
  } catch (err) {
    // lsof exits 1 when the process has no matching descriptor at all.
    if (err?.status === 1 && !(err.stderr || '').trim()) return []
    throw err
  }
  const ports = new Set()
  for (const line of out.split('\n')) {
    // `-Fn` prints one `n<address>` line per descriptor: `n127.0.0.1:54321`.
    const m = /^n.*:(\d+)$/.exec(line.trim())
    if (m) ports.add(Number(m[1]))
  }
  return [...ports].sort((a, b) => a - b)
}

// ── The bounds (wave 4, lane A, PRDCT-3375, PRDCT-1762) ─────────────────────
// A launch waits on the window's boot, not on a clock; a close is bounded and
// ends with the Electron pid killed when the app does not quit; every app this
// run launched is known by its pid, so a spec that outlived its deadline
// (run.mjs) leaves no app behind.

/** How long `app.close()` may take before the Electron process is killed by
 *  its exact pid. The app's own quit ceiling and hammer
 *  (`src/main/quit-cleanup.ts`, 8 s + 2 s) come first, so a stalled quit
 *  names its pending wait in the app's log before the harness ends it. */
export const CLOSE_TIMEOUT_MS = 25_000
/** How long a window may take to finish its boot before the launch fails. */
export const BOOT_TIMEOUT_MS = 60_000
/** Every app this run launched and has not closed: Electron pid → data folder. */
const liveApps = new Map()

/** The pids of the apps still open. */
export function liveAppPids() {
  return [...liveApps.keys()]
}

/** SIGKILL every app a spec left open, by exact pid (never a pattern), for
 *  the end of a spec that outlived its deadline and the end of the run. */
export function killLeakedApps() {
  for (const pid of [...liveApps.keys()]) {
    liveApps.delete(pid)
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

/**
 * Wait for a window's boot. The renderer marks its document when its boot
 * tail has run (`<html data-boot="complete">`: the saved layout merged, the
 * survivors adopted, persistence on), or when the boot stopped to ask the
 * person about dead sessions (`data-boot="restore-prompt"`): either is a
 * window a spec may drive. With `dir`, the server's discovery file must be
 * there too, so a spec never reads an app that has not decided its server.
 * Fails loudly past `timeoutMs`, naming what was missing.
 *
 * Before this (PRDCT-1762) the harness waited a fixed 4 s, and a group a spec
 * created in that window was wiped by the layout merge: at 2 s never drawn,
 * at 3 s drawn, measured under load; four specs sat in known-failures.json for it.
 */
export async function waitForBoot(
  page,
  { timeoutMs = BOOT_TIMEOUT_MS, dir = null, pid = null } = {}
) {
  const started = Date.now()
  let state = null
  let server = dir ? null : 'not asked'
  while (Date.now() - started < timeoutMs) {
    state = await page
      .evaluate(() => document.documentElement.dataset.boot ?? null)
      .catch(() => null)
    if (dir) {
      // The file must be THIS launch's: the app does not remove it at quit,
      // so a relaunch into the same folder finds the previous launch's
      // (round 1 of the verifier). Main writes its own pid into it.
      const found = serverEndpoint(dir)
      server = !found ? null : pid != null && found.pid !== pid ? 'stale' : 'written'
    }
    if ((state === 'complete' || state === 'restore-prompt') && server === 'written')
      return { state, ms: Date.now() - started }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(
    `the window did not finish its boot in ${timeoutMs} ms ` +
      `(data-boot=${state ?? 'unset'}, clave-server.json ${server ?? 'missing'})`
  )
}

/** Launch the built app. Run `npx electron-vite build` first — these read `out/`.
 *
 *  `--test-no-activate` is always passed: the run must not steal the machine's
 *  focus from whoever is working while it goes. Its cost is that OS focus is
 *  gone — `BrowserWindow.getFocusedWindow()` can be null and `win.isFocused()`
 *  false all run — so assert Clave-internal focus, never the window manager's.
 *
 *  `server` is the suite's mode by default (`serverMode()`); a spec that must
 *  prove one path whatever the suite runs passes `'attached'`, `'in-process'`,
 *  or `{ url, token }` to attach to a server of its own (a dead one included).
 *  In attached mode the server is started here and stopped by `app.close()`;
 *  in in-process mode a stray `CLAVE_SERVER_URL` in the caller's shell is
 *  dropped, so the app never attaches by accident. */
export async function launchApp(
  dir,
  {
    settleMs = 0,
    env = {},
    args = [],
    server = serverMode(),
    bootTimeoutMs = BOOT_TIMEOUT_MS,
    // A spec that makes the server come up late (CLAVE_E2E_SERVER_BOOT_DELAY_MS)
    // wants the window before the server: it is not waited for then.
    waitForServer = !(Number(env.CLAVE_E2E_SERVER_BOOT_DELAY_MS) > 0)
  } = {}
) {
  const base = { ...process.env }
  delete base.CLAVE_SERVER_URL
  delete base.CLAVE_SERVER_TOKEN
  let started = null
  let serverEnv = {}
  launchedModes.set(
    path.resolve(dir),
    server === 'attached' || (server && typeof server === 'object') ? 'attached' : 'in-process'
  )
  if (server === 'attached') {
    // The server gets the app's own test flags (`--test-no-activate` is
    // what turns its fixture route and its terminal journal on; the echo
    // adapter's flags reach the process that spawns the sessions), the
    // spec's extra environment, and the documents the spec seeded for the app.
    // A restart (the app's data folder already carries a discovery file from
    // a launch of this run) keeps the server's data; a fresh start seeds it.
    const restart = existsSync(path.join(dir, 'clave-server.json'))
    started = await startE2eServer(path.basename(dir), {
      env,
      args: ['--test-no-activate', ...args],
      seedFrom: dir,
      keep: restart
    })
    serverEnv = { CLAVE_SERVER_URL: started.url, CLAVE_SERVER_TOKEN: started.token }
  } else if (server && typeof server === 'object') {
    serverEnv = { CLAVE_SERVER_URL: server.url, CLAVE_SERVER_TOKEN: server.token ?? '' }
  } else if (server !== 'in-process') {
    throw new Error(`launchApp: unknown server option ${JSON.stringify(server)}`)
  }
  let app
  try {
    app = await electron.launch({
      executablePath: ELECTRON_BIN,
      // `args` are extra main-process flags a spec needs (`--test-version=…`,
      // see src/main/test-mode.ts); the three fixed ones always come first.
      args: ['.', `--user-data-dir=${dir}`, '--test-no-activate', ...args],
      cwd: REPO,
      // Extra environment for the main process (e.g. CLAVE_TRANSCRIPTS_ROOT, so
      // a spec seeds transcripts without touching the real ~/.claude/projects).
      env: { ...base, ...serverEnv, ...env }
    })
  } catch (err) {
    await started?.stop()
    throw err
  }
  // The close is bounded (bounds.mjs): past CLOSE_TIMEOUT_MS the Electron
  // pid is killed and the close resolves. The server, in attached mode,
  // lives exactly as long as the app it was started for.
  const pid = app.process().pid
  liveApps.set(pid, path.resolve(dir))
  const close = app.close.bind(app)
  app.close = async () => {
    try {
      await boundedClose(close, pid, CLOSE_TIMEOUT_MS)
    } finally {
      liveApps.delete(pid)
      await started?.stop()
    }
  }
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  // The boot, not a clock (waitForBoot above); a settleMs a spec still
  // passes is waited after it.
  await waitForBoot(win, { timeoutMs: bootTimeoutMs, dir: waitForServer ? dir : null, pid })
  if (settleMs > 0) await win.waitForTimeout(settleMs)
  // The fixture: the one way into the process hosting the sessions, in
  // both modes (`serverFixture` below). Attached, the server this call
  // started; in-process, the app's own, read off its discovery file.
  const fixture = started
    ? serverFixture(started.url, started.token)
    : server && typeof server === 'object'
      ? serverFixture(server.url, server.token ?? '')
      : appServerFixture(dir)
  return { app, win, server: started, fixture }
}

// ── The fixture route (PRDCT-3293, lane C of wave 3) ─────────────────────────
// A spec that must reach the sessions from inside (wrap the session host,
// stub a settings read, replace `fetch`) used to `app.evaluate` a function in
// Electron main. The sessions live on the server now, which in attached mode
// is another process, so the function's SOURCE is sent to the server's
// `POST /e2e/evaluate` and run there, with `globalThis.__claveE2E` as the
// specs know it. The route exists only on a server started in test mode
// (`--test-no-activate`, which `launchApp` passes to both) and sits behind
// the token. Same rules as Playwright's evaluate: no closure over spec
// variables, one JSON-able argument, a JSON-able result.

export const FIXTURE_PATH = '/e2e/evaluate'

/** A fixture bound to one server. `evaluate(fn, arg)` runs `fn(arg)` in the
 *  server's process and answers its awaited value; what `fn` throws is
 *  thrown here with its message. */
export function serverFixture(url, token) {
  const base = String(url).replace(/\/+$/, '')
  return {
    url: base,
    token,
    async evaluate(fn, arg) {
      const source = typeof fn === 'function' ? fn.toString() : String(fn)
      const res = await fetch(base + FIXTURE_PATH, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(arg === undefined ? { source } : { source, arg })
      })
      if (res.status !== 200)
        throw new Error(`the fixture route answered ${res.status}: ${await res.text()}`)
      const body = await res.json()
      if (!body.ok) throw new Error(`fixture.evaluate failed in the server: ${body.error}`)
      return body.value
    }
  }
}

/** The fixture of an app on its own in-process server: the endpoint comes
 *  off `clave-server.json` in the app's data folder, waited for on the
 *  first call (the boot writes it a moment after the window loads). */
export function appServerFixture(dir) {
  let bound = null
  const resolve = async () => {
    if (bound) return bound
    const found = await until(() => {
      const d = serverEndpoint(dir)
      return d && d.ok && d.token ? d : null
    })
    if (!found) throw new Error(`no server endpoint in ${dir}/clave-server.json`)
    bound = serverFixture(found.url, found.token)
    return bound
  }
  return {
    get url() {
      return bound?.url ?? null
    },
    get token() {
      return bound?.token ?? null
    },
    evaluate: async (fn, arg) => (await resolve()).evaluate(fn, arg)
  }
}

/** Replace the native folder picker in the MAIN process so a spec can tell
 *  "opened the picker" from "went straight to the workspace root" — a native
 *  modal would otherwise block the run forever. Returns a reader for the count. */
export async function stubFolderDialog(app, { returns = null } = {}) {
  await app.evaluate(async ({ dialog }, folder) => {
    globalThis.__e2eDialogCalls = 0
    dialog.showOpenDialog = async () => {
      globalThis.__e2eDialogCalls++
      return folder ? { canceled: false, filePaths: [folder] } : { canceled: true, filePaths: [] }
    }
  }, returns)
  return async () => app.evaluate(() => globalThis.__e2eDialogCalls ?? 0)
}

/** Replace the elevated-content review dialog and drive its answer.
 *  `response`: 0 = Open safely (sanitized), 1 = Trust and run, 2 = Cancel. */
export async function stubReviewDialog(app, { response, checkboxChecked = false }) {
  await app.evaluate(
    async ({ dialog }, answer) => {
      globalThis.__e2eReviewCalls = []
      dialog.showMessageBox = async (_win, opts) => {
        globalThis.__e2eReviewCalls.push({
          message: opts?.message ?? '',
          detail: opts?.detail ?? ''
        })
        return { response: answer.response, checkboxChecked: answer.checkboxChecked }
      }
    },
    { response, checkboxChecked }
  )
  return async () => app.evaluate(() => globalThis.__e2eReviewCalls ?? [])
}

/** Run one MCP command through the renderer's dispatcher.
 *
 *  This is the SAME channel the MCP server uses: `mcp-bridge.ts` sends
 *  `mcp:command` to the window and waits on `mcp:response`, because every tool
 *  a `clave_*` call touches (sessions, groups, views) lives in the renderer's
 *  Zustand store. Driving that channel gives a spec the real handler — the real
 *  `handleSetSessionView`, the real store write — without standing up the HTTP
 *  server and its per-session bearer token, which belong to specs about the
 *  transport itself (see self-checkpoint.spec.mjs). Rejects on the handler's
 *  own error so a spec fails on a bad call instead of asserting on undefined. */
export async function callMcp(app, command, payload, timeoutMs = 10_000, windowId = null) {
  const res = await app.evaluate(
    async ({ BrowserWindow, ipcMain }, { command, payload, timeoutMs, windowId }) => {
      // Multi-window: the command runs in the renderer of the window named,
      // else the lowest-id (primary) one — the dispatcher and the store it
      // mutates are per window.
      const win =
        windowId != null
          ? BrowserWindow.fromId(windowId)
          : [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0]
      if (!win || win.isDestroyed()) return { ok: false, error: `no window ${windowId ?? ''}` }
      const requestId = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`
      return await new Promise((resolve) => {
        const onResponse = (_e, res) => {
          if (res?.requestId !== requestId) return
          ipcMain.removeListener('mcp:response', onResponse)
          resolve(res)
        }
        ipcMain.on('mcp:response', onResponse)
        win.webContents.send('mcp:command', { requestId, command, payload })
        setTimeout(() => {
          ipcMain.removeListener('mcp:response', onResponse)
          resolve({ ok: false, error: `no reply to "${command}" in ${timeoutMs}ms` })
        }, timeoutMs)
      })
    },
    { command, payload, timeoutMs, windowId }
  )
  if (!res?.ok) throw new Error(`MCP "${command}" failed: ${res?.error ?? 'unknown'}`)
  return res.result
}

/** `callMcp` addressed to one window's renderer (multi-window specs). */
export function callMcpIn(app, windowId, command, payload, timeoutMs = 10_000) {
  return callMcp(app, command, payload, timeoutMs, windowId)
}

// ── Multi-window (PRDCT-1703) ────────────────────────────────────────────────

/** Every open window as `{ id, page }`, lowest BrowserWindow id first. */
export async function windows(app) {
  const out = []
  for (const page of app.windows()) {
    if (page.isClosed()) continue
    const bw = await app.browserWindow(page)
    const id = await bw.evaluate((w) => w.id)
    out.push({ id, page })
  }
  return out.sort((a, b) => a.id - b.id)
}

/** The page of the window with this BrowserWindow id, or null. */
export async function windowFor(app, windowId) {
  return (await windows(app)).find((w) => w.id === windowId)?.page ?? null
}

/** This renderer's identity as main reports it (`window:identity`). */
export function identityOf(page) {
  return page.evaluate(() => window.electronAPI.windowIdentity())
}

/** Open a NEW window — the app once more — driving the REAL path: the
 *  renderer of `fromPage` calls `window.electronAPI.windowOpen`, exactly what
 *  the File menu, the popover and clave_open_window do. `workspaceId` null
 *  means "the asking window's own". Resolves once the new window's renderer
 *  has loaded and settled. */
export async function openWindow(
  app,
  fromPage,
  workspaceId = null,
  { settleMs = 0, bootTimeoutMs = BOOT_TIMEOUT_MS } = {}
) {
  const before = new Set(app.windows())
  // Subscribe BEFORE asking, so a window that appears between the answer and
  // the wait cannot slip past unobserved.
  const nextWindow = app.waitForEvent('window', { timeout: 15_000 }).catch(() => null)
  const result = await fromPage.evaluate(
    (ws) => window.electronAPI.windowOpen(ws ?? undefined),
    workspaceId
  )
  const page = app.windows().find((p) => !before.has(p)) ?? (await nextWindow)
  if (!page)
    throw new Error(`window:open answered ${JSON.stringify(result)} but no window appeared`)
  await page.waitForLoadState('domcontentloaded')
  await waitForBoot(page, { timeoutMs: bootTimeoutMs })
  if (settleMs > 0) await page.waitForTimeout(settleMs)
  return { ...result, page }
}

/** The persisted window list (`windows.json`) of an isolated instance. */
export function persistedWindows(dir) {
  const f = path.join(dir, 'windows.json')
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')).windows : []
}

/** A window's own sidebar layout file, by its persisted key. */
export function windowLayout(dir, windowKey) {
  const f = path.join(dir, 'sidebar-layouts', 'windows', `${windowKey}.json`)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : null
}

/** Poll until `fn` returns a truthy value or the budget runs out. */
export async function until(fn, { tries = 40, gapMs = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, gapMs))
  }
  return null
}

/** Close a window the way the user does (the BrowserWindow's own close, so
 *  main's 'closed' handler — the teardown ladder — runs). */
export async function closeWindow(app, page) {
  const bw = await app.browserWindow(page)
  await bw.evaluate((w) => w.close())
  await new Promise((r) => setTimeout(r, 1000))
}

/**
 * The PTYs live on the SHARED tmux socket ('clave', a fixed constant), so
 * `--user-data-dir` isolation stops at userData: a spawned tab's tmux session
 * and its live process survive `app.close()`. Kill ONLY sessions named for
 * e2e fixture roots ('clave-e2e' is the harness's own prefix) AND started
 * under THIS run's fixture root — never anything of the user's, never another
 * run's (a namespace is not in the tmux name, which the app builds from the
 * cwd's basename, so the session's start path is what tells two runs apart),
 * and never with pkill.
 */
export function killLeakedE2eTmux({ env = process.env, timeoutMs = CHILD_CALL_TIMEOUT_MS } = {}) {
  let rows
  try {
    // `env` is the child's environment too, so a test can put a tmux of its
    // own on its PATH (Node looks the command up on `options.env.PATH`).
    // A pipe, not a tab: tmux prints a control character in a format as '_'.
    // The app's session names are [A-Za-z0-9_-], so the first pipe is the cut.
    rows = execFileSync(
      'tmux',
      ['-L', 'clave', 'list-sessions', '-F', '#{session_name}|#{session_path}'],
      {
        encoding: 'utf-8',
        timeout: timeoutMs,
        env
      }
    )
  } catch {
    return // No tmux server = nothing leaked.
  }
  for (const n of leakedE2eSessions(rows, { env })) {
    try {
      // `=name` is an EXACT target: never a prefix or a glob match.
      execFileSync('tmux', ['-L', 'clave', 'kill-session', '-t', `=${n}`], {
        timeout: timeoutMs,
        env
      })
    } catch {
      // Gone between the list and the kill.
    }
  }
}

/** The end of a run (run.mjs): sweep this run's leaked sessions, and after a
 *  green run remove its fixture folder — a red one keeps it to be read. Only
 *  a folder named as the suite's own (`clave-e2e-`, what defaultNamespace
 *  gives) is ever removed: CLAVE_E2E_NS is free text, and a green run must not
 *  delete whatever /tmp folder a typo happens to name (`tmux-501` is the tmux
 *  socket directory). Returns whether the folder was removed. */
export function finishRun({ failed, env = process.env }) {
  killLeakedApps()
  killLeakedE2eTmux({ env })
  killLeakedServers()
  if (failed !== 0 || !namespaceOf(env).startsWith('clave-e2e-')) return false
  rmSync(fixtureRoot({ env }), { recursive: true, force: true })
  return true
}

/** Which rows of `list-sessions -F '#{session_name}|#{session_path}'` are
 *  this run's leaked fixture sessions. Pure, so the scoping is testable
 *  without a socket: tmux keeps a start path in the form it was given, so
 *  both /tmp/<ns> and /private/tmp/<ns> count, and `<ns>x` beside it does not. */
export function leakedE2eSessions(rows, { env = process.env } = {}) {
  const roots = [fixtureRoot({ env }), fixtureRoot({ env, real: true })]
  const underRoot = (p) => roots.some((r) => p === r || p.startsWith(r + '/'))
  const out = []
  for (const row of rows.split('\n').filter(Boolean)) {
    const cut = row.indexOf('|')
    const n = cut < 0 ? row : row.slice(0, cut)
    const startPath = cut < 0 ? '' : row.slice(cut + 1)
    if (n.includes('clave-e2e') && underRoot(startPath)) out.push(n)
  }
  return out
}

/** Is a tmux session of that name alive on the app's socket? */
export function tmuxSessionAlive(name, { timeoutMs = CHILD_CALL_TIMEOUT_MS } = {}) {
  try {
    execFileSync('tmux', ['-L', 'clave', 'has-session', '-t', `=${name}`], {
      stdio: 'ignore',
      timeout: timeoutMs
    })
    return true
  } catch {
    return false
  }
}

/** The labels of the sidebar's session rows. */
export function sidebarRows(win) {
  return win.evaluate(() =>
    [...document.querySelectorAll('[class*="sidebar-item"]')].map((r) =>
      (r.textContent || '').trim()
    )
  )
}

/** The agent button's current label — what one click would launch. */
export function agentButtonLabel(win) {
  return win.evaluate(() =>
    (document.querySelector('.launcher-split .launcher-btn')?.textContent || '').trim()
  )
}

/** Record every `pty:spawn` payload as it crosses into the main process.
 *
 *  This is the assertion point for prompt delivery. `pty:spawn` creates the
 *  session record; the command itself does not run until the terminal mounts and
 *  calls `pty:start`, so a tab that is not on screen has no process and a `ps`
 *  check answers on which tab happened to be mounted rather than on the code.
 *  Tapping the IPC boundary is deterministic and is exactly where the renderer's
 *  decision — which agent, which directory, which prompt with its tokens already
 *  substituted — is expressed.
 *
 *  `_invokeHandlers` is Electron-private, so this fails loudly if it ever
 *  disappears rather than quietly recording nothing and passing.  */
export async function spyPtySpawn(app) {
  const installed = await app.evaluate(async ({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    if (!handlers || typeof handlers.get !== 'function') return false
    const original = handlers.get('pty:spawn')
    if (!original) return false
    globalThis.__e2eSpawns = []
    const record = (cwd, options) =>
      globalThis.__e2eSpawns.push({
        cwd,
        initialPrompt: options?.initialPrompt ?? null,
        claudeMode: options?.claudeMode ?? false,
        claudeAgentsMode: options?.claudeAgentsMode ?? false,
        codexMode: options?.codexMode ?? false,
        antigravityMode: options?.antigravityMode ?? false,
        // A resume from the history dialog: the conversation id, verbatim.
        resumeSessionId: options?.resumeSessionId ?? null,
        dangerousMode: options?.dangerousMode ?? false,
        workspaceId: options?.workspaceId ?? null
      })
    // A window the server has not reached starts its sessions over IPC...
    handlers.set('pty:spawn', async (event, cwd, options) => {
      record(cwd, options)
      return original(event, cwd, options)
    })
    // ...and a window on the server starts them through the session host
    // (`src/main/sessions/host.ts`, exposed under --test-no-activate by
    // `sessions/e2e-hooks.ts`): the same spawn, wrapped the same way. Both are
    // tapped because which one a spawn takes depends on whether the server was
    // up when the window made its first call.
    const host = globalThis.__claveE2E?.sessionHost
    if (host) {
      const start = host.start
      host.start = async (input) => {
        record(input.cwd, input.options)
        return start.call(host, input)
      }
    }
    return true
  })
  // No spec calls this at wave 2's head: the terminal specs read the
  // journal (`spawnJournal` below). Kept for a spec that must tap the IPC
  // handler and the session host at once; it fails loudly rather than
  // recording nothing when Electron moves its private map.
  if (!installed)
    throw new Error(
      'spyPtySpawn could not tap pty:spawn (ipcMain._invokeHandlers moved?). Prefer spawnJournal.'
    )
  return async () => app.evaluate(() => globalThis.__e2eSpawns ?? [])
}

/** Where a test instance journals its terminal spawns and writes: under its
 *  user-data directory, under `--test-no-activate` (`src/main/terminal-journal.ts`,
 *  which also names the file on `globalThis.__claveE2E.terminalJournal`). */
/** How each app data folder was last launched by `launchApp`: the journal
 *  is read where the terminal manager of THAT launch runs. An existence
 *  check would read a stale server journal in an in-process run after an
 *  attached one of the same spec (the verifier's round 1, Major 2). */
const launchedModes = new Map()

export function terminalJournalPath(dir) {
  // Attached, the terminal manager runs in the standalone server, which
  // keeps the journal under its own data folder (the folder `startE2eServer`
  // names for the app's `dir`); in-process it is the app's.
  const mode = launchedModes.get(path.resolve(dir)) ?? 'in-process'
  return mode === 'attached'
    ? path.join(fixturePath(`${path.basename(dir)}-server`), 'terminal-journal.jsonl')
    : path.join(dir, 'terminal-journal.jsonl')
}

function readTerminalJournal(dir) {
  const file = terminalJournalPath(dir)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

/** Every spawn the terminal manager is asked for from this moment on, as the
 *  renderer decided it: which agent, which directory, which prompt with its
 *  tokens already substituted, which conversation resumed.
 *
 *  This is the assertion point for prompt delivery. A spawn creates the
 *  session record; the command itself does not run until the terminal mounts
 *  and reports its size, so a tab that is not on screen has no process and a
 *  `ps` check answers on which tab happened to be mounted rather than on the
 *  code. The journal is written by the terminal manager itself, below IPC
 *  (`src/main/terminal-journal.ts`), so it sees the launch whether the window
 *  asked over IPC or over the server, and it exists only under
 *  `--test-no-activate`. It replaces `spyPtySpawn`, which tapped
 *  `ipcMain._invokeHandlers` inside the main process (PRDCT-3240); a spec
 *  that reads it pins `server: 'in-process'`, because an attached server has
 *  no terminals until wave 3.
 *
 *  Returns a reader of the spawns journaled AFTER this call. */
export function spawnJournal(dir) {
  const seen = readTerminalJournal(dir).length
  return async () =>
    readTerminalJournal(dir)
      .slice(seen)
      .filter((line) => line.kind === 'spawn')
      .map(({ cwd, options }) => ({
        cwd,
        initialPrompt: options?.initialPrompt ?? null,
        claudeMode: options?.claudeMode ?? false,
        claudeAgentsMode: options?.claudeAgentsMode ?? false,
        codexMode: options?.codexMode ?? false,
        antigravityMode: options?.antigravityMode ?? false,
        // A resume from the history dialog: the conversation id, verbatim.
        resumeSessionId: options?.resumeSessionId ?? null,
        dangerousMode: options?.dangerousMode ?? false,
        workspaceId: options?.workspaceId ?? null
      }))
}

/** Every byte the renderer writes into a PTY from this moment on, read from
 *  the same journal: `writesTo(id)` is the text written to that session. */
export function writeJournal(dir) {
  const seen = readTerminalJournal(dir).length
  return async (id) =>
    readTerminalJournal(dir)
      .slice(seen)
      .filter((line) => line.kind === 'write' && line.id === id)
      .map((line) => line.data)
      .join('')
}

// ── MCP over HTTP (PRDCT-1703 slice 2 routing) ───────────────────────────────
// The real transport: mcp-server resolves WHICH window runs each call from the
// caller's per-session token, so routing (§3.8) is only exercised over HTTP,
// not through callMcpIn (which targets one window's dispatcher directly).

/** Minimal Streamable-HTTP MCP client bound to one session's bearer token. */
export function mcpHttpClient(url, token) {
  let mcpSessionId = null
  let nextId = 1
  const post = async (body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {})
      },
      body: JSON.stringify(body)
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) mcpSessionId = sid
    const text = await res.text()
    const payloads =
      text.startsWith('event:') || text.includes('\ndata:') || text.startsWith('data:')
        ? text
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
        : [text]
    const parsed = payloads.filter(Boolean).map((p) => JSON.parse(p))
    return parsed[parsed.length - 1] ?? null
  }
  return {
    async init() {
      const res = await post({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'clave-e2e', version: '0.0.0' }
        }
      })
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
      return res
    },
    async call(name, args) {
      return post({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args }
      })
    }
  }
}

/** The structured payload of a tool result (JSON in the text block). */
export function toolPayload(rpc) {
  const r = rpc?.result
  if (!r) return null
  if (r.structuredContent) return r.structuredContent
  const text = r.content?.find((c) => c.type === 'text')?.text
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

/** Whether a tool call came back as an error (transport or tool-level). */
export function toolErrored(rpc) {
  return rpc?.error !== undefined || rpc?.result?.isError === true
}

/** The MCP endpoint URL for an isolated app instance. */
export function mcpEndpoint(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'mcp-server.json'), 'utf-8')).url
}

/** Spawn a Claude agent tab in `page`'s window (its launcher button) and
 *  return its clave session id + per-session MCP bearer token, once minted.
 *  Agent tabs mint an mcp-config under <dir>/mcp-configs/<claveId>.json. */
export async function spawnAgentTabIn(app, page, dir, { until: untilFn = until } = {}) {
  const before = new Set(
    existsSync(path.join(dir, 'mcp-configs')) ? readdirSync(path.join(dir, 'mcp-configs')) : []
  )
  await page.click('.launcher-split .launcher-btn')
  const cfg = await untilFn(() => {
    const d = path.join(dir, 'mcp-configs')
    if (!existsSync(d)) return null
    const f = readdirSync(d).find((f) => f.endsWith('.json') && !before.has(f))
    return f ? { claveId: f.replace(/\.json$/, ''), file: path.join(d, f) } : null
  })
  if (!cfg) return null
  const token = JSON.parse(
    readFileSync(cfg.file, 'utf-8')
  ).mcpServers?.clave?.headers?.Authorization?.replace(/^Bearer /, '')
  return { sessionId: cfg.claveId, token }
}

// A family becomes a submenu when chat/custom profiles are registered.
// Follow the built-in leaf so the assertions still exercise the terminal CLI.
export async function selectBuiltIn(win, label, profileName, family) {
  const profiles = await win.evaluate(() => window.electronAPI.launchProfilesList())
  // One terminal built-in always exists; registered chat profiles add a second.
  const count = 1 + profiles.customProfiles.filter((p) => p.family === family).length
  const entry = win
    .locator('[role="menuitem"]')
    .filter({ has: win.getByText(label, { exact: true }) })
  const submenu = (await entry.getAttribute('aria-haspopup')) === 'menu'
  assert.equal(
    submenu,
    count > 1,
    `${label}: ${count} profiles must produce ${count > 1 ? 'a submenu' : 'a flat item'}`
  )
  await entry.click()
  if (count > 1) await win.getByRole('menuitem', { name: profileName, exact: true }).click()
}

// ── The agent tools' road (wave 3, PRDCT-3294) ───────────────────────────────

/** Which road each agent tool took since the app started, oldest first:
 *  `server` (the server's own command, through the client) or `window` (a
 *  view request the window answered through the server). Recorded by main
 *  under --test-no-activate on the shared hooks namespace
 *  (`globalThis.__claveE2E.mcpRoads`, `src/main/mcp/roads.ts`); an app that
 *  never ran a tool answers an empty list. */
export async function mcpRoads(app) {
  return app.evaluate(() => globalThis.__claveE2E?.mcpRoads ?? [])
}

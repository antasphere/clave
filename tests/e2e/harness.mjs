// Shared harness for the Electron end-to-end checks.
//
// These drive the REAL app — real main process, real `window.electronAPI`, real
// PTYs — against an isolated `--user-data-dir`, so they never touch the user's
// installed Clave. The regular `playwright` MCP opens the renderer in Chrome
// where `window.electronAPI` is undefined and none of this works.
import { _electron as electron } from 'playwright-core'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON_BIN = path.join(
  REPO,
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
)

/** A user-data dir of this spec's own, so specs never collide. */
export function userDataDir(name) {
  return `/tmp/clave-e2e-${name}`
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

/** Launch the built app. Run `npx electron-vite build` first — these read `out/`.
 *
 *  `--test-no-activate` is always passed: the run must not steal the machine's
 *  focus from whoever is working while it goes. Its cost is that OS focus is
 *  gone — `BrowserWindow.getFocusedWindow()` can be null and `win.isFocused()`
 *  false all run — so assert Clave-internal focus, never the window manager's. */
export async function launchApp(dir, { settleMs = 4000, env = {}, args = [] } = {}) {
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    // `args` are extra main-process flags a spec needs (`--test-version=…`,
    // see src/main/test-mode.ts); the three fixed ones always come first.
    args: ['.', `--user-data-dir=${dir}`, '--test-no-activate', ...args],
    cwd: REPO,
    // Extra environment for the main process (e.g. CLAVE_TRANSCRIPTS_ROOT, so
    // a spec seeds transcripts without touching the real ~/.claude/projects).
    env: { ...process.env, ...env }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(settleMs)
  return { app, win }
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
export async function openWindow(app, fromPage, workspaceId = null, { settleMs = 4000 } = {}) {
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
  await page.waitForTimeout(settleMs)
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
 * e2e fixture roots ('clave-e2e' is the harness's own prefix) — never
 * anything of the user's, and never with pkill.
 */
export function killLeakedE2eTmux() {
  try {
    const names = execFileSync('tmux', ['-L', 'clave', 'list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf-8'
    })
      .split('\n')
      .filter(Boolean)
    for (const n of names) {
      // `=name` is an EXACT target: never a prefix or a glob match.
      if (n.includes('clave-e2e'))
        execFileSync('tmux', ['-L', 'clave', 'kill-session', '-t', `=${n}`])
    }
  } catch {
    // No tmux server = nothing leaked.
  }
}

/** Is a tmux session of that name alive on the app's socket? */
export function tmuxSessionAlive(name) {
  try {
    execFileSync('tmux', ['-L', 'clave', 'has-session', '-t', `=${name}`], { stdio: 'ignore' })
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
    handlers.set('pty:spawn', async (event, cwd, options) => {
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
      return original(event, cwd, options)
    })
    return true
  })
  if (!installed) {
    throw new Error(
      [
        'spyPtySpawn could not tap pty:spawn.',
        '',
        'This DELIBERATELY uses `ipcMain._invokeHandlers`, an undocumented Electron',
        'internal, verified on Electron 39 (39.5.2) with playwright-core 1.62. If you',
        'are reading this after an Electron upgrade, the private Map has most likely',
        'moved or been renamed.',
        '',
        'REPAIR IT — do not delete this test. It is the only deterministic point where',
        'we can assert that a group prompt actually reaches the agent: `pty:spawn` only',
        'creates the session record, the command runs when the terminal mounts, so a',
        'background tab has no process and a `ps` check answers on which tab happened',
        'to be on screen rather than on the code. Deleting it puts prompt delivery back',
        'to unverifiable, which is where PRDCT-1677 started.',
        '',
        'Fallbacks, in order of preference: find where ipcMain now stores invoke',
        'handlers; failing that, add a dev-only hook at ptyManager.spawn recording the',
        'resolved shellArgs. See the workstream bundle 2026-08-22-sidebar-launcher for',
        'the reasoning.'
      ].join('\n')
    )
  }
  return async () => app.evaluate(() => globalThis.__e2eSpawns ?? [])
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

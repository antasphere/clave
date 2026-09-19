import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { app } from 'electron'
// Runtime-only use inside sweepSessionMcpConfigs — the import cycle with
// pty-manager is safe (no module-eval-time access), and going through
// sessionRecordsDir() is what guarantees the legacy-dir rename has run before
// the sweep decides which configs are stale.
import { sessionRecordsDir } from '../pty-manager'

/** Runtime info about the in-app MCP server, set once it is listening. */
export interface McpRuntimeInfo {
  url: string
  token: string
}

let runtime: McpRuntimeInfo | null = null

export function setMcpRuntime(info: McpRuntimeInfo | null): void {
  runtime = info
}

export function getMcpRuntime(): McpRuntimeInfo | null {
  return runtime
}

/**
 * Per-session bearer tokens: `token → claveSessionId`. Each spawned tab gets a
 * UNIQUE token in its 0600 mcp-config, and the server derives the caller's
 * identity from the presented token — NOT from a client-supplied header. That
 * binds identity to a credential the tab can't forge, so one tab can't
 * impersonate another (or claim to be the user) when calling the cross-tab
 * tools. The shared `runtime.token` remains valid as an anonymous discovery
 * credential (no tab identity), so it grants none of the identity-gated tools.
 */
const sessionTokens = new Map<string, string>()

/** Resolve the calling tab's id from its per-session token, or undefined for
 *  the anonymous shared token / an unknown token. */
export function resolveSessionByToken(token: string): string | undefined {
  return sessionTokens.get(token)
}

function registerSessionToken(token: string, claveSessionId: string): void {
  // One token per session: drop any prior token for this id so a rewrite
  // (re-adoption) doesn't leave a stale credential mapped.
  for (const [t, sid] of sessionTokens) if (sid === claveSessionId) sessionTokens.delete(t)
  sessionTokens.set(token, claveSessionId)
}

function unregisterSessionTokensFor(claveSessionId: string): void {
  for (const [t, sid] of sessionTokens) if (sid === claveSessionId) sessionTokens.delete(t)
}

/** Extract the Bearer token from a session's on-disk config, if present. */
function readConfigToken(claveSessionId: string): string | undefined {
  try {
    const cfg = JSON.parse(fs.readFileSync(sessionConfigPath(claveSessionId), 'utf-8')) as {
      mcpServers?: { clave?: { headers?: { Authorization?: string } } }
    }
    const auth = cfg.mcpServers?.clave?.headers?.Authorization
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length)
  } catch {
    /* missing / malformed */
  }
  return undefined
}

/**
 * Rebuild the token→session map from the per-session config files on disk.
 * Call once at startup: a tmux-surviving tab keeps running with the token in
 * its existing config, so re-registering it keeps that tab's live MCP calls
 * authenticating after an app restart. Skips any config still carrying the
 * shared token (a pre-upgrade session) — that token must stay anonymous.
 */
export function rebuildSessionTokens(): void {
  let files: string[]
  try {
    files = fs.readdirSync(sessionConfigDir()).filter((f) => f.endsWith('.json'))
  } catch {
    return
  }
  for (const file of files) {
    const id = path.basename(file, '.json')
    const token = readConfigToken(id)
    if (token && token !== runtime?.token) registerSessionToken(token, id)
  }
}

function serverStateFilePath(): string {
  return path.join(app.getPath('userData'), 'mcp-server.json')
}

function sessionConfigDir(): string {
  return path.join(app.getPath('userData'), 'mcp-configs')
}

function sessionConfigPath(claveSessionId: string): string {
  return path.join(sessionConfigDir(), `${claveSessionId}.json`)
}

/**
 * Load the persisted MCP server state (port + token), or mint a fresh token.
 * Token and port are persisted because tmux-backed Claude sessions survive app
 * restarts without re-running `claude` — their injected MCP config must keep
 * working, so the server tries to come back on the same port with the same
 * token. Port 0 means "pick an ephemeral port".
 */
export function loadOrCreateServerState(): { port: number; token: string } {
  try {
    const data = JSON.parse(fs.readFileSync(serverStateFilePath(), 'utf-8')) as {
      url?: string
      token?: string
    }
    const port = Number(new URL(data.url ?? '').port)
    if (data.token && Number.isInteger(port) && port > 0) {
      return { port, token: data.token }
    }
  } catch {
    /* fall through to fresh state */
  }
  return { port: 0, token: randomBytes(32).toString('hex') }
}

/** Persist the server endpoint. Doubles as a discovery file for external agents. */
export function saveServerState(url: string, token: string): void {
  const filePath = serverStateFilePath()
  const tmp = `${filePath}.tmp`
  // Write-then-rename so a kill mid-write can never leave a truncated file.
  fs.writeFileSync(tmp, JSON.stringify({ url, token }, null, 2), { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmp, filePath)
  fs.chmodSync(filePath, 0o600)
}

/**
 * Write the per-session `--mcp-config` file for a Claude session spawned by
 * Clave. The file carries a UNIQUE per-session bearer token; the server maps it
 * back to this session id, which is how the caller's identity is established
 * (the tab can't forge it). A file (rather than inline JSON) keeps the token
 * off `ps`/tmux-visible command lines. Returns the file path, or null on
 * failure (the spawn then simply omits the flag).
 *
 * The token is REUSED if a valid per-session config already exists for this id
 * (re-adoption rewrites the config but must not rotate the token out from under
 * a still-running tab that already loaded it). A fresh id — or a config still
 * holding the anonymous shared token — mints a new one.
 */
export function writeSessionMcpConfig(claveSessionId: string): string | null {
  if (!runtime) return null
  try {
    const dir = sessionConfigDir()
    fs.mkdirSync(dir, { recursive: true })
    const existing = readConfigToken(claveSessionId)
    const sessionToken =
      existing && existing !== runtime.token ? existing : randomBytes(32).toString('hex')
    const config = {
      mcpServers: {
        clave: {
          type: 'http',
          url: runtime.url,
          headers: {
            Authorization: `Bearer ${sessionToken}`
          }
        }
      }
    }
    const filePath = sessionConfigPath(claveSessionId)
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), {
      encoding: 'utf-8',
      mode: 0o600
    })
    fs.chmodSync(filePath, 0o600)
    registerSessionToken(sessionToken, claveSessionId)
    return filePath
  } catch (err) {
    console.error('[mcp] failed to write session config', err)
    return null
  }
}

/**
 * How many per-session configs point at a DIFFERENT endpoint than the one just
 * bound. Each such session's agent process read its config at spawn and holds
 * that old URL in memory — it is cut off until its tab restarts. Counted at
 * startup, before re-adoption rewrites the files and erases the evidence.
 */
export function countStaleSessionConfigs(currentUrl: string): number {
  let stale = 0
  let files: string[]
  try {
    files = fs.readdirSync(sessionConfigDir()).filter((f) => f.endsWith('.json'))
  } catch {
    return 0
  }
  for (const file of files) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(sessionConfigDir(), file), 'utf-8')) as {
        mcpServers?: { clave?: { url?: string } }
      }
      const url = cfg.mcpServers?.clave?.url
      if (url && url !== currentUrl) stale++
    } catch {
      /* malformed — not a live endpoint holder */
    }
  }
  return stale
}

export function deleteSessionMcpConfig(claveSessionId: string): void {
  unregisterSessionTokensFor(claveSessionId)
  try {
    fs.unlinkSync(sessionConfigPath(claveSessionId))
  } catch {
    /* already gone */
  }
}

/**
 * Remove per-session config files whose session no longer exists. A session
 * can outlive an app run only via its session record, so any config whose id
 * has no record is stale. Call once on startup.
 */
export function sweepSessionMcpConfigs(): void {
  let configFiles: string[]
  try {
    configFiles = fs.readdirSync(sessionConfigDir()).filter((f) => f.endsWith('.json'))
  } catch {
    return
  }
  const liveIds = new Set<string>()
  try {
    const recordsDir = sessionRecordsDir()
    for (const file of fs.readdirSync(recordsDir)) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(recordsDir, file), 'utf-8')) as {
          id?: string
        }
        if (meta.id) liveIds.add(meta.id)
      } catch {
        /* malformed record — pty-manager prunes these */
      }
    }
  } catch {
    /* no records dir — every config is stale */
  }
  for (const file of configFiles) {
    // Conversation configs are owned and removed by the detached session
    // lifecycle. PTY records cannot tell us whether their agent is alive.
    if (/^conversation-[0-9a-f-]{36}\.json$/i.test(file)) continue
    if (!liveIds.has(path.basename(file, '.json'))) {
      try {
        fs.unlinkSync(path.join(sessionConfigDir(), file))
      } catch {
        /* ignore */
      }
    }
  }
}

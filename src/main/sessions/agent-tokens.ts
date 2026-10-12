/**
 * The agent tokens of a server running apart from the app (wave 4, lane C,
 * PRDCT-3376). A Claude session the standalone server starts reaches Clave's
 * agent tools, which live in the attached shell: its `--mcp-config` must
 * point at the shell's MCP server (told to this store by `announce`) and
 * carry a per-session bearer token the shell can map back to the session.
 *
 * This is the standalone counterpart of the shell's `mcp-runtime.ts`: the
 * same per-session-token discipline, built over a plain directory and the
 * session windows port instead of Electron. It is both the terminal layer's
 * `McpConfigPort` (it writes the file at spawn) and the server's
 * `AgentTokensService` (it answers which session a token belongs to, and in
 * which window). Nothing here imports Electron, so it runs under Bun.
 */
import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import type { AgentTokensService } from '@clave/server'
import type { AgentTokenOwner } from '@clave/contract/agent-tools'
import type { McpConfigPort } from '../ports/mcp-config'
import { sessionWindows } from './windows'

export interface AgentTokenStore extends AgentTokensService {
  /** The terminal layer's port: writes a session's config at spawn. */
  readonly mcpConfig: McpConfigPort
}

const configPath = (dir: string, sessionId: string): string => path.join(dir, `${sessionId}.json`)

/** The Bearer token a config file on disk carries, when it reads as one. */
function readConfigToken(file: string): string | undefined {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      mcpServers?: { clave?: { headers?: { Authorization?: string } } }
    }
    const auth = cfg.mcpServers?.clave?.headers?.Authorization
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length)
  } catch {
    /* missing or malformed */
  }
  return undefined
}

/**
 * The token store under `configDir`, the server's own `mcp-configs/` folder.
 * `windowOf` names the window a session lives in; the standalone server's
 * in-memory session windows port by default, injectable for the tests.
 */
export function createAgentTokenStore(
  configDir: string,
  windowOf: (sessionId: string) => string | null = (id) => sessionWindows().windowOf(id)
): AgentTokenStore {
  let url: string | null = null
  /** token -> sessionId, rebuilt from the configs on disk at construction so
   *  a CLI that survived a restart keeps authenticating on the token it read. */
  const bySession = new Map<string, string>()
  const idOfToken = new Map<string, string>()

  const register = (token: string, sessionId: string): void => {
    const prior = bySession.get(sessionId)
    if (prior) idOfToken.delete(prior)
    bySession.set(sessionId, token)
    idOfToken.set(token, sessionId)
  }
  const unregister = (sessionId: string): void => {
    const token = bySession.get(sessionId)
    if (token) idOfToken.delete(token)
    bySession.delete(sessionId)
  }

  try {
    for (const file of fs.readdirSync(configDir).filter((f) => f.endsWith('.json'))) {
      const token = readConfigToken(path.join(configDir, file))
      if (token) register(token, path.basename(file, '.json'))
    }
  } catch {
    /* no folder yet */
  }

  return {
    announce: (next) => {
      url = next
    },
    resolve: (token): AgentTokenOwner | undefined => {
      const sessionId = idOfToken.get(token)
      return sessionId ? { sessionId, windowKey: windowOf(sessionId) } : undefined
    },
    mcpConfig: {
      write: (sessionId) => {
        if (!url) return null
        try {
          fs.mkdirSync(configDir, { recursive: true })
          const file = configPath(configDir, sessionId)
          const existing = readConfigToken(file)
          const token = existing ?? randomBytes(32).toString('hex')
          fs.writeFileSync(
            file,
            JSON.stringify(
              {
                mcpServers: {
                  clave: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } }
                }
              },
              null,
              2
            ),
            { encoding: 'utf-8', mode: 0o600 }
          )
          fs.chmodSync(file, 0o600)
          register(token, sessionId)
          return file
        } catch {
          return null
        }
      },
      remove: (sessionId) => {
        unregister(sessionId)
        try {
          fs.unlinkSync(configPath(configDir, sessionId))
        } catch {
          /* already gone */
        }
      }
    }
  }
}

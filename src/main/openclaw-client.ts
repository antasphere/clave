import WebSocket from 'ws'
import { randomUUID } from 'crypto'
import { Location, Agent, ChatMessage } from '../shared/remote-types'

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000
const RECONNECT_MAX_ATTEMPTS = 10 // circuit breaker — stop hammering an offline host
const HANDSHAKE_TIMEOUT_MS = 20000 // reject connect() if the challenge never completes
const TICK_TIMEOUT_FACTOR = 3 // close if no tick for 3x interval

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

/**
 * Build the OpenClaw WebSocket URL for a location, choosing ws:// vs wss://
 * according to the location's transport policy. Plaintext ws:// is only used for
 * loopback or networks explicitly marked as already-encrypted (Tailscale/VPN).
 */
export function buildOpenclawWsUrl(
  loc: Pick<Location, 'host' | 'openclawPort' | 'openclawTransport'>
): string {
  const host = loc.host ?? ''
  const port = loc.openclawPort
  const isLoopback = LOOPBACK_HOSTS.has(host)

  if (isLoopback) {
    return `ws://${host}:${port}`
  }

  if (loc.openclawTransport === 'secure') {
    return `wss://${host}:${port}`
  }

  // 'trusted' or legacy-undefined: plaintext over a transport assumed encrypted.
  if (loc.openclawTransport !== 'trusted') {
    console.warn(
      `[openclaw] Location ${host} uses plaintext ws:// without an explicit transport policy. ` +
        `Set openclawTransport: 'secure' (wss) or 'trusted' (Tailscale/VPN) to silence this warning.`
    )
  }
  return `ws://${host}:${port}`
}

interface PendingRequest {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  expectFinal?: boolean
  timer: ReturnType<typeof setTimeout>
}

interface ConnectionEntry {
  ws: WebSocket
  wsUrl: string
  token?: string
  reconnectAttempts: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  handshakeTimer: ReturnType<typeof setTimeout> | null
  tickTimer: ReturnType<typeof setTimeout> | null
  tickIntervalMs: number
  intentionalClose: boolean
  connected: boolean
  pending: Map<string, PendingRequest>
}

type MessageCallback = (locationId: string, message: ChatMessage) => void
type AgentsCallback = (locationId: string, agents: Agent[]) => void

/**
 * Infer the default workspace path from the agent sessions file path.
 * Sessions path pattern: /home/user/.openclaw/agents/<id>/sessions/sessions.json
 * Default workspace:     /home/user/.openclaw/workspace
 */
function inferWorkspaceFromSessionsPath(sessionsPath?: string): string | undefined {
  if (!sessionsPath) return undefined
  // Find the .openclaw directory in the path
  const idx = sessionsPath.indexOf('/.openclaw/')
  if (idx === -1) return undefined
  return sessionsPath.slice(0, idx) + '/.openclaw/workspace'
}

class OpenClawClient {
  private connections = new Map<string, ConnectionEntry>()
  private messageCallbacks = new Set<MessageCallback>()
  private agentCallbacks = new Set<AgentsCallback>()

  async connect(
    locationId: string,
    wsUrl: string,
    token?: string,
    reconnectAttempts = 0
  ): Promise<void> {
    // Disconnect existing connection if any
    this.disconnect(locationId)

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl)

      const entry: ConnectionEntry = {
        ws,
        wsUrl,
        token,
        // Preserve the backoff counter across reconnect attempts so an offline
        // host backs off exponentially instead of retrying every second.
        reconnectAttempts,
        reconnectTimer: null,
        handshakeTimer: null,
        tickTimer: null,
        tickIntervalMs: 30000,
        intentionalClose: false,
        connected: false,
        pending: new Map()
      }

      this.connections.set(locationId, entry)

      let settled = false
      const settle = (err?: Error): void => {
        if (settled) return
        settled = true
        if (entry.handshakeTimer) {
          clearTimeout(entry.handshakeTimer)
          entry.handshakeTimer = null
        }
        if (err) reject(err)
        else resolve()
      }

      // Reject the connect promise if the challenge/handshake never completes,
      // so an awaiting agent:connect IPC call cannot hang forever.
      entry.handshakeTimer = setTimeout(() => {
        if (!entry.connected) {
          try {
            ws.terminate()
          } catch {
            // ignore
          }
          settle(new Error('handshake timeout'))
        }
      }, HANDSHAKE_TIMEOUT_MS)

      ws.on('open', () => {
        // Wait for connect.challenge event — don't resolve yet
      })

      ws.on('message', (data) => {
        this.handleMessage(locationId, entry, data, () => settle())
      })

      ws.on('close', () => {
        this.stopTickWatch(entry)
        entry.connected = false
        // Reject all pending requests
        for (const [, p] of entry.pending) {
          clearTimeout(p.timer)
          p.reject(new Error('connection closed'))
        }
        entry.pending.clear()
        settle(new Error('connection closed'))

        if (!entry.intentionalClose) {
          this.scheduleReconnect(locationId, entry)
        }
      })

      ws.on('error', (err) => {
        if (ws.readyState === WebSocket.CONNECTING) {
          this.connections.delete(locationId)
          settle(err)
        }
      })
    })
  }

  disconnect(locationId: string): void {
    const entry = this.connections.get(locationId)
    if (!entry) return

    entry.intentionalClose = true
    this.stopTickWatch(entry)

    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer)
      entry.reconnectTimer = null
    }

    if (entry.handshakeTimer) {
      clearTimeout(entry.handshakeTimer)
      entry.handshakeTimer = null
    }

    for (const [, p] of entry.pending) {
      clearTimeout(p.timer)
    }
    entry.pending.clear()

    if (entry.ws.readyState === WebSocket.OPEN || entry.ws.readyState === WebSocket.CONNECTING) {
      entry.ws.close()
    }

    this.connections.delete(locationId)
  }

  disconnectAll(): void {
    for (const locationId of [...this.connections.keys()]) {
      this.disconnect(locationId)
    }
  }

  /** Send a message to an agent */
  async sendToAgent(locationId: string, agentId: string, content: string): Promise<void> {
    const result = (await this.request(
      locationId,
      'agent',
      {
        message: content,
        agentId,
        idempotencyKey: randomUUID(),
        deliver: false
      },
      { expectFinal: true }
    )) as { result?: { payloads?: Array<{ text?: string }> } }

    // Extract final text from completed response
    const text = result?.result?.payloads
      ?.map((p) => p.text)
      .filter(Boolean)
      .join('\n')
    if (text) {
      const message: ChatMessage = {
        id: randomUUID(),
        agentId,
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
        status: 'delivered'
      }
      for (const cb of this.messageCallbacks) {
        cb(locationId, message)
      }
    }
  }

  /** Request agents list from the gateway via health RPC */
  requestAgents(locationId: string): void {
    this.request(locationId, 'health', {})
      .then((payload) => {
        const raw = payload as {
          agents?: Array<{
            agentId: string
            name?: string
            isDefault?: boolean
            workspace?: string
            sessions?: { path?: string }
          }>
        }
        if (!raw?.agents) return
        const agents: Agent[] = raw.agents.map((a) => ({
          id: a.agentId,
          name: a.name || a.agentId,
          status: 'online',
          locationId,
          cwd: a.workspace || inferWorkspaceFromSessionsPath(a.sessions?.path)
        }))
        for (const cb of this.agentCallbacks) {
          cb(locationId, agents)
        }
      })
      .catch(() => {
        // Health request failed
      })
  }

  /** Request sessions list from the gateway */
  async requestSessions(locationId: string): Promise<unknown> {
    return this.request(locationId, 'sessions.list', {})
  }

  /** Request chat history for a specific session */
  async requestChatHistory(locationId: string, sessionKey: string): Promise<unknown> {
    return this.request(locationId, 'chat.history', { sessionKey })
  }

  onMessage(callback: MessageCallback): () => void {
    this.messageCallbacks.add(callback)
    return () => {
      this.messageCallbacks.delete(callback)
    }
  }

  onAgentsUpdate(callback: AgentsCallback): () => void {
    this.agentCallbacks.add(callback)
    return () => {
      this.agentCallbacks.delete(callback)
    }
  }

  // ── Private ──

  private request(
    locationId: string,
    method: string,
    params: Record<string, unknown>,
    opts?: { expectFinal?: boolean }
  ): Promise<unknown> {
    const entry = this.connections.get(locationId)
    if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('not connected'))
    }

    const id = randomUUID()
    const frame = { type: 'req', id, method, params }

    return new Promise((resolve, reject) => {
      // Timeout: 30s for normal requests, 120s for agent requests that wait for completion
      const timeoutMs = opts?.expectFinal ? 120000 : 30000
      const timer = setTimeout(() => {
        if (entry.pending.has(id)) {
          entry.pending.delete(id)
          reject(new Error(`request timeout: ${method}`))
        }
      }, timeoutMs)
      entry.pending.set(id, { resolve, reject, expectFinal: opts?.expectFinal, timer })
      entry.ws.send(JSON.stringify(frame))
    })
  }

  private handleMessage(
    locationId: string,
    entry: ConnectionEntry,
    data: WebSocket.RawData,
    onFirstConnect: () => void
  ): void {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(data.toString())
    } catch {
      return
    }

    // Event frames: { type: "event", event: "...", payload: ... }
    if (parsed.type === 'event') {
      const event = parsed.event as string

      if (event === 'connect.challenge') {
        // Respond with connect request
        const payload = parsed.payload as { nonce?: string }
        const nonce = payload?.nonce
        if (!nonce) return

        this.request(locationId, 'connect', {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: 'gateway-client',
            displayName: 'Clave',
            version: '1.14.0',
            platform: process.platform,
            mode: 'backend'
          },
          caps: [],
          auth: entry.token ? { token: entry.token } : undefined,
          role: 'operator',
          scopes: ['operator.admin']
        })
          .then((payload) => {
            entry.connected = true
            entry.reconnectAttempts = 0

            // Extract tick interval from policy
            const res = payload as { policy?: { tickIntervalMs?: number } }
            if (res?.policy?.tickIntervalMs) {
              entry.tickIntervalMs = res.policy.tickIntervalMs
            }
            this.startTickWatch(entry)

            // Request agents list
            this.requestAgents(locationId)

            onFirstConnect()
          })
          .catch(() => {
            entry.ws.close()
          })
        return
      }

      if (event === 'tick') {
        // Reset tick watchdog
        this.resetTickWatch(entry)
        return
      }

      // Agent streaming events: { stream: "assistant", data: { text, delta }, sessionKey: "agent:<id>:main" }
      if (event === 'agent') {
        const p = parsed.payload as {
          stream?: string
          data?: { text?: string; delta?: string; phase?: string }
          sessionKey?: string
          runId?: string
        }
        if (p?.stream === 'assistant' && p.data?.text) {
          // Extract agentId from sessionKey "agent:<agentId>:main"
          const parts = p.sessionKey?.split(':')
          const agentId = parts?.[1]
          if (agentId) {
            const message: ChatMessage = {
              id: p.runId || randomUUID(),
              agentId,
              role: 'assistant',
              content: p.data.text,
              timestamp: Date.now(),
              status: 'streaming'
            }
            for (const cb of this.messageCallbacks) {
              cb(locationId, message)
            }
          }
        }
        return
      }

      // Health events — refresh agent list
      if (event === 'health') {
        const p = parsed.payload as {
          agents?: Array<{
            agentId: string
            name?: string
            workspace?: string
            sessions?: { path?: string }
          }>
        }
        if (p?.agents) {
          const agents: Agent[] = p.agents.map((a) => ({
            id: a.agentId,
            name: a.name || a.agentId,
            status: 'online',
            locationId,
            cwd: a.workspace || inferWorkspaceFromSessionsPath(a.sessions?.path)
          }))
          for (const cb of this.agentCallbacks) {
            cb(locationId, agents)
          }
        }
      }

      return
    }

    // Response frames: { type: "res", id: "...", ok: bool, payload: ..., error: ... }
    if (parsed.type === 'res') {
      const id = parsed.id as string
      const pending = entry.pending.get(id)
      if (!pending) return

      // Skip intermediate "accepted" responses when waiting for final
      const payload = parsed.payload as { status?: string } | undefined
      if (pending.expectFinal && parsed.ok && payload?.status === 'accepted') {
        return
      }

      entry.pending.delete(id)
      clearTimeout(pending.timer)

      if (parsed.ok) {
        pending.resolve(parsed.payload)
      } else {
        const err = parsed.error as { message?: string; code?: string }
        pending.reject(new Error(err?.message || 'unknown error'))
      }
    }
  }

  private startTickWatch(entry: ConnectionEntry): void {
    this.stopTickWatch(entry)
    this.resetTickWatch(entry)
  }

  private resetTickWatch(entry: ConnectionEntry): void {
    if (entry.tickTimer) clearTimeout(entry.tickTimer)
    entry.tickTimer = setTimeout(() => {
      // No tick received for too long — close and reconnect
      if (entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.terminate()
      }
    }, entry.tickIntervalMs * TICK_TIMEOUT_FACTOR)
  }

  private stopTickWatch(entry: ConnectionEntry): void {
    if (entry.tickTimer) {
      clearTimeout(entry.tickTimer)
      entry.tickTimer = null
    }
  }

  private scheduleReconnect(locationId: string, entry: ConnectionEntry): void {
    // Circuit breaker: stop retrying an unreachable host after a bounded number
    // of attempts instead of opening a new socket every second indefinitely.
    if (entry.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      console.warn(
        `[openclaw] giving up reconnecting to ${locationId} after ${entry.reconnectAttempts} attempts`
      )
      return
    }

    const nextAttempt = entry.reconnectAttempts + 1
    const base = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, entry.reconnectAttempts),
      RECONNECT_MAX_MS
    )
    const delay = base / 2 + Math.random() * (base / 2) // full jitter on the upper half

    entry.reconnectTimer = setTimeout(async () => {
      entry.reconnectTimer = null
      try {
        // Carry the attempt counter forward so backoff actually grows.
        await this.connect(locationId, entry.wsUrl, entry.token, nextAttempt)
      } catch {
        // connect failed — the close handler will schedule another reconnect
      }
    }, delay)
  }
}

export const openclawClient = new OpenClawClient()

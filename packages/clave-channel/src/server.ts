import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID, timingSafeEqual } from 'crypto'
import type { ClientMessage, ServerMessage, AgentInfo, ChatMessagePayload } from './protocol.js'

/** Reject frames larger than this to bound memory pressure from a hostile peer. */
const MAX_PAYLOAD_BYTES = 1024 * 1024 // 1 MB

export interface ClaveChannelServerOptions {
  port: number
  /** Interface to bind. Defaults to loopback — never expose to the network without a deliberate opt-in. */
  host?: string
  /** Required. The server refuses to start without it (fail closed). */
  apiKey?: string
  /** Optional Origin allowlist for browser-originated WebSocket handshakes. */
  allowedOrigins?: string[]
  onChat?: (agentId: string, content: string) => Promise<string | AsyncIterable<string>>
  getAgents?: () => AgentInfo[]
}

/** Constant-time string comparison that is safe for unequal lengths. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export class ClaveChannelServer {
  private wss: WebSocketServer | null = null
  private clients = new Set<WebSocket>()
  private options: ClaveChannelServerOptions

  constructor(options: ClaveChannelServerOptions) {
    this.options = options
  }

  start(): void {
    // Fail closed: an unauthenticated channel exposes an agent with shell/tool
    // access to anything that can reach the port.
    if (!this.options.apiKey) {
      throw new Error(
        'ClaveChannelServer refuses to start without an apiKey (authentication is mandatory).'
      )
    }

    const apiKey = this.options.apiKey

    // Bind to loopback by default. Without an explicit host, `ws` binds 0.0.0.0,
    // reachable from the whole LAN.
    const host = this.options.host ?? '127.0.0.1'

    this.wss = new WebSocketServer({
      port: this.options.port,
      host,
      maxPayload: MAX_PAYLOAD_BYTES
    })

    this.wss.on('connection', (ws, req) => {
      // Origin check: WebSocket handshakes are not subject to same-origin policy,
      // so a malicious web page (or DNS-rebind) could otherwise reach the port.
      const origin = req.headers['origin']
      if (origin && this.options.allowedOrigins && !this.options.allowedOrigins.includes(origin)) {
        ws.close(4003, 'Forbidden origin')
        return
      }

      // Mandatory API-key auth, constant-time comparison.
      const url = new URL(req.url || '/', `http://localhost:${this.options.port}`)
      const headerKey = req.headers['x-api-key']
      const key =
        url.searchParams.get('key') || (Array.isArray(headerKey) ? headerKey[0] : headerKey)
      if (!key || !safeEqual(key, apiKey)) {
        ws.close(4001, 'Unauthorized')
        return
      }

      this.clients.add(ws)

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as ClientMessage
          this.handleMessage(ws, msg)
        } catch {
          this.send(ws, { type: 'error', error: 'Invalid message format' })
        }
      })

      ws.on('close', () => {
        this.clients.delete(ws)
      })

      ws.on('pong', () => {
        // Client is alive
      })
    })
  }

  stop(): void {
    for (const client of this.clients) {
      client.close()
    }
    this.clients.clear()
    this.wss?.close()
    this.wss = null
  }

  /** Broadcast a message to all connected Clave clients */
  broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message)
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data)
      }
    }
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message))
    }
  }

  private async handleMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'ping':
        this.send(ws, { type: 'pong' })
        break

      case 'list-agents': {
        const agents = this.options.getAgents?.() ?? []
        this.send(ws, { type: 'agents', agents })
        break
      }

      case 'chat': {
        if (!this.options.onChat) {
          this.send(ws, { type: 'error', error: 'No chat handler configured' })
          return
        }

        const messageId = randomUUID()

        try {
          const result = await this.options.onChat(msg.agentId, msg.content)

          if (typeof result === 'string') {
            // Single response
            const chatMsg: ChatMessagePayload = {
              id: messageId,
              agentId: msg.agentId,
              role: 'assistant',
              content: result,
              timestamp: Date.now(),
              status: 'sent'
            }
            this.send(ws, { type: 'chat', message: chatMsg })
          } else {
            // Streaming response
            let fullContent = ''
            for await (const chunk of result) {
              fullContent += chunk
              const chatMsg: ChatMessagePayload = {
                id: messageId,
                agentId: msg.agentId,
                role: 'assistant',
                content: chunk,
                timestamp: Date.now(),
                status: 'streaming'
              }
              this.send(ws, { type: 'chat', message: chatMsg })
            }
            // Final message
            const finalMsg: ChatMessagePayload = {
              id: messageId,
              agentId: msg.agentId,
              role: 'assistant',
              content: fullContent,
              timestamp: Date.now(),
              status: 'sent'
            }
            this.send(ws, { type: 'chat', message: finalMsg })
          }
        } catch (err) {
          const errorMsg: ChatMessagePayload = {
            id: messageId,
            agentId: msg.agentId,
            role: 'system',
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: Date.now(),
            status: 'error'
          }
          this.send(ws, { type: 'chat', message: errorMsg })
        }
        break
      }
    }
  }
}

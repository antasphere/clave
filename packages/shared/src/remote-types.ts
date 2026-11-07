// ── Location — a machine Clave can connect to ──

export type LocationStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

export interface Location {
  id: string
  name: string
  type: 'local' | 'remote'
  host?: string
  port?: number
  username?: string
  authMethod?: 'key' | 'password' | 'agent'
  privateKeyPath?: string
  autoConnect?: boolean
  status: LocationStatus
  lastConnectedAt?: number
  openclawVersion?: string
  openclawPort?: number
  openclawToken?: string
  /**
   * Transport policy for the OpenClaw WebSocket.
   * - 'secure'  → wss:// with TLS certificate verification.
   * - 'trusted' → ws:// permitted because the network layer is already
   *               encrypted (e.g. Tailscale/WireGuard or a VPN).
   * - undefined → legacy: treated as 'trusted' (ws://) with a console warning,
   *               so existing connections keep working. New connections should
   *               set 'secure'.
   * Loopback hosts always use ws:// regardless of this field.
   */
  openclawTransport?: 'secure' | 'trusted'
}

// ── SSH connection config (subset for encrypted storage) ──

export interface SSHConnectionConfig {
  host: string
  port: number
  username: string
  authMethod: 'key' | 'password' | 'agent'
  privateKeyPath?: string
  password?: string // encrypted at rest via safeStorage
}

// ── Agent — an OpenClaw agent on a location ──

export type AgentStatus = 'online' | 'offline' | 'busy' | 'error'

export interface Agent {
  id: string
  name: string
  locationId: string
  status: AgentStatus
  model?: string
  cwd?: string
}

// ── Chat message ──

export type ChatMessageStatus = 'sending' | 'streaming' | 'sent' | 'delivered' | 'error'

export interface ChatMessage {
  id: string
  agentId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  status: ChatMessageStatus
}

// ── Remote FS entry ──

export interface RemoteDirEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
}

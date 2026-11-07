import {
  SERVER_PAIRING_COLORS,
  type ServerPairing,
  type ServerPairingChange,
  type ServerPairings
} from '../../../packages/contract/src/fleet'
import type { SettingsPorts } from '../ports/registry'

const DOCUMENT = 'server-pairings.json'
const MAX_PAIRS = 200
const MAX_DECLINED = 200

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max = 512): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  // eslint-disable-next-line no-control-regex -- an id with a control character is no id
  !/[\x00-\x1f\x7f]/.test(value)
const color = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)

/** One server's entry as the file may hold it; anything malformed is dropped
 *  field by field rather than the whole file refused. */
function readServer(value: unknown): ServerPairing | null {
  if (!object(value) || !color(value.color)) return null
  const pairs: Record<string, string> = {}
  if (object(value.pairs))
    for (const [server, local] of Object.entries(value.pairs))
      if (text(server) && text(local) && Object.keys(pairs).length < MAX_PAIRS)
        pairs[server] = local
  const declined = Array.isArray(value.declined)
    ? value.declined.filter((id): id is string => text(id)).slice(0, MAX_DECLINED)
    : []
  return {
    ...(typeof value.combine === 'boolean' ? { combine: value.combine } : {}),
    color: value.color,
    pairs,
    declined
  }
}

/**
 * The pairings of this Mac's workspaces with the workspaces of its saved
 * servers (PRDCT-4151), one document under the app's data, main's to hold so
 * every window reads the same answer. A confirmed pairing turns the server's
 * switch on when nobody has touched it; a declined proposal is not made
 * again; a switch turned off keeps the pairings for the day it is turned on
 * again. Each server gets the first badge colour no other server wears.
 */
export class ServerPairingRegistry {
  private state: ServerPairings | undefined

  constructor(private readonly ports: SettingsPorts) {}

  load(): ServerPairings {
    if (this.state) return this.state
    let parsed: unknown = null
    try {
      const raw = this.ports.storage.read(DOCUMENT)
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      parsed = null
    }
    const servers: Record<string, ServerPairing> = {}
    if (object(parsed) && object(parsed.servers))
      for (const [serverId, entry] of Object.entries(parsed.servers)) {
        const server = readServer(entry)
        if (text(server ? serverId : '') && server) servers[serverId] = server
      }
    this.state = { version: 1, servers }
    return this.state
  }

  change(change: ServerPairingChange): ServerPairings {
    if (!object(change) || !text(change.serverId)) throw new Error('Name the server.')
    const current = this.load()
    const entry = current.servers[change.serverId] ?? this.fresh(current)
    let next: ServerPairing
    switch (change.kind) {
      case 'confirm': {
        if (!text(change.serverWorkspaceId) || !text(change.localWorkspaceId))
          throw new Error('Name both workspaces of the pairing.')
        if (
          Object.keys(entry.pairs).length >= MAX_PAIRS &&
          !(change.serverWorkspaceId in entry.pairs)
        )
          throw new Error('Too many paired workspaces on this server.')
        next = {
          ...entry,
          // The first pairing confirmed turns the switch on; a switch the
          // person turned off is not turned back on behind their back.
          combine: entry.combine ?? true,
          pairs: { ...entry.pairs, [change.serverWorkspaceId]: change.localWorkspaceId },
          declined: entry.declined.filter((id) => id !== change.serverWorkspaceId)
        }
        break
      }
      case 'decline': {
        if (!text(change.serverWorkspaceId)) throw new Error('Name the server workspace.')
        next = {
          ...entry,
          declined: [
            ...entry.declined.filter((id) => id !== change.serverWorkspaceId),
            change.serverWorkspaceId
          ].slice(-MAX_DECLINED)
        }
        break
      }
      case 'forget': {
        if (!text(change.serverWorkspaceId)) throw new Error('Name the server workspace.')
        const pairs = { ...entry.pairs }
        delete pairs[change.serverWorkspaceId]
        next = { ...entry, pairs }
        break
      }
      case 'ask-again': {
        if (!text(change.serverWorkspaceId)) throw new Error('Name the server workspace.')
        next = {
          ...entry,
          declined: entry.declined.filter((id) => id !== change.serverWorkspaceId)
        }
        break
      }
      case 'combine': {
        if (typeof change.on !== 'boolean') throw new Error('Say whether the switch is on.')
        // Turned on by hand, the person wants pairings: what they declined
        // before is proposed again (verifier, round 1).
        next = { ...entry, combine: change.on, declined: change.on ? [] : entry.declined }
        break
      }
      default:
        throw new Error('Unknown pairing change.')
    }
    const state: ServerPairings = {
      version: 1,
      servers: { ...current.servers, [change.serverId]: next }
    }
    this.ports.storage.write(DOCUMENT, JSON.stringify(state, null, 2))
    this.state = state
    return state
  }

  /** A server's entry before it has one: no switch answered, no pair, the
   *  first colour no other server wears. */
  private fresh(current: ServerPairings): ServerPairing {
    const worn = new Set(Object.values(current.servers).map((s) => s.color))
    const free = SERVER_PAIRING_COLORS.find((c) => !worn.has(c))
    return {
      color:
        free ??
        SERVER_PAIRING_COLORS[Object.keys(current.servers).length % SERVER_PAIRING_COLORS.length],
      pairs: {},
      declined: []
    }
  }
}

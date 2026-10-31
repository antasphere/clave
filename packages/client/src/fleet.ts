import type {
  ServerConnectionStatus,
  ServerId,
  SessionRef,
  Sourced
} from '../../contract/src/fleet'
import type { ServerEventEnvelope } from '@clave/contract/events'
import type { SessionStream } from '@clave/contract/sessions'
import type { ViewRequest } from '@clave/contract/views'
import type { Backing, Endpoint } from './router'

export interface FleetClientOptions {
  readonly resolve: (serverId: ServerId) => Promise<Endpoint | null>
  /** Hands over a backing whose push socket is not open yet: the frames a
   *  server sends at the welcome (a server's workspace list, #241) reach only
   *  the listeners attached before it, and the fleet attaches them here. */
  readonly connect: (endpoint: Endpoint, serverId: ServerId) => Backing | Promise<Backing>
  readonly timeoutMs?: number
}
export interface FleetClient {
  connect(serverId: ServerId): Promise<Backing>
  backing(serverId: ServerId): Promise<Backing>
  disconnect(serverId: ServerId): Promise<void>
  remove(serverId: ServerId): Promise<void>
  list(): ServerConnectionStatus[]
  onStatus(listener: (status: ServerConnectionStatus) => void): () => void
  onEvent(listener: (event: Sourced<ServerEventEnvelope>) => void): () => void
  onRequest(listener: (request: Sourced<ViewRequest>) => void): () => void
  subscribe(
    ref: SessionRef,
    onStream: (stream: Sourced<SessionStream>) => void,
    onExit?: (exit: Sourced<number>) => void
  ): Promise<() => void>
  close(): Promise<void>
}

interface Entry {
  status: ServerConnectionStatus
  accepting: boolean
  pending?: Promise<Backing>
  backing?: Backing
  cancel?: () => void
  timer?: ReturnType<typeof setTimeout>
  off: Set<() => void>
}

/** One transport and retry loop per owner. Only PushClient retries network
 * connections. Application commands are never retried here. A late factory
 * result is closed rather than reviving a cancelled connection. */
export function createFleetClient(options: FleetClientOptions): FleetClient {
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)
    throw new Error('Fleet timeout must be between 1 and 60000 milliseconds.')
  const entries = new Map<ServerId, Entry>()
  const statuses = new Set<(status: ServerConnectionStatus) => void>()
  const events = new Set<(event: Sourced<ServerEventEnvelope>) => void>()
  const requests = new Set<(request: Sourced<ViewRequest>) => void>()
  let closed = false
  const safely = (run: () => void): void => {
    try {
      run()
    } catch {
      /* isolate consumers */
    }
  }
  const active = (id: ServerId, entry: Entry): boolean =>
    !closed && entries.get(id) === entry && entry.accepting
  const publish = (entry: Entry, status: ServerConnectionStatus): void => {
    entry.status = status
    for (const listener of statuses) safely(() => listener({ ...status }))
  }
  const clearWatch = (entry: Entry): void => {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
  }
  const watchWelcome = (id: ServerId, entry: Entry): void => {
    if (entry.timer !== undefined) return
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (active(id, entry))
        publish(entry, { serverId: id, state: 'offline', error: 'unreachable' })
    }, timeoutMs)
  }
  const dispose = async (backing: Backing): Promise<void> => {
    // Neither adapter errors nor server-supplied messages reach public status.
    safely(() => backing.push.close())
    try {
      await backing.api.dispose()
    } catch {
      /* all other owners still close */
    }
  }
  const offAll = (entry: Entry): void => {
    for (const off of entry.off) safely(off)
    entry.off.clear()
  }
  const disconnect = async (id: ServerId): Promise<void> => {
    const entry = entries.get(id)
    if (!entry) return
    entry.accepting = false
    entry.cancel?.()
    clearWatch(entry)
    offAll(entry)
    const backing = entry.backing
    entry.backing = undefined
    publish(entry, { serverId: id, state: 'disconnected' })
    if (backing) await dispose(backing)
  }
  const connect = (id: ServerId): Promise<Backing> => {
    if (closed) return Promise.reject(new Error('This fleet client is closed.'))
    if (typeof id !== 'string' || !id.length)
      return Promise.reject(new Error('A server owner is required.'))
    const old = entries.get(id)
    if (old?.accepting && old.status.state !== 'unauthorized') return old.pending!
    if (old?.backing) return disconnect(id).then(() => connect(id))
    const entry: Entry = {
      accepting: true,
      status: { serverId: id, state: 'connecting' },
      off: new Set()
    }
    entries.set(id, entry)
    let credentialsUnavailable = false
    const cancelled = new Promise<never>((_resolve, reject) => {
      entry.cancel = () => reject(new Error('Server connection cancelled.'))
    })
    let deadline: ReturnType<typeof setTimeout>
    const expired = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('Server connection timed out.')), timeoutMs)
    })
    const acquire = Promise.resolve().then(async (): Promise<Backing> => {
      const endpoint = await options.resolve(id)
      if (!active(id, entry)) throw new Error('Server connection cancelled.')
      if (!endpoint) {
        credentialsUnavailable = true
        throw new Error('Server credentials unavailable.')
      }
      const backing = await options.connect(endpoint, id)
      if (!active(id, entry)) {
        await dispose(backing)
        throw new Error('Server connection cancelled.')
      }
      return backing
    })
    entry.pending = Promise.race([acquire, cancelled, expired])
      .then((backing) => {
        if (!active(id, entry)) {
          void dispose(backing)
          throw new Error('Server connection cancelled.')
        }
        entry.backing = backing
        entry.off.add(
          backing.push.onStatus((state, detail) => {
            if (!active(id, entry)) return
            if (state === 'open') {
              clearWatch(entry)
              publish(entry, { serverId: id, state: 'connected' })
            } else if (detail.final === 'unauthorized') {
              clearWatch(entry)
              publish(entry, { serverId: id, state: 'unauthorized', error: 'unauthorized' })
            } else if (state === 'connecting' || state === 'reconnecting') {
              publish(entry, {
                serverId: id,
                state,
                ...(state === 'reconnecting' && { error: 'unreachable' as const }),
                ...(detail.attempt !== undefined && { attempt: detail.attempt })
              })
              watchWelcome(id, entry)
            } else if (state === 'closed') {
              clearWatch(entry)
              publish(entry, { serverId: id, state: 'offline', error: 'unreachable' })
            }
          })
        )
        entry.off.add(
          backing.push.onEvent((value) => {
            if (active(id, entry))
              for (const listener of events) safely(() => listener({ serverId: id, value }))
          })
        )
        entry.off.add(
          backing.push.onRequest((value) => {
            if (active(id, entry))
              for (const listener of requests) safely(() => listener({ serverId: id, value }))
          })
        )
        watchWelcome(id, entry)
        backing.push.connect()
        // A factory may have opened the socket before handing it over. Its
        // welcome then predates our listener and must not be lost.
        if (backing.push.status === 'open') {
          clearWatch(entry)
          publish(entry, { serverId: id, state: 'connected' })
        }
        return backing
      })
      .catch(async () => {
        if (active(id, entry)) {
          entry.accepting = false
          clearWatch(entry)
          offAll(entry)
          const backing = entry.backing
          entry.backing = undefined
          publish(entry, {
            serverId: id,
            state: 'offline',
            error: credentialsUnavailable ? 'credentials-unavailable' : 'unreachable'
          })
          if (backing) await dispose(backing)
        }
        throw new Error('Could not connect to the owning Clave server.')
      })
      .finally(() => {
        clearTimeout(deadline!)
        entry.cancel = undefined
      })
    publish(entry, entry.status)
    return entry.pending
  }
  const backing = (id: ServerId): Promise<Backing> => {
    const entry = entries.get(id)
    if (!entry?.accepting || entry.status.state === 'unauthorized')
      return Promise.reject(new Error('The owning Clave server is not connected.'))
    return entry.pending!
  }
  const listen = <T>(
    listeners: Set<(value: T) => void>,
    listener: (value: T) => void
  ): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return {
    connect,
    backing,
    disconnect,
    remove: async (id) => {
      const entry = entries.get(id)
      await disconnect(id)
      if (entries.get(id) === entry) entries.delete(id)
    },
    list: () => [...entries.values()].map((entry) => ({ ...entry.status })),
    onStatus: (listener) => listen(statuses, listener),
    onEvent: (listener) => listen(events, listener),
    onRequest: (listener) => listen(requests, listener),
    subscribe: async (ref, onStream, onExit) => {
      const current = await backing(ref.serverId)
      const entry = entries.get(ref.serverId)!
      if (!active(ref.serverId, entry) || entry.backing !== current)
        throw new Error('The owning Clave server was disconnected.')
      const off = current.push.subscribe(
        ref.sessionId,
        (value) => {
          if (active(ref.serverId, entry)) onStream({ serverId: ref.serverId, value })
        },
        onExit
          ? (value) => {
              if (active(ref.serverId, entry)) onExit({ serverId: ref.serverId, value })
            }
          : undefined
      )
      const release = (): void => {
        entry.off.delete(release)
        off()
      }
      entry.off.add(release)
      return release
    },
    close: async () => {
      closed = true
      await Promise.all([...entries.keys()].map(disconnect))
      entries.clear()
      statuses.clear()
      events.clear()
      requests.clear()
    }
  }
}

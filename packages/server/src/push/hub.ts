/**
 * The push hub: every WebSocket peer, what each one is subscribed to, and
 * the fan-out of session frames and server events. Transport-agnostic on
 * purpose: it is handed a socket that can send text and close, and it is
 * handed every text the socket received. `route.ts` binds it to the
 * platform's socket; a Bun binding is the same two calls. The protocol is
 * `@clave/contract/push`.
 */
import {
  CLOSE_HELLO_TIMEOUT,
  CLOSE_MALFORMED,
  CLOSE_UNAUTHORIZED,
  HELLO_TIMEOUT_MS,
  PUSH_PROTOCOL,
  type ServerFrame,
  decodeClientFrame,
  encodeServerFrame
} from '@clave/contract/push'
import { CLOSE_DEVICE_REVOKED } from '@clave/contract/devices'
import { Either } from 'effect'
import { safeEqual } from '../auth'
import type { ServerEventsService } from '../events'
import type { SessionStreamSource, Unsubscribe } from '../sessions/port'
// ── Mobile wave, lane A: a phone's socket ──
import { deviceHearsEvent } from '../devices/scope'

export interface PushSocket {
  send(text: string): void
  close(code: number, reason?: string): void
}

export interface PushPeer {
  onMessage(text: string): void
  onClose(): void
}

export interface PushHubOptions {
  readonly token: string
  readonly serverId: string
  readonly source: SessionStreamSource
  readonly events: ServerEventsService
  readonly helloTimeoutMs?: number
  /** The Clave version the welcome names (issue #266); none when unknown. */
  readonly version?: () => string | undefined
  // ── Mobile wave, lane A: a phone's device session in the hello frame ──
  /** The devices domain: a hello token that is not the server's may be a
   *  phone's session; a revoked phone's sockets are closed from here. */
  readonly devices?: {
    readonly authenticate: (presented: string) => { readonly deviceId: string } | null
    readonly touch: (deviceId: string) => void
    readonly onRevoked: (listener: (deviceId: string) => void) => Unsubscribe
  }
}

interface Peer {
  readonly socket: PushSocket
  welcomed: boolean
  helloTimer: ReturnType<typeof setTimeout> | null
  readonly subscriptions: Map<string, Unsubscribe>
  closed: boolean
  /** The phone this socket belongs to, when it said hello with a device session. */
  deviceId: string | null
}

export class PushHub {
  private readonly peers = new Set<Peer>()
  private readonly offEvents: Unsubscribe
  // ── Lane D (wave 3): the view requests ──
  private readonly welcomeListeners = new Set<(send: (frame: ServerFrame) => void) => void>()

  // ── Mobile wave, lane A ──
  private readonly offRevoked: Unsubscribe

  constructor(private readonly options: PushHubOptions) {
    this.offEvents = options.events.subscribe((envelope) =>
      this.broadcast({ _tag: 'event', ...envelope })
    )
    // A revoked phone's sockets end at once, with the code that says why.
    this.offRevoked =
      options.devices?.onRevoked((deviceId) => this.closeDevice(deviceId)) ?? (() => {})
  }

  /** The sockets of one phone, closed (its session was revoked). */
  closeDevice(deviceId: string): void {
    for (const peer of [...this.peers])
      if (peer.deviceId === deviceId) this.close(peer, CLOSE_DEVICE_REVOKED, 'device revoked')
  }

  /** Peers that said hello with the right token. */
  get connections(): number {
    return [...this.peers].filter((peer) => peer.welcomed).length
  }

  attach(socket: PushSocket): PushPeer {
    const peer: Peer = {
      socket,
      welcomed: false,
      helloTimer: null,
      subscriptions: new Map(),
      closed: false,
      deviceId: null
    }
    this.peers.add(peer)
    peer.helloTimer = setTimeout(() => {
      if (!peer.welcomed) this.close(peer, CLOSE_HELLO_TIMEOUT, 'no hello')
    }, this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS)
    return {
      onMessage: (text) => this.receive(peer, text),
      onClose: () => this.release(peer)
    }
  }

  /** Close every peer, the way a stopping server does. */
  closeAll(code: number, reason: string): void {
    for (const peer of [...this.peers]) this.close(peer, code, reason)
  }

  dispose(): void {
    this.offEvents()
    this.offRevoked()
    this.closeAll(1001, 'hub disposed')
  }

  private receive(peer: Peer, text: string): void {
    if (peer.closed) return
    try {
      this.handle(peer, text)
    } catch (error) {
      // Nothing a peer sends may take the server down: a source that throws
      // ends that peer's connection, with its listeners detached, and the
      // hub goes on serving the others.
      console.error('[clave-server] push peer failed', error)
      this.close(peer, 1011, 'server error')
    }
  }

  private handle(peer: Peer, text: string): void {
    const decoded = decodeClientFrame(text)
    if (Either.isLeft(decoded)) {
      if (!peer.welcomed) return this.close(peer, CLOSE_MALFORMED, 'malformed frame')
      return this.send(peer, { _tag: 'error', message: 'Malformed frame' })
    }
    const frame = decoded.right
    if (!peer.welcomed) {
      if (frame._tag !== 'hello') return this.close(peer, CLOSE_MALFORMED, 'hello first')
      if (!safeEqual(frame.token, this.options.token)) {
        // ── Mobile wave, lane A: a phone's device session, told apart by hash ──
        const device = this.options.devices?.authenticate(frame.token) ?? null
        if (!device) return this.close(peer, CLOSE_UNAUTHORIZED, 'unauthorized')
        peer.deviceId = device.deviceId
        this.options.devices!.touch(device.deviceId)
      }
      peer.welcomed = true
      if (peer.helloTimer) clearTimeout(peer.helloTimer)
      peer.helloTimer = null
      const version = this.options.version?.()
      this.send(peer, {
        _tag: 'welcome',
        serverId: this.options.serverId,
        protocol: PUSH_PROTOCOL,
        ...(version !== undefined && { version })
      })
      for (const listener of [...this.welcomeListeners]) listener((frame) => this.send(peer, frame))
      return
    }
    switch (frame._tag) {
      case 'hello':
        return this.send(peer, { _tag: 'error', message: 'Already welcomed' })
      case 'ping':
        return this.send(peer, { _tag: 'pong' })
      case 'subscribe':
        return this.subscribe(peer, frame.sessionId)
      case 'unsubscribe':
        peer.subscriptions.get(frame.sessionId)?.()
        peer.subscriptions.delete(frame.sessionId)
        return this.send(peer, { _tag: 'unsubscribed', sessionId: frame.sessionId })
    }
  }

  private subscribe(peer: Peer, sessionId: string): void {
    const session = this.options.source.get(sessionId)
    if (!session) return this.send(peer, { _tag: 'error', sessionId, message: 'Unknown session' })
    // Subscribing twice is one subscription: the second answer repeats the record.
    if (!peer.subscriptions.has(sessionId)) {
      const offStream = this.options.source.subscribe(sessionId, (stream) =>
        this.send(peer, { _tag: 'stream', sessionId, stream })
      )
      let offExit: Unsubscribe
      try {
        offExit = this.options.source.subscribeExit(sessionId, (code) => {
          this.send(peer, { _tag: 'exit', sessionId, code })
          peer.subscriptions.get(sessionId)?.()
          peer.subscriptions.delete(sessionId)
        })
      } catch (error) {
        // Half a subscription is none: the stream listener goes too.
        offStream()
        throw error
      }
      peer.subscriptions.set(sessionId, () => {
        offStream()
        offExit()
      })
    }
    this.send(peer, { _tag: 'subscribed', sessionId, session })
  }

  private broadcast(frame: ServerFrame): void {
    this.publishFrame(frame)
  }

  // ── Mobile wave, lane A ──
  /** Whether a frame is for this peer: everything for a desktop client; for
   *  a phone, the events of its own domains and no view request frame. */
  private hears(peer: Peer, frame: ServerFrame): boolean {
    if (peer.deviceId === null) return true
    return frame._tag === 'event' ? deviceHearsEvent(frame.event._tag) : frame._tag !== 'request'
  }

  // ── Lane D (wave 3): the view requests ──
  /**
   * Send one frame to every welcomed peer. The view requests go out through
   * here: they are not server events (a request is a question, not a fact,
   * and never enters the event store), and the hub does not know which
   * socket is which window, so every peer gets it and only the named window
   * answers.
   */
  publishFrame(frame: ServerFrame): void {
    for (const peer of [...this.peers]) if (peer.welcomed) this.send(peer, frame)
  }

  /**
   * Told of every peer the moment it is welcomed, with a sender for that peer
   * alone: what a request still waiting for its window uses to reach a window
   * whose socket opened after the request went out (a window just opened, a
   * socket reconnecting).
   */
  onWelcome(listener: (send: (frame: ServerFrame) => void) => void): Unsubscribe {
    this.welcomeListeners.add(listener)
    return () => {
      this.welcomeListeners.delete(listener)
    }
  }

  private send(peer: Peer, frame: ServerFrame): void {
    // Apply the scope to every path, including a welcome listener replaying
    // requests that were already pending before this socket connected.
    if (peer.closed || !this.hears(peer, frame)) return
    try {
      peer.socket.send(encodeServerFrame(frame))
    } catch (error) {
      console.error('[clave-server] push send failed', error)
    }
  }

  private close(peer: Peer, code: number, reason: string): void {
    if (peer.closed) return
    this.release(peer)
    try {
      peer.socket.close(code, reason)
    } catch {
      /* the socket is already gone */
    }
  }

  private release(peer: Peer): void {
    peer.closed = true
    if (peer.helloTimer) clearTimeout(peer.helloTimer)
    peer.helloTimer = null
    for (const off of peer.subscriptions.values()) off()
    peer.subscriptions.clear()
    this.peers.delete(peer)
  }
}

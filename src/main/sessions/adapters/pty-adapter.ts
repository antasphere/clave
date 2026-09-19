import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import type { SessionAdapter, SessionAdapterEvents, SessionHandle, SpawnSpec } from '../adapter'
import type { UserMessage } from '../../../shared/session-model'
import { ptyBackend, type PtySpawnOptions, type PtySession } from './pty-backend'

/** The existing launch-profile / tmux engine, with a multicast stream boundary.
 * Preparation stays synchronous; resize starts the process at xterm's real size. */
export class PtyAdapter implements SessionAdapter {
  readonly id = 'pty'
  readonly provider = '*'
  readonly transports = ['pty'] as const
  private channels = new Map<string, EventEmitter>()
  private decoders = new Map<string, StringDecoder>()

  prepare(cwd: string, options?: PtySpawnOptions): PtySession {
    if (options?.adoptSessionId && ptyBackend.getSession(options.adoptSessionId)) {
      throw new Error(`PTY session already exists: ${options.adoptSessionId}`)
    }
    const session = ptyBackend.spawn(cwd, options)
    const channel = new EventEmitter()
    this.channels.set(session.id, channel)
    this.decoders.set(session.id, new StringDecoder('utf8'))
    ptyBackend.attachListeners(
      session.id,
      (data) => {
        channel.emit('stream', { kind: 'pty', data: new TextEncoder().encode(data) })
      },
      (code) => {
        channel.emit('exit', code)
      }
    )
    return session
  }

  async spawn(spec: SpawnSpec): Promise<SessionHandle> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(spec.id)) {
      throw new Error('PTY session ids must be UUIDs')
    }
    if (
      !['terminal', 'claude', 'claude-agents', 'codex', 'antigravity', 'pi'].includes(spec.provider)
    ) {
      throw new Error(`Unsupported PTY provider: ${spec.provider}`)
    }
    return this.prepare(spec.cwd, {
      ...(spec.options as PtySpawnOptions),
      claudeMode: spec.provider === 'claude',
      claudeAgentsMode: spec.provider === 'claude-agents',
      codexMode: spec.provider === 'codex',
      antigravityMode: spec.provider === 'antigravity',
      piMode: spec.provider === 'pi',
      adoptSessionId: spec.id,
      windowKey: spec.windowKey
    })
  }

  async attach(sessionId: string): Promise<SessionHandle> {
    const session = ptyBackend.getSession(sessionId)
    if (!session) throw new Error(`Unknown PTY session: ${sessionId}`)
    return session
  }

  write(handle: SessionHandle, input: Uint8Array | UserMessage): void {
    const text =
      input instanceof Uint8Array
        ? (this.decoders.get(handle.id)?.write(Buffer.from(input)) ?? '')
        : input.text + '\r'
    if (text) ptyBackend.write(handle.id, text)
  }

  resize(handle: SessionHandle, cols: number, rows: number): void {
    ptyBackend.resize(handle.id, cols, rows)
  }

  kill(handle: SessionHandle): void {
    ptyBackend.kill(handle.id)
    this.channels.get(handle.id)?.emit('exit', 0)
    this.channels.delete(handle.id)
    this.decoders.delete(handle.id)
  }

  /** App shutdown detaches the tmux client without destroying its agent. */
  detach(handle: SessionHandle): void {
    this.channels.get(handle.id)?.removeAllListeners()
    ptyBackend.kill(handle.id, false)
    this.channels.delete(handle.id)
    this.decoders.delete(handle.id)
  }

  on<K extends keyof SessionAdapterEvents>(
    handle: SessionHandle,
    event: K,
    cb: (value: SessionAdapterEvents[K]) => void
  ): () => void {
    const channel = this.channels.get(handle.id)
    if (!channel) throw new Error(`Unknown PTY session: ${handle.id}`)
    channel.on(event, cb)
    return () => {
      channel.off(event, cb)
    }
  }
}

export const ptyAdapter = new PtyAdapter()

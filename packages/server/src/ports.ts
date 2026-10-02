/**
 * The ports: what the server needs from whoever runs it. In this wave the
 * server runs inside Electron main and the shell implements these over the
 * managers it already has (the session manager first); a later lane moves an
 * implementation into the server and the port stays as the seam.
 */
import { Context, Layer } from 'effect'
import type { Session, SessionStream, SessionWrite } from '@clave/contract/sessions'

export type Unsubscribe = () => void

/** Where sessions live today: a synchronous registry the shell owns. */
export interface SessionSourceService {
  /** Every session, or those of one window when `windowKey` is given. */
  readonly list: (windowKey?: string) => ReadonlyArray<Session>
  readonly get: (id: string) => Session | undefined
  /** Frames of a session as they come; throws when the session is unknown. */
  readonly subscribe: (id: string, listener: (stream: SessionStream) => void) => Unsubscribe
  /** The session's exit code, once; throws when the session is unknown. */
  readonly subscribeExit: (id: string, listener: (code: number) => void) => Unsubscribe
  /** Hand the session a typed input or terminal bytes; throws when it is unknown. */
  readonly write: (id: string, input: SessionWrite) => void
}

export class SessionSource extends Context.Tag('@clave/server/SessionSource')<
  SessionSource,
  SessionSourceService
>() {
  static layer(service: SessionSourceService): Layer.Layer<SessionSource> {
    return Layer.succeed(SessionSource, service)
  }
  /** A source with no sessions: a server with nothing attached, and the tests' default. */
  static readonly empty: SessionSourceService = {
    list: () => [],
    get: () => undefined,
    subscribe: (id) => {
      throw new Error(`Unknown session: ${id}`)
    },
    subscribeExit: (id) => {
      throw new Error(`Unknown session: ${id}`)
    },
    write: (id) => {
      throw new Error(`Unknown session: ${id}`)
    }
  }
}

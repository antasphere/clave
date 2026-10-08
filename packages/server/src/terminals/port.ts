/**
 * The terminals port: how a session's process is obtained, by whoever runs
 * the server. Inside the app the shell gives it node-pty in its own process
 * (`src/main/ports/terminal.ts`); the standalone Bun server, which cannot
 * run node-pty, runs on `Terminals.none` until its Node terminal process
 * exists (wave 3), and a spawn then says what is missing with the declared
 * `CapabilityUnavailable`. No handler reads it in this wave: the sessions
 * port starts sessions through the shell's own terminal layer. It is here so
 * the terminal process has one seam to implement, shaped for a wire: the
 * spec carries strings and numbers, the output is text, the exit a code, and
 * nothing of node-pty crosses it.
 */
import { Context, Layer } from 'effect'
import { CapabilityUnavailable } from '@clave/contract/errors'

export interface TerminalSpawn {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly cols: number
  readonly rows: number
  /** The terminal name advertised to the process (`xterm-256color`). */
  readonly name?: string
}

export interface TerminalExit {
  readonly exitCode: number
  readonly signal?: number
}

export interface TerminalProcess {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  /** Output as the process produces it. Returns the way to stop listening. */
  onData(listener: (data: string) => void): () => void
  /** The end of the process, once. Returns the way to stop listening. */
  onExit(listener: (exit: TerminalExit) => void): () => void
}

export interface TerminalsService {
  /** Start a process; throws `CapabilityUnavailable` when this server has
   *  no terminal process, with any other error when the spawn itself failed. */
  spawn(spec: TerminalSpawn): TerminalProcess
  /** Whether the terminals can be reached right now. A port over a wire
   *  answers for the process at the other end (`grpc.ts`), and the server
   *  reports it as the `terminals` check of its readiness; a port in this
   *  process has nothing to ask and leaves it out. */
  ready?(): Promise<boolean>
}

const NO_TERMINALS = new CapabilityUnavailable({
  capability: 'terminals',
  message:
    'This server runs no terminals: a standalone Clave server gets its terminal process in the next wave.'
})

export class Terminals extends Context.Tag('@clave/server/Terminals')<
  Terminals,
  TerminalsService
>() {
  static layer(service: TerminalsService): Layer.Layer<Terminals> {
    return Layer.succeed(Terminals, service)
  }
  /** A server with no terminal process: every spawn says what is missing. */
  static readonly none: TerminalsService = {
    spawn: () => {
      throw NO_TERMINALS
    }
  }
}

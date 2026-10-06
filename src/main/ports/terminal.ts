/**
 * The terminal port: how the terminal backend gets a process. The backend
 * plans a spawn (which file, which arguments, in which directory, with which
 * environment) and hands the plan here; what comes back is the running
 * process as four verbs and two events. node-pty is the one adapter today,
 * inside the app's Node process.
 *
 * Shaped for the process on the other side of a socket that wave 3 brings
 * (a Node process beside the standalone Bun server, which cannot run
 * node-pty): nothing of node-pty crosses this boundary. The spec carries
 * strings and numbers only, the data is text, the exit is a code, so the
 * same interface can be served over a wire without a type changing.
 */

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

export interface TerminalPort {
  spawn(spec: TerminalSpawn): TerminalProcess
}

/** node-pty, loaded on the first spawn: the native module stays out of the
 *  module graph of whoever only reads the port's types, and a process that
 *  never spawns a terminal (a test, the standalone server) never loads it. */
export function nodePtyTerminals(): TerminalPort {
  let pty: typeof import('node-pty') | null = null
  return {
    spawn(spec) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      pty ??= require('node-pty') as typeof import('node-pty')
      const process = pty.spawn(spec.file, [...spec.args], {
        name: spec.name,
        cols: Math.max(1, spec.cols),
        rows: Math.max(1, spec.rows),
        cwd: spec.cwd,
        env: { ...spec.env }
      })
      return {
        pid: process.pid,
        write: (data) => process.write(data),
        resize: (cols, rows) => process.resize(Math.max(1, cols), Math.max(1, rows)),
        kill: (signal) => process.kill(signal),
        onData: (listener) => process.onData(listener).dispose,
        onExit: (listener) => process.onExit(listener).dispose
      }
    }
  }
}

import type { TerminalsService } from '@clave/server'

/**
 * The terminal port: how the terminal backend gets a process. The backend
 * plans a spawn (which file, which arguments, in which directory, with which
 * environment) and hands the plan here; what comes back is the running
 * process as four verbs and two events. node-pty is the one adapter today,
 * inside the app's Node process.
 *
 * The shapes are the server's (`packages/server/src/terminals/port.ts`, the
 * `Terminals` port an entry gives the server): the in-process app gives it
 * this adapter, the standalone server runs on `Terminals.none` until the
 * Node terminal process of wave 3 implements the same interface over a
 * wire. Nothing of node-pty crosses it: the spec carries strings and
 * numbers only, the data is text, the exit is a code.
 */

export type { TerminalExit, TerminalProcess, TerminalSpawn } from '@clave/server'
export type TerminalPort = TerminalsService

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

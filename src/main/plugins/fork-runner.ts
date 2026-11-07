/**
 * The plugin runner forked by a server running outside Electron (PRDCT-3433):
 * `child_process.fork` with Node's IPC channel carrying the JSON-RPC, the
 * first message naming the plugin's `main` (`plugin-runner.ts` takes either
 * road). Measured on 12 October 2026: a round trip of 12 ms under the
 * repository's Bun 1.4.1 and 27 ms under Node. `serialization: 'json'` keeps
 * the channel readable by a Node child whatever runs the parent.
 */
import { fork, type Serializable } from 'node:child_process'
import type { RunnerProcess, RunnerSpawner } from './plugin-host'

export interface ForkRunnerOptions {
  /** The runner file: the source under Bun, the built bundle under Node. */
  readonly runner: string
  /** The binary that runs it; the parent's own when absent. */
  readonly execPath?: string
}

export function forkRunner(options: ForkRunnerOptions): RunnerSpawner {
  return ({ main, cwd, env }): RunnerProcess => {
    const child = fork(options.runner, [], {
      cwd,
      env,
      serialization: 'json',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      ...(options.execPath !== undefined && { execPath: options.execPath })
    })
    const messages = new Set<(message: unknown) => void>()
    const exits = new Set<(code: number | null) => void>()
    const outputs = new Set<(stream: 'stdout' | 'stderr', text: string) => void>()
    let ended = false
    const end = (code: number | null): void => {
      if (ended) return
      ended = true
      for (const listener of exits) listener(code)
    }
    child.stdout?.on('data', (data) => {
      for (const listener of outputs) listener('stdout', String(data))
    })
    child.stderr?.on('data', (data) => {
      for (const listener of outputs) listener('stderr', String(data))
    })
    child.on('message', (message) => {
      for (const listener of messages) listener(message)
    })
    child.on('exit', (code) => end(code))
    // A process that could not be started at all ends the same way: the host
    // reads an exit, restarts with backoff and records the reason.
    child.on('error', (error) => {
      for (const listener of outputs) listener('stderr', `runner failed: ${error.message}`)
      end(null)
    })
    child.send({ main })
    return {
      postMessage: (message) => {
        if (!child.connected) throw new Error('The plugin runner has closed its channel')
        child.send(message as Serializable)
      },
      onMessage: (listener) => {
        messages.add(listener)
      },
      onExit: (listener) => {
        exits.add(listener)
      },
      onOutput: (listener) => {
        outputs.add(listener)
      },
      kill: () => {
        child.kill()
      }
    }
  }
}

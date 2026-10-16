/**
 * The plugin runner spawned by Electron main: a `utilityProcess` per plugin,
 * its JSON-RPC riding a MessagePort the runner receives in its first message
 * (`plugin-runner.ts`). This is the one file of the plugin host that imports
 * Electron; the host itself speaks to the process through `RunnerProcess`,
 * so the standalone server forks the same runner another way
 * (`fork-runner.ts`).
 */
import { MessageChannelMain, utilityProcess } from 'electron'
import { join } from 'node:path'
import type { RunnerProcess, RunnerSpawner } from './plugin-host'

export function electronRunner(runner = join(__dirname, 'plugin-runner.js')): RunnerSpawner {
  return ({ id, main, cwd, env }): RunnerProcess => {
    const { port1, port2 } = new MessageChannelMain()
    const child = utilityProcess.fork(runner, [], {
      cwd,
      env,
      stdio: 'pipe',
      serviceName: `Clave plugin: ${id}`
    })
    const messages = new Set<(message: unknown) => void>()
    const exits = new Set<(code: number | null) => void>()
    const outputs = new Set<(stream: 'stdout' | 'stderr', text: string) => void>()
    child.stdout?.on('data', (data) => {
      for (const listener of outputs) listener('stdout', String(data))
    })
    child.stderr?.on('data', (data) => {
      for (const listener of outputs) listener('stderr', String(data))
    })
    port1.on('message', (event) => {
      for (const listener of messages) listener(event.data)
    })
    port1.start()
    child.on('exit', (code) => {
      port1.close()
      for (const listener of exits) listener(code)
    })
    child.postMessage({ main }, [port2])
    return {
      postMessage: (message) => port1.postMessage(message),
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

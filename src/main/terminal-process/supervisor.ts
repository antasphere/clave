/**
 * The terminal process, owned and kept alive by the server that uses it
 * (ADR 0003, wave 5, PRDCT-3434). Wave 3 left a process down for good: the
 * server's port over the wire (`packages/server/src/terminals/grpc.ts`)
 * marks it gone on the first UNAVAILABLE and nothing starts another. Here
 * the server entry starts the process itself (`spawnTerminalProcess`, from
 * the bundle electron-vite writes, under the executable it is told: Node for
 * the dev script and the harness, the app's own binary as Node inside the
 * package) and SUPERVISES it: when the child exits, or the port finds it
 * gone, the terminals it held end with the lost exit the port already
 * reports, a new process is started, a new port is built over it, and new
 * spawns go there; readiness asks the current port, so it answers false
 * while the process is being started again and true once the new one pings.
 *
 * A process that keeps dying is not started forever: more than `maxRestarts`
 * deaths within `windowMs` and the supervisor gives up, says so in the log,
 * answers not ready, and refuses every spawn with the reason, which is what
 * the window shows. A start that fails (the bundle missing, an announce
 * timeout) counts as a death.
 *
 * The first start is awaited by the caller and its failure is the caller's:
 * a server told to run a terminal process that cannot start must not come
 * up on no terminals and look like a server.
 *
 * Nothing here imports Electron.
 */
import { CapabilityUnavailable } from '@clave/contract/errors'
import {
  grpcTerminals,
  type GrpcTerminals,
  type TerminalProcess,
  type TerminalSpawn,
  type TerminalsService
} from '@clave/server'
import { exitOf, startAnnouncing, stopChild } from './announcing'
import { RUN_AS_NODE_ENV } from './token-env'

/** A terminal process started, as the supervisor sees it. */
export interface StartedTerminalProcess {
  readonly address: string
  readonly token: string
  readonly pid: number
  /** Resolves with the exit code or the signal, however the process ends. */
  readonly exited: Promise<number | string | null>
  /** SIGTERM, then SIGKILL; resolves once it is gone. */
  readonly stop: () => Promise<void>
}

export interface SpawnTerminalProcessOptions {
  /** The executable that runs the bundle: Node, or the app's own binary,
   *  which the environment below makes run as Node. */
  readonly exec: string
  /** `out/main/terminal-process.js`, wherever the build or the asar holds it. */
  readonly bundle: string
  /** The pid whose end stops the process (`--parent`), this process's. */
  readonly parent?: number
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  readonly killAfterMs?: number
  readonly log?: (line: string) => void
}

export const TERMINAL_PROCESS_ANNOUNCE_TIMEOUT_MS = 15_000
export const TERMINAL_PROCESS_KILL_AFTER_MS = 5_000

/**
 * Start the terminal process from its bundle and resolve once it announced
 * itself. `ELECTRON_RUN_AS_NODE` is set for it whatever `exec` is: an
 * Electron binary needs it to run as Node, plain Node ignores it, and the
 * process takes it out of its own environment at boot (`main.ts`).
 */
export async function spawnTerminalProcess(
  options: SpawnTerminalProcessOptions
): Promise<StartedTerminalProcess> {
  const log = options.log ?? (() => {})
  const { child, announced } = startAnnouncing({
    what: 'the terminal process',
    cmd: options.exec,
    args: [
      options.bundle,
      '--port',
      '0',
      ...(options.parent !== undefined ? ['--parent', String(options.parent)] : [])
    ],
    env: { ...(options.env ?? process.env), [RUN_AS_NODE_ENV]: '1' },
    timeoutMs: options.timeoutMs ?? TERMINAL_PROCESS_ANNOUNCE_TIMEOUT_MS,
    fields: ['address', 'token'],
    onStderr: (line) => log(line)
  })
  const { address, token } = await announced
  return {
    address,
    token,
    pid: child.pid ?? 0,
    exited: exitOf(child),
    stop: () => stopChild(child, options.killAfterMs ?? TERMINAL_PROCESS_KILL_AFTER_MS)
  }
}

export interface SupervisorState {
  /** The current process, or null while one is being started again or once
   *  the supervisor gave up. */
  readonly pid: number | null
  readonly address: string | null
  /** How many processes were started, the first included. */
  readonly generation: number
  /** Why no process will be started again, or null. */
  readonly givenUp: string | null
}

export interface SupervisedTerminals extends TerminalsService {
  ready(): Promise<boolean>
  state(): SupervisorState
  /** Resolves once a restart in progress has ended, started or given up;
   *  at once when none is. */
  settled(): Promise<void>
  close(): Promise<void>
}

export interface SupervisorOptions {
  /** Starts one terminal process; called again after each death. */
  readonly start: () => Promise<StartedTerminalProcess>
  /** Builds the port over a started process; `grpcTerminals` unless a test
   *  gives its own. `onDown` must be called once the port finds the process gone. */
  readonly connect?: (input: {
    address: string
    token: string
    onDown: (why: string) => void
  }) => GrpcTerminals
  readonly log?: (line: string) => void
  /** More deaths than this within `windowMs` and nothing is started again. */
  readonly maxRestarts?: number
  readonly windowMs?: number
  /** Told at every change of the current process, for a discovery file. */
  readonly onChange?: (state: SupervisorState) => void
}

export const MAX_RESTARTS = 3
export const RESTART_WINDOW_MS = 60_000

interface Generation {
  readonly port: GrpcTerminals
  readonly process: StartedTerminalProcess
}

export async function supervisedTerminals(
  options: SupervisorOptions
): Promise<SupervisedTerminals> {
  const log = options.log ?? (() => {})
  const connect =
    options.connect ??
    ((input: { address: string; token: string; onDown: (why: string) => void }) =>
      grpcTerminals({ address: input.address, token: input.token, log, onDown: input.onDown }))
  const maxRestarts = options.maxRestarts ?? MAX_RESTARTS
  const windowMs = options.windowMs ?? RESTART_WINDOW_MS

  let generation = 0
  let current: Generation | null = null
  let restarting: Promise<void> | null = null
  let closing = false
  let givenUp: string | null = null
  const deaths: number[] = []

  const state = (): SupervisorState => ({
    pid: current?.process.pid ?? null,
    address: current?.process.address ?? null,
    generation,
    givenUp
  })
  const changed = (): void => options.onChange?.(state())

  /** Start one process and put its port in place. Throws when it cannot. */
  const boot = async (): Promise<void> => {
    const gen = ++generation
    const started = await options.start()
    if (closing) {
      // Closed while starting: the newcomer goes too.
      await started.stop()
      return
    }
    const port = connect({
      address: started.address,
      token: started.token,
      onDown: (why) => lost(gen, `the port found it gone: ${why}`)
    })
    current = { port, process: started }
    log(`terminal process ${started.pid} started at ${started.address} (generation ${gen})`)
    void started.exited.then((code) => lost(gen, `it exited (${code})`))
    changed()
  }

  /** The process of generation `gen` is gone: end what it held, start another. */
  const lost = (gen: number, why: string): void => {
    if (closing || current === null || gen !== generation) return
    const old = current
    current = null
    log(`terminal process ${old.process.pid} lost: ${why}`)
    // The port's close ends every open handle with the lost exit (its own
    // markDown did already when the port found the process gone); the
    // process, when it is still there, is stopped so nothing lingers.
    void old.port.close().catch(() => {})
    void old.process.stop().catch(() => {})
    changed()
    restarting = restart(why).finally(() => {
      restarting = null
    })
  }

  const restart = async (why: string): Promise<void> => {
    const now = Date.now()
    deaths.push(now)
    while (deaths.length > 0 && deaths[0] < now - windowMs) deaths.shift()
    if (deaths.length > maxRestarts) {
      givenUp = `it died ${deaths.length} times within ${Math.round(windowMs / 1000)} s, last: ${why}`
      log(`the terminal process is not started again: ${givenUp}`)
      changed()
      return
    }
    log(`starting a new terminal process (${why})`)
    try {
      await boot()
    } catch (err) {
      if (closing) return
      await restart(`it did not start: ${(err as Error).message.split('\n')[0]}`)
    }
  }

  const refuse = (message: string): never => {
    throw new CapabilityUnavailable({ capability: 'terminals', message })
  }

  await boot()

  return {
    spawn(spec: TerminalSpawn): TerminalProcess {
      if (closing) refuse('This server is stopping and starts no more terminals.')
      if (givenUp !== null)
        refuse(`The terminal process keeps dying and is not started again (${givenUp}).`)
      if (current === null)
        refuse('The terminal process is being started again; try once more in a moment.')
      return current!.port.spawn(spec)
    },
    ready: async () => (current === null ? false : current.port.ready()),
    state,
    settled: async () => {
      while (restarting) await restarting
    },
    close: async () => {
      closing = true
      const live = current
      current = null
      if (restarting) await restarting.catch(() => {})
      if (live) {
        await live.port.close().catch(() => {})
        await live.process.stop()
      }
    }
  }
}

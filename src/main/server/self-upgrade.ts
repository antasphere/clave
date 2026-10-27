/**
 * The daemon's self-upgrade (issue #266): a standalone server installed by
 * `scripts/install-server.sh` upgrades itself to the version a Mac asks for,
 * by running that same script with `--ref v<version>`, once none of its
 * agents has worked for a minute (or at once, for "Upgrade now").
 *
 * What it knows comes from the service's command line, written by the
 * script: `--app-version` (the release's version: a beta's package.json says
 * the stable version it was cut from), `--install-name`, `--install-script`
 * and `--install-ref`. Without the three install facts the daemon reports the
 * upgrade unsupported. The VERSION asked for is the only thing that comes off
 * the wire, checked again here: the script gets `--name <its name> --ref
 * v<version>` and nothing else.
 *
 * The script stops the service it runs under, so it must not be the
 * service's child in a way the stop takes with it. Linux: `systemd-run
 * --user` starts it as a transient unit of the user manager, outside the
 * service's cgroup (`KillMode=control-group` would kill it otherwise), and
 * the unit appends its output to the log itself. macOS: a detached child, in
 * a session and process group of its own, which a `launchctl bootout` of the
 * server job leaves alone. The script is copied under the data directory
 * first, since the release it came from may be pruned by the run itself.
 *
 * The normal success is this process being stopped by the script and the
 * new release starting. A run that ends while this server is still up either
 * failed before the switch (or rolled back), which is reported as `failed`
 * with the end of the log, or had nothing to do (exit 0), back to `idle`.
 *
 * Nothing here imports Electron.
 */
import { spawn } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  mkdirSync,
  openSync,
  readSync,
  fstatSync,
  writeSync
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { CapabilityUnavailable } from '@clave/contract/errors'
import { NOT_SCRIPT_INSTALLED } from '@clave/contract/release-version'
import {
  InvalidUpgradeVersion,
  isReleaseVersion,
  type ServerInfo,
  type ServerUpgradeRequest,
  type ServerUpgradeStatus
} from '@clave/contract/server-info'
import type { ServerInfoService } from '@clave/server'
import type { SessionManager } from '../sessions/session-manager'

/** How long no agent must have worked before a `when: 'idle'` upgrade starts. */
export const UPGRADE_IDLE_MS = 60_000
/** The sentence a Mac shows for a daemon started by hand or by another installer. */
export { NOT_SCRIPT_INSTALLED }
/** `install-server.sh`'s own rule for `--name`. */
const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

const flag = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1]
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : undefined
}

/** The version this server runs: `--app-version` when given, else the checkout's. */
export function serverVersion(argv: readonly string[], checkout: () => string): string {
  return flag(argv, 'app-version') ?? checkout()
}

export interface InstallFacts {
  /** The service name, `--name` of the script. */
  readonly name: string
  /** The script of the release that runs, absolute. */
  readonly script: string
  /** The ref the release was installed from (a tag, or a branch). */
  readonly ref: string
}

/** What `install-server.sh` told the daemon of its install, or why there is nothing to tell. */
export function readInstallFacts(argv: readonly string[]): InstallFacts | { reason: string } {
  const name = flag(argv, 'install-name')
  const script = flag(argv, 'install-script')
  const ref = flag(argv, 'install-ref')
  if (!name || !script || !ref || !SERVICE_NAME.test(name) || !isAbsolute(script))
    return { reason: NOT_SCRIPT_INSTALLED }
  return { name, script, ref }
}

/** The idle window: a minute, or what `--test-upgrade-idle-ms` says in test mode only. */
export function upgradeIdleMs(argv: readonly string[], testMode: boolean): number {
  if (!testMode) return UPGRADE_IDLE_MS
  const value = Number(flag(argv, 'test-upgrade-idle-ms'))
  return Number.isInteger(value) && value > 0 ? value : UPGRADE_IDLE_MS
}

/** The script's arguments for an upgrade to `version`: its name and the release tag. */
export function upgradeArgs(name: string, version: string): string[] {
  return ['--name', name, '--ref', `v${version}`]
}

export interface LaunchInput {
  readonly name: string
  /** The copy of the script under the data directory. */
  readonly copy: string
  readonly log: string
  readonly args: readonly string[]
  /** The service's PATH, which the script's `node`, `git` and `npm` are found on. */
  readonly path: string
  readonly home: string
  /** Seconds, for a unit name of its own per run. */
  readonly epoch: number
  /** Where `systemd-run` is, null when the machine has none. */
  readonly systemdRun: string | null
}

export interface UpgradeLaunch {
  readonly command: string
  readonly args: string[]
  readonly detached: boolean
}

/** How the script is started on `platform` so it outlives the server's stop. */
export function upgradeLaunch(
  platform: NodeJS.Platform,
  input: LaunchInput
): UpgradeLaunch | { error: string } {
  const script = ['/bin/bash', input.copy, ...input.args]
  if (platform === 'darwin') return { command: script[0], args: script.slice(1), detached: true }
  if (!input.systemdRun)
    return {
      error:
        'systemd-run is not available on this server, so the upgrade cannot run outside the service. Run install-server.sh on the server.'
    }
  return {
    command: input.systemdRun,
    args: [
      '--user',
      '--collect',
      '--wait',
      '--quiet',
      `--unit=${input.name}-upgrade-${input.epoch}`,
      `--setenv=PATH=${input.path}`,
      `--working-directory=${input.home}`,
      `--property=StandardOutput=append:${input.log}`,
      `--property=StandardError=append:${input.log}`,
      ...script
    ],
    detached: false
  }
}

export interface RunResult {
  /** The script's exit code (systemd-run --wait passes it on); 1 when killed by a signal. */
  readonly code: number
  /** The last lines of the log, for the reason a Mac shows. */
  readonly tail: string
}

export interface UpgradeRunner {
  /** Starts the script; resolves when it ends while this server is still up,
   *  rejects when it could not start. */
  start(run: { script: string; args: string[] }): Promise<RunResult>
}

/** Where `systemd-run` is on PATH, or null. */
function findSystemdRun(path: string): string | null {
  for (const dir of [...path.split(delimiter), '/usr/bin', '/bin']) {
    if (!dir) continue
    const candidate = join(dir, 'systemd-run')
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      /* not here */
    }
  }
  return null
}

const ANSI = new RegExp(String.raw`\u001b\[[0-9;]*m`, 'g')
const TAIL_BYTES = 8 * 1024
const TAIL_LINES = 6

/** The last few non-empty lines of the log, colours stripped. */
function logTail(log: string): string {
  let fd: number | undefined
  try {
    fd = openSync(log, 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer
      .toString('utf8')
      .replace(ANSI, '')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== '')
      .slice(-TAIL_LINES)
      .join('\n')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export interface ScriptRunnerOptions {
  readonly dataDir: string
  readonly name: string
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  /** Where `systemd-run` is; found on PATH by default. */
  readonly systemdRun?: (path: string) => string | null
  readonly now?: () => number
}

/** The real runner: the script copied to `<dataDir>/upgrade/`, its output in `upgrade.log` there. */
export function scriptRunner(options: ScriptRunnerOptions): UpgradeRunner {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const now = options.now ?? Date.now
  return {
    start: ({ script, args }) =>
      new Promise<RunResult>((resolve, reject) => {
        const dir = join(options.dataDir, 'upgrade')
        const copy = join(dir, 'install-server.sh')
        const log = join(dir, 'upgrade.log')
        let fd: number
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 })
          chmodSync(dir, 0o700)
          copyFileSync(script, copy)
          chmodSync(copy, 0o700)
          fd = openSync(log, 'a', 0o600)
        } catch (error) {
          reject(new Error(`Could not prepare the upgrade: ${(error as Error).message}`))
          return
        }
        const path = env.PATH ?? '/usr/bin:/bin'
        writeSync(fd, `\n── ${new Date(now()).toISOString()} install-server.sh ${args.join(' ')}\n`)
        const launch = upgradeLaunch(platform, {
          name: options.name,
          copy,
          log,
          args,
          path,
          home: env.HOME ?? homedir(),
          epoch: Math.floor(now() / 1000),
          systemdRun: (options.systemdRun ?? findSystemdRun)(path)
        })
        if ('error' in launch) {
          writeSync(fd, `${launch.error}\n`)
          closeSync(fd)
          reject(new Error(launch.error))
          return
        }
        try {
          const child = spawn(launch.command, launch.args, {
            cwd: env.HOME ?? homedir(),
            env,
            detached: launch.detached,
            stdio: ['ignore', fd, fd]
          })
          child.once('error', (error) => {
            closeSync(fd)
            reject(new Error(`The upgrade did not start: ${error.message}`))
          })
          child.once('exit', (code) => {
            closeSync(fd)
            resolve({ code: code ?? 1, tail: logTail(log) })
          })
          // Its own group, not waited on by this process's end; the exit
          // listener still hears it while this server lives.
          if (launch.detached) child.unref()
        } catch (error) {
          closeSync(fd)
          reject(new Error(`The upgrade did not start: ${(error as Error).message}`))
        }
      })
  }
}

/** Whether any agent works right now, and the moments that may change it. */
export interface AgentActivity {
  busy(): boolean
  subscribe(onChange: () => void): () => void
}

/** The session manager's agents: busy while any session is `working`. */
export function sessionActivity(
  manager: Pick<SessionManager, 'list' | 'subscribeAll' | 'subscribeRemoved'>
): AgentActivity {
  return {
    busy: () => manager.list().some((session) => session.state === 'working'),
    subscribe: (onChange) => {
      const offState = manager.subscribeAll((_id, stream) => {
        if (stream.kind === 'event' && stream.event.type === 'state_change') onChange()
      })
      const offRemoved = manager.subscribeRemoved(() => onChange())
      return () => {
        offState()
        offRemoved()
      }
    }
  }
}

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export interface SelfUpgradeOptions {
  readonly version: string
  readonly facts: InstallFacts | { reason: string }
  readonly runner: UpgradeRunner
  readonly activity: AgentActivity
  readonly clock?: Clock
  readonly idleMs?: number
}

export type SelfUpgrade = ServerInfoService & { close(): void }

/** The daemon's `ServerInfoService`: its version, its install ref and its upgrade. */
export function createSelfUpgrade(options: SelfUpgradeOptions): SelfUpgrade {
  const clock = options.clock ?? realClock
  const idleMs = options.idleMs ?? UPGRADE_IDLE_MS
  const facts = 'reason' in options.facts ? null : options.facts
  const listeners = new Set<(status: ServerUpgradeStatus) => void>()
  let status: ServerUpgradeStatus = facts
    ? { supported: true, state: 'idle' }
    : { supported: false, reason: (options.facts as { reason: string }).reason, state: 'idle' }
  let timer: unknown = null
  let offActivity: (() => void) | null = null
  let closed = false

  const set = (next: ServerUpgradeStatus): ServerUpgradeStatus => {
    status = next
    for (const listener of [...listeners]) listener(status)
    return status
  }
  const disarm = (): void => {
    if (timer !== null) clock.clearTimeout(timer)
    timer = null
    offActivity?.()
    offActivity = null
  }
  const run = (target: string, mode: 'when-idle' | 'now'): ServerUpgradeStatus => {
    disarm()
    const started = set({ supported: true, state: 'running', target, mode, since: clock.now() })
    options.runner.start({ script: facts!.script, args: upgradeArgs(facts!.name, target) }).then(
      (result) => {
        if (closed) return
        set(
          result.code === 0
            ? { supported: true, state: 'idle', since: clock.now() }
            : {
                supported: true,
                state: 'failed',
                target,
                mode,
                error: result.tail || `install-server.sh exited with ${result.code}`,
                since: clock.now()
              }
        )
      },
      (error: Error) => {
        if (closed) return
        set({
          supported: true,
          state: 'failed',
          target,
          mode,
          error: error.message,
          since: clock.now()
        })
      }
    )
    return started
  }
  /** An agent working stops the count; the count starts again, from zero,
   *  once none works. A change between two states that are not working
   *  leaves a running count alone. */
  const rearm = (): void => {
    const waiting = status.state === 'waiting-for-idle'
    if (!waiting || options.activity.busy()) {
      if (timer !== null) clock.clearTimeout(timer)
      timer = null
      return
    }
    if (timer !== null) return
    timer = clock.setTimeout(() => {
      timer = null
      if (status.state === 'waiting-for-idle' && !options.activity.busy())
        run(status.target!, 'when-idle')
    }, idleMs)
  }

  return {
    info: (): ServerInfo => ({
      version: options.version,
      installRef: facts?.ref ?? null,
      upgrade: status
    }),
    requestUpgrade: (request: ServerUpgradeRequest): ServerUpgradeStatus => {
      if (!facts)
        throw new CapabilityUnavailable({
          capability: 'server-upgrade',
          message: `This server cannot upgrade itself: ${status.reason ?? NOT_SCRIPT_INSTALLED}.`
        })
      if (!isReleaseVersion(request.version))
        throw new InvalidUpgradeVersion({
          message: 'An upgrade takes a release version such as 3.0.0 or 3.0.0-beta.9.'
        })
      if (status.state === 'running') return status
      if (request.version === options.version) {
        if (status.state === 'idle') return status
        disarm()
        return set({ supported: true, state: 'idle', since: clock.now() })
      }
      if (request.when === 'now') return run(request.version, 'now')
      set({
        supported: true,
        state: 'waiting-for-idle',
        target: request.version,
        mode: 'when-idle',
        since: clock.now()
      })
      offActivity ??= options.activity.subscribe(rearm)
      rearm()
      return status
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    close: () => {
      closed = true
      disarm()
      listeners.clear()
    }
  }
}

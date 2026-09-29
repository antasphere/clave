/**
 * Keeps the agent CLIs Clave launches on their latest release (PRDCT-2927).
 *
 * At launch and every six hours it finds each CLI on the login PATH, reads
 * how it was installed, its version and the latest release, and — when
 * automatic updates are on, the default — upgrades it with the installer that
 * owns it. Off, it only says an upgrade exists and waits for the button.
 *
 * Nothing here may hold up the app. Every process is an async `spawn` with a
 * timeout and stdin closed (an installer that prompts fails instead of
 * hanging), every read is async, the login environment comes from
 * `loginShellEnvAsync` (never the sync fallback), and one queue runs the work
 * one step at a time so two installers never race over the same prefix.
 *
 * Running tabs are never touched: a new session starts on the new binary, and
 * the renderer offers a restart to a tab spawned before the upgrade.
 */
import { spawn } from 'node:child_process'
import { promises as fsp, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  AGENT_UPDATE_TARGETS,
  type AgentUpdateId,
  type AgentUpdateStatus,
  type AgentUpdatesState
} from '../../shared/agent-updates'
import {
  canUpgrade,
  classifyInstall,
  describeInstall,
  isNewer,
  parseVersion,
  prefixNpm,
  releaseSource,
  upgradeCommand
} from './detect'

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Let the boot settle (windows, restored tabs, the login shell read) first. */
export const INITIAL_DELAY_MS = 30 * 1000
const VERSION_TIMEOUT_MS = 20 * 1000
const REGISTRY_TIMEOUT_MS = 15 * 1000
const UPGRADE_TIMEOUT_MS = 10 * 60 * 1000
/** An installer that ignored SIGTERM this long after its timeout is killed. */
const KILL_GRACE_MS = 5 * 1000
/**
 * How long the automatic pass leaves an installer that did not offer the
 * latest release (a Homebrew cask behind npm) before running it again for
 * that same release. The button still runs it at once.
 */
export const HELD_BACK_RETRY_MS = 24 * 60 * 60 * 1000
const OUTPUT_CAP = 64 * 1024

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  /** Set when the process could not start or ran past its timeout. */
  failure?: string
}

export interface AgentUpdateDeps {
  loginEnv: () => Promise<Record<string, string>>
  run: (
    file: string,
    args: string[],
    opts: { env: Record<string, string>; timeoutMs: number }
  ) => Promise<RunResult>
  /** The version a dist-tag of an npm package points at, or null. */
  fetchDistTag: (pkg: string, tag: string) => Promise<string | null>
  realpath: (file: string) => Promise<string>
  isExecutable: (file: string) => Promise<boolean>
  /** Claude's own update channel (`autoUpdatesChannel`), or null. */
  claudeChannel: (env: Record<string, string>) => Promise<string | null>
  getAutoUpdate: () => boolean
  setAutoUpdate: (value: boolean) => void
  /** Whether the timers run at all (off under test mode and in dev). */
  scheduled: boolean
  /** False where the installers' commands cannot run (Windows, for now). */
  supported: boolean
  broadcast: (state: AgentUpdatesState) => void
  notify: (title: string, body: string) => void
  now: () => number
}

function freshStatus(target: (typeof AGENT_UPDATE_TARGETS)[number]): AgentUpdateStatus {
  return {
    id: target.id,
    name: target.name,
    command: target.command,
    installed: false,
    path: null,
    realPath: null,
    install: null,
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    phase: 'idle',
    lastCheckedAt: null,
    lastUpdatedAt: null,
    updatedFrom: null,
    heldBack: null,
    heldBackAt: null,
    note: null,
    error: null
  }
}

/** The last lines of a failed command, short enough for a settings row. */
export function failureText(result: RunResult): string {
  if (result.failure) return result.failure
  const text = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-4).join('\n')
  const tail = text.length > 400 ? `…${text.slice(-400)}` : text
  return tail || `Exited with code ${result.code}`
}

export class AgentUpdateManager {
  private readonly agents = new Map<AgentUpdateId, AgentUpdateStatus>()
  private queue: Promise<void> = Promise.resolve()
  private pending = 0
  private checkInFlight: Promise<AgentUpdatesState> | null = null
  private initialTimer: ReturnType<typeof setTimeout> | null = null
  private intervalTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: AgentUpdateDeps) {
    for (const target of AGENT_UPDATE_TARGETS) this.agents.set(target.id, freshStatus(target))
  }

  start(): void {
    if (!this.deps.scheduled || !this.deps.supported) return
    if (this.initialTimer || this.intervalTimer) return
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null
      void this.checkAll()
    }, INITIAL_DELAY_MS)
    this.intervalTimer = setInterval(() => void this.checkAll(), CHECK_INTERVAL_MS)
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.initialTimer = null
    this.intervalTimer = null
  }

  getState(): AgentUpdatesState {
    return {
      supported: this.deps.supported,
      autoUpdate: this.deps.getAutoUpdate(),
      busy: this.pending > 0,
      agents: AGENT_UPDATE_TARGETS.map((t) => ({ ...this.agents.get(t.id)! }))
    }
  }

  setAutoUpdate(value: boolean): AgentUpdatesState {
    this.deps.setAutoUpdate(value)
    this.emit()
    // Turning it on acts on what the last check already found.
    if (value) void this.busyWhile(this.upgradeAvailable())
    return this.getState()
  }

  /**
   * One pass: inspect every agent, then upgrade what is behind when automatic
   * updates are on. A second call while a pass runs joins it rather than
   * queueing another. Busy for the whole pass, the upgrades included, so the
   * Check button does not wake between the two halves.
   */
  checkAll(): Promise<AgentUpdatesState> {
    if (!this.deps.supported) return Promise.resolve(this.getState())
    if (this.checkInFlight) return this.checkInFlight
    const pass = this.busyWhile(
      this.enqueue(async () => {
        const env = await this.deps.loginEnv()
        for (const target of AGENT_UPDATE_TARGETS) await this.inspect(target.id, env)
      }).then(() => (this.deps.getAutoUpdate() ? this.upgradeAvailable() : undefined))
    )
      .then(() => this.getState())
      .finally(() => {
        this.checkInFlight = null
      })
    this.checkInFlight = pass
    return pass
  }

  /**
   * Upgrade one agent now (the Update button). Runs the installer even for a
   * release it held back before; does nothing for an agent a check found
   * current, so a second click queued behind the first installs nothing.
   */
  update(id: AgentUpdateId): Promise<AgentUpdatesState> {
    if (!this.deps.supported || !this.agents.has(id)) return Promise.resolve(this.getState())
    return this.enqueue(async () => {
      const status = this.agents.get(id)!
      if (status.install && !status.updateAvailable) return
      await this.upgrade(id, await this.deps.loginEnv())
    }).then(() => this.getState())
  }

  /** Whether the automatic pass should run this agent's installer now. */
  private dueForUpgrade(status: AgentUpdateStatus): boolean {
    if (!status.updateAvailable) return false
    if (status.heldBack !== status.latestVersion || status.heldBackAt === null) return true
    return this.deps.now() - status.heldBackAt >= HELD_BACK_RETRY_MS
  }

  private async upgradeAvailable(): Promise<void> {
    for (const target of AGENT_UPDATE_TARGETS) {
      if (!this.dueForUpgrade(this.agents.get(target.id)!)) continue
      await this.enqueue(async () => {
        // Re-read under the queue: a manual update may have run meanwhile.
        if (!this.dueForUpgrade(this.agents.get(target.id)!)) return
        await this.upgrade(target.id, await this.deps.loginEnv())
      })
    }
  }

  private busyWhile<T>(work: Promise<T>): Promise<T> {
    this.pending++
    this.emit()
    return work.finally(() => {
      this.pending--
      this.emit()
    })
  }

  /** Runs `task` after everything queued before it; never rejects, so one
   *  failed step never wedges the steps queued behind it. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task).catch((err) => {
      console.error('[agent-updates]', err)
    })
    this.queue = run
    return this.busyWhile(run)
  }

  private patch(id: AgentUpdateId, patch: Partial<AgentUpdateStatus>): AgentUpdateStatus {
    const next = { ...this.agents.get(id)!, ...patch }
    this.agents.set(id, next)
    this.emit()
    return next
  }

  private emit(): void {
    this.deps.broadcast(this.getState())
  }

  private async findOnPath(command: string, pathEnv: string | undefined): Promise<string | null> {
    if (command.includes('/')) return (await this.deps.isExecutable(command)) ? command : null
    for (const dir of (pathEnv ?? '').split(delimiter)) {
      if (!dir) continue
      const candidate = join(dir, command)
      if (await this.deps.isExecutable(candidate)) return candidate
    }
    return null
  }

  private async readVersion(bin: string, env: Record<string, string>): Promise<string | null> {
    const result = await this.deps.run(bin, ['--version'], { env, timeoutMs: VERSION_TIMEOUT_MS })
    return parseVersion(`${result.stdout}\n${result.stderr}`)
  }

  /** Where the agent is, how it was installed, which version, and the latest. */
  private async inspect(id: AgentUpdateId, env: Record<string, string>): Promise<void> {
    const target = AGENT_UPDATE_TARGETS.find((t) => t.id === id)!
    this.patch(id, { phase: 'checking' })
    const now = this.deps.now()
    const path = await this.findOnPath(target.command, env.PATH)
    if (!path) {
      const kept = this.agents.get(id)!
      this.agents.set(id, {
        ...freshStatus(target),
        lastUpdatedAt: kept.lastUpdatedAt,
        updatedFrom: kept.updatedFrom,
        lastCheckedAt: now
      })
      this.emit()
      return
    }
    let realPath = path
    try {
      realPath = await this.deps.realpath(path)
    } catch {
      // A dangling link reads as the link itself; the version read says the rest.
    }
    const install = classifyInstall(realPath, id)
    const currentVersion = await this.readVersion(path, env)
    const source = releaseSource(
      id,
      install,
      install.kind === 'claude-native' ? await this.deps.claudeChannel(env) : null
    )
    const latestVersion = source ? await this.deps.fetchDistTag(source.pkg, source.tag) : null
    const updatable = canUpgrade(install)
    const previous = this.agents.get(id)!
    // A held-back release stays held back only while it is still the latest.
    const heldBack = previous.heldBack === latestVersion ? previous.heldBack : null
    this.patch(id, {
      installed: true,
      heldBack,
      heldBackAt: heldBack ? previous.heldBackAt : null,
      path,
      realPath,
      install,
      currentVersion,
      latestVersion,
      updateAvailable: updatable && isNewer(latestVersion, currentVersion),
      phase: 'idle',
      lastCheckedAt: now,
      note: !updatable
        ? `${describeInstall(install)}: Clave leaves its updates to it.`
        : !currentVersion
          ? 'Clave could not read its version.'
          : null,
      error: currentVersion ? null : previous.error
    })
  }

  private async resolveCommandFile(
    file: string,
    env: Record<string, string>
  ): Promise<string | null> {
    const found = await this.findOnPath(file, env.PATH)
    if (found || file !== 'brew') return found
    for (const candidate of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
      if (await this.deps.isExecutable(candidate)) return candidate
    }
    return null
  }

  private async upgrade(id: AgentUpdateId, env: Record<string, string>): Promise<void> {
    let status = this.agents.get(id)!
    if (!status.install || !status.path) {
      await this.inspect(id, env)
      status = this.agents.get(id)!
    }
    if (!status.installed || !status.install || !status.path) return
    const ownNpm = prefixNpm(status.install)
    const command = upgradeCommand(
      status.install,
      status.path,
      ownNpm && (await this.deps.isExecutable(ownNpm)) ? ownNpm : null
    )
    if (!command) return
    const file = await this.resolveCommandFile(command.file, env)
    if (!file) {
      this.patch(id, { error: `${command.file} is not on your login PATH.` })
      return
    }
    const from = status.currentVersion
    const target = status.latestVersion
    this.patch(id, { phase: 'updating', error: null })
    const result = await this.deps.run(file, command.args, { env, timeoutMs: UPGRADE_TIMEOUT_MS })
    await this.inspect(id, env)
    const after = this.agents.get(id)!
    // The version decides, not the exit code: an installer may exit non-zero
    // on a cleanup warning after the upgrade itself went through.
    if (from && after.currentVersion && isNewer(after.currentVersion, from)) {
      this.patch(id, {
        lastUpdatedAt: this.deps.now(),
        updatedFrom: from,
        heldBack: null,
        heldBackAt: null,
        error: null
      })
      this.deps.notify(
        `${status.name} updated to ${after.currentVersion}`,
        `New ${status.name} sessions start on it. Open tabs stay on ${from} until restarted.`
      )
      return
    }
    if (result.failure || result.code !== 0) {
      this.patch(id, { error: failureText(result) })
      return
    }
    // The installer ran cleanly and moved nothing: its channel has no newer
    // release yet (a Homebrew cask trails npm by hours). Remembered, so the
    // row says so and the automatic pass does not rerun it every check.
    if (target) this.patch(id, { heldBack: target, heldBackAt: this.deps.now() })
  }
}

// ---------------------------------------------------------------------------
// The real dependencies.
// ---------------------------------------------------------------------------

export function runCommand(
  file: string,
  args: string[],
  opts: { env: Record<string, string>; timeoutMs: number }
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (result: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, { env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', failure: String(err) })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, KILL_GRACE_MS).unref()
      done({ code: null, stdout, stderr, failure: `${file} ${args.join(' ')} timed out` })
    }, opts.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf-8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString('utf-8')
    })
    child.on('error', (err) => done({ code: null, stdout, stderr, failure: err.message }))
    child.on('close', (code) => done({ code, stdout, stderr }))
  })
}

export async function fetchDistTag(
  pkg: string,
  tag: string,
  registry = 'https://registry.npmjs.org'
): Promise<string | null> {
  try {
    const url = `${registry}/-/package/${pkg.replace('/', '%2F')}/dist-tags`
    const response = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) })
    if (!response.ok) return null
    const tags = (await response.json()) as Record<string, unknown>
    const version = tags[tag]
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

export async function readClaudeChannel(env: Record<string, string>): Promise<string | null> {
  const dir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude')
  try {
    const settings = JSON.parse(await fsp.readFile(join(dir, 'settings.json'), 'utf-8'))
    const channel = settings?.autoUpdatesChannel
    return typeof channel === 'string' ? channel : null
  } catch {
    return null
  }
}

export async function isExecutableFile(file: string): Promise<boolean> {
  try {
    await fsp.access(file, fsConstants.X_OK)
    return (await fsp.stat(file)).isFile()
  } catch {
    return false
  }
}

export const realDeps = {
  run: runCommand,
  fetchDistTag,
  realpath: (file: string) => fsp.realpath(file),
  isExecutable: isExecutableFile,
  claudeChannel: readClaudeChannel,
  now: () => Date.now()
}

/**
 * Which harnesses are installed, and at which version, where no Electron app
 * runs (a Clave server, `clave-server --daemon`). The same manager the app
 * builds in `index.ts`, wired for looking only: no registry asked, no timer,
 * no look at boot, no installer ever run. A detection runs when asked and is
 * kept a minute; a detection in which a step failed is not kept, so the next
 * ask runs again.
 */
import type { AgentUpdateStatus } from '../../shared/agent-updates'
import { loginShellEnvAsync } from '../sessions/adapters/pty-backend'
import { AgentUpdateManager, realDeps, type AgentUpdateDeps } from './agent-update-manager'
import { agentUpdateSchedule } from './schedule'

export interface HarnessDetection {
  readonly detect: () => Promise<ReadonlyArray<AgentUpdateStatus>>
}

export const DETECTION_TTL_MS = 60_000

export function standaloneHarnessDetection(input: {
  readonly env: NodeJS.ProcessEnv
  readonly testMode: boolean
  readonly platform?: NodeJS.Platform
  readonly ttlMs?: number
  readonly deps?: Partial<AgentUpdateDeps>
}): HarnessDetection {
  const schedule = agentUpdateSchedule({
    testMode: input.testMode,
    packaged: false,
    platform: input.platform ?? process.platform,
    env: input.env
  })
  const { agentPath } = schedule
  const deps: AgentUpdateDeps = {
    ...realDeps,
    loginEnv: agentPath
      ? async () => ({ ...(await loginShellEnvAsync()), PATH: agentPath })
      : loginShellEnvAsync,
    fetchDistTag: async () => null,
    getAutoUpdate: () => false,
    setAutoUpdate: () => {},
    scheduled: false,
    looksAtBoot: false,
    supported: schedule.supported,
    broadcast: () => {},
    notify: () => {},
    ...input.deps
  }

  // The manager logs and swallows a failed step so a queue never wedges; the
  // steps that can throw are watched here so such a pass is not kept.
  let failure: unknown = null
  const watch =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args)
      } catch (err) {
        failure ??= err
        throw err
      }
    }
  const manager = new AgentUpdateManager({
    ...deps,
    loginEnv: watch(deps.loginEnv),
    run: watch(deps.run),
    isExecutable: watch(deps.isExecutable),
    claudeChannel: watch(deps.claudeChannel)
  })

  const ttlMs = input.ttlMs ?? DETECTION_TTL_MS
  let inFlight: Promise<ReadonlyArray<AgentUpdateStatus>> | null = null
  let doneAt: number | null = null

  const detect = (): Promise<ReadonlyArray<AgentUpdateStatus>> => {
    if (inFlight && (doneAt === null || deps.now() - doneAt < ttlMs)) return inFlight
    failure = null
    doneAt = null
    const pass = manager.detectAll().then((state) => {
      if (failure !== null) {
        const err = failure
        failure = null
        throw err instanceof Error ? err : new Error(String(err))
      }
      doneAt = deps.now()
      return state.agents
    })
    inFlight = pass
    pass.catch(() => {
      if (inFlight === pass) inFlight = null
    })
    return pass
  }

  return { detect }
}

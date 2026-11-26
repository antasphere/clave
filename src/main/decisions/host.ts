import * as os from 'node:os'
import type { WorkspaceFiles } from '@clave/server/workspace-files'
import type { TabProjects } from '@clave/contract/tab-projects-rules'
import type { DecisionFailureReason as WireReason } from '@clave/contract/decisions'
import type { RegistryWorkspace } from '../routines/resolve'
import { projectOptionsOf, type ProjectOption } from './project-options'
import { readTab, type TabHarness, type TabReading, type TabSource } from './tab-reading'
import { basisOf, tabProjectDecision, type TabProjectInput } from './tab-project'
import { runDecision, type DecisionFailureReason, type DecisionOutcome } from './runner'
import { decisionConfig } from './registry'
import { jevIntegration } from '../integrations/jev'
import type { TabProjectOutcome } from './tab-project'

/**
 * The decisions on the host (PRDCT-5179), the mirror of `hostSpeech`
 * (`../speech.ts`): which projects a tab works on, read from THIS process's
 * record of the tab and its transcript, asked of Jev with THIS process's key
 * (the runner opens it), and written on the record. Served to the clients of
 * the server the tab runs on (`DecisionsPort` of `@clave/server`),
 * in-process and standalone alike.
 *
 * Each tab is read on its own and none fails the others. A tab whose record
 * already holds a reading made on the same basis (what Jev would read, and
 * the model) is answered from it, with no request; one an earlier call is
 * still reading on that basis waits for that reading and answers it. A tab
 * that gets no new reading keeps the one its record had.
 */

/** The fields of a session record the host reads (`SessionRecord` of
 *  `../sessions/adapters/pty-backend.ts`). */
export interface DecisionRecord {
  claudeMode?: boolean
  codexMode?: boolean
  piMode?: boolean
  claudeSessionId?: string
  codexThreadId?: string
  piSessionId?: string
  cwd: string
  configDir?: string
  workspaceId?: string
  projects?: TabProjects
}

export interface HostDecisionsOptions {
  /** This host's record of a session; none for a tab it does not keep. */
  recordOf: (sessionId: string) => DecisionRecord | null | undefined
  /** Write the reading on the record; false when it keeps none. */
  setProjects: (sessionId: string, projects: TabProjects) => boolean
  /** The workspaces of this host's registry. */
  workspaces: () => ReadonlyArray<RegistryWorkspace> | Promise<ReadonlyArray<RegistryWorkspace>>
  /** This host's `.clave` files, read trusted-or-nothing; none, no option. */
  files: () => WorkspaceFiles | undefined
  /** The conversation a live session would resume, when its record does not
   *  name one (a Codex terminal's rollout: `ptyManager.conversationIdOf`). */
  conversationOf?: (sessionId: string) => string | null | undefined
  /** Whether the decision can run on this host at all, asked before any tab
   *  is read: the reason it cannot (`disabled`, `no-key`), or null. By
   *  default the decision's switch and this process's Jev key. */
  preflight?: () => DecisionFailureReason | null
  /** Test seams: the transcript, the options, the request. */
  readTab?: (source: TabSource) => Promise<TabReading | null>
  optionsOf?: (workspace: RegistryWorkspace) => Promise<ProjectOption[]>
  run?: (input: TabProjectInput) => Promise<DecisionOutcome<TabProjectOutcome>>
  now?: () => number
  home?: string
}

/** One tab's answer, and whether its record was written by this call. */
export interface TabProjectsOnHost {
  sessionId: string
  projects: TabProjects | null
  reason?: DecisionFailureReason
  written: boolean
}

export interface HostDecisions {
  readTabProjects: (sessionIds: ReadonlyArray<string>) => Promise<TabProjectsOnHost[]>
}

// The wire's reasons are the runner's own: a reason added to one and not
// the other is a type error here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const reasonsAgree: Same<DecisionFailureReason, WireReason> = true
void reasonsAgree

/** The harness of an agent tab and the conversation it runs; null for any
 *  other tab (a terminal, another harness, a tab that has not started one). */
function harnessOf(
  record: DecisionRecord,
  live: string | null | undefined
): { harness: TabHarness; conversationId: string } | null {
  if (record.claudeMode) {
    const id = record.claudeSessionId ?? live
    return id ? { harness: 'claude', conversationId: id } : null
  }
  if (record.codexMode) {
    const id = record.codexThreadId ?? live
    return id ? { harness: 'codex', conversationId: id } : null
  }
  if (record.piMode) {
    const id = record.piSessionId ?? live
    return id ? { harness: 'pi', conversationId: id } : null
  }
  return null
}

/** The decision's switch, then this process's key: read from the settings
 *  files alone, no Keychain call, no request. */
function defaultPreflight(): DecisionFailureReason | null {
  const config = decisionConfig(tabProjectDecision)
  if (config.refused || !config.enabled) return 'disabled'
  return jevIntegration.status().configured ? null : 'no-key'
}

export function hostDecisions(options: HostDecisionsOptions): HostDecisions {
  const preflight = options.preflight ?? defaultPreflight
  const read = options.readTab ?? readTab
  const now = options.now ?? Date.now
  const home = options.home ?? os.homedir()
  const run =
    options.run ??
    ((input: TabProjectInput): Promise<DecisionOutcome<TabProjectOutcome>> =>
      runDecision(tabProjectDecision, input))
  const optionsOf =
    options.optionsOf ??
    (async (workspace: RegistryWorkspace): Promise<ProjectOption[]> => {
      const files = options.files()
      return files ? projectOptionsOf(files, workspace) : []
    })
  /** The readings still out, by tab and basis: one request per tab and
   *  basis at a time, whatever the calls that ask it. */
  const inFlight = new Map<string, Promise<TabProjectsOnHost>>()

  const readOne = async (
    sessionId: string,
    workspaces: () => Promise<ReadonlyArray<RegistryWorkspace>>,
    optionsOnce: (workspace: RegistryWorkspace) => Promise<ProjectOption[]>
  ): Promise<TabProjectsOnHost> => {
    const nothing: TabProjectsOnHost = {
      sessionId,
      projects: null,
      reason: 'nothing',
      written: false
    }
    const record = options.recordOf(sessionId)
    if (!record) return nothing
    const old = record.projects ?? null
    const kept = (reason: DecisionFailureReason): TabProjectsOnHost => ({
      sessionId,
      projects: old,
      reason,
      written: false
    })
    const agent = harnessOf(record, options.conversationOf?.(sessionId))
    if (!agent || !record.workspaceId) return kept('nothing')
    const workspace = (await workspaces()).find((w) => w.id === record.workspaceId)
    if (!workspace) return kept('nothing')
    const tab = await read({
      harness: agent.harness,
      cwd: record.cwd,
      conversationId: agent.conversationId,
      ...(record.configDir && { configDir: record.configDir }),
      workspaceRoot: workspace.rootDir
    })
    if (!tab) return kept('nothing')
    const input: TabProjectInput = {
      tab,
      options: await optionsOnce(workspace),
      workspaceRoot: workspace.rootDir,
      home
    }
    const request = tabProjectDecision.build(input)
    if (!request) return kept('nothing')
    const basis = basisOf(request, tabProjectDecision.model)
    // Read on the same basis already: answered as it is, Jev not asked.
    if (old && old.basis === basis) return { sessionId, projects: old, written: false }
    // Being read on this basis by a call still out (a tab joined a group
    // while its first read was away): that reading is the answer.
    const flightKey = `${sessionId}\n${basis}`
    const pending = inFlight.get(flightKey)
    if (pending) {
      const first = await pending
      return {
        sessionId,
        projects: first.projects,
        ...(first.reason && { reason: first.reason }),
        written: false
      }
    }
    const flight = (async (): Promise<TabProjectsOnHost> => {
      const outcome = await run(input)
      if (!outcome.ok) return kept(outcome.reason)
      const projects: TabProjects = {
        status: outcome.value.status,
        picks: outcome.value.picks,
        fits: outcome.value.fits,
        readAt: now(),
        model: outcome.model,
        basis
      }
      if (!options.setProjects(sessionId, projects)) return kept('failed')
      return { sessionId, projects, written: true }
    })()
    inFlight.set(flightKey, flight)
    try {
      return await flight
    } finally {
      if (inFlight.get(flightKey) === flight) inFlight.delete(flightKey)
    }
  }

  return {
    readTabProjects: async (sessionIds) => {
      // A host with no key, or with the decision switched off, reads no
      // transcript and walks no folder: every person's grouping asks, and on
      // a machine without Jev it must cost nothing. It serves no reading
      // either, so Clave names no group, exactly as before the decisions;
      // the records keep theirs, and switching it back on costs no request
      // for a tab that has not moved.
      let blocked: DecisionFailureReason | null = null
      try {
        blocked = preflight()
      } catch (error) {
        // The settings could not be read: the runner's own checks still hold.
        console.error('[decisions] could not read whether a decision may run', error)
      }
      if (blocked) {
        const reason = blocked
        return sessionIds.map((sessionId) => ({
          sessionId,
          projects: null,
          reason,
          written: false
        }))
      }
      // Within one call: the registry read once, each workspace's options once.
      let registry: Promise<ReadonlyArray<RegistryWorkspace>> | undefined
      const workspaces = (): Promise<ReadonlyArray<RegistryWorkspace>> =>
        (registry ??= Promise.resolve().then(() => options.workspaces()))
      const byWorkspace = new Map<string, Promise<ProjectOption[]>>()
      const optionsOnce = (workspace: RegistryWorkspace): Promise<ProjectOption[]> => {
        let found = byWorkspace.get(workspace.id)
        if (!found) {
          found = optionsOf(workspace)
          byWorkspace.set(workspace.id, found)
        }
        return found
      }
      return Promise.all(
        sessionIds.map((sessionId) =>
          readOne(sessionId, workspaces, optionsOnce).catch((error: unknown) => {
            console.error('[decisions] reading a tab failed', error)
            let old: TabProjects | null = null
            try {
              old = options.recordOf(sessionId)?.projects ?? null
            } catch {
              // The record cannot be read either: no reading to keep.
            }
            return { sessionId, projects: old, reason: 'failed' as const, written: false }
          })
        )
      )
    }
  }
}

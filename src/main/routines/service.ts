/**
 * The routines as the server's `Routines` port (ADR 0004,
 * `packages/server/src/routines/port.ts`): the scheduler, the runs, the
 * report and the discussions, in one object built in whichever process runs
 * the server (Electron main in-process, the app's separate child, a
 * daemon). Nothing here imports Electron.
 *
 * What it does, in order: reads the routines off the workspace files it is
 * given (`resolve.ts`, trusted-or-nothing) and re-reads them when a file or
 * the registry changes; every thirty seconds decides each routine's tick
 * (`scheduler.ts`), claims the occurrence (`claims.ts`, one per user across
 * servers) and starts the run as a hidden session through the session host,
 * with the launch parameters resolved as a tab's would be (`launch.ts`) and
 * the contract skill's first message (`skill.ts`); watches the run's stream
 * for blocked, done and exit, and a timeout; takes the agent's report,
 * validates it (`validate.ts`), writes the deck (`deck.ts`) and serves it
 * through the Slideless viewer; keeps the last twenty runs (`store.ts`).
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  RoutineReportInput,
  RoutinesEvent,
  RoutinesService,
  SessionHostService,
  Unsubscribe
} from '@clave/server'
import type { WorkspaceFiles } from '@clave/server/workspace-files'
import type {
  RoutineDeclaration,
  RoutineRun,
  RoutineRunTrigger,
  RoutineStatus,
  RoutinesListing
} from '@clave/contract/routines'
import type { SpawnOptions } from '@clave/contract/sessions'
import type { SessionStream } from '@clave/contract/sessions'
import type { StoragePort } from '../ports/storage'
import { Viewer, type ViewerOptions } from '../../../plugins/analytics/src/viewer'
import { Claims } from './claims'
import {
  DECKS_DIR,
  type DeckEnvelope,
  MAX_TEMPLATE_BYTES,
  removeRoutineDecks,
  writeDeck,
  writeRootIndex
} from './deck'
import { type LaunchFacts, REPORTING_AGENTS, resolveLaunch } from './launch'
import { PublishFailure, SHARE_NAME_PREFIX, type RoutinePublisher } from './publisher'
import { type RegistryWorkspace, type ServerIdentity, resolveRoutines } from './resolve'
import { ON_TIME_MS, TICK_MS, decideTick, nextRunAt } from './scheduler'
import { SYSTEM_PROMPT_LINE, firstMessage } from './skill'
import { RoutinesStore } from './store'
import { type SchemaCheck, compileSchemaFile } from './validate'

/** A report the scheduler would not take, with the schema's errors for the
 *  agent. Defined here, not imported from the server package: main's entry
 *  reaches this module at boot and must load no Effect module then
 *  (`server/lazy-load.test.ts`); the server's handler reads the shape. */
export class RoutineReportRefusal extends Error {
  readonly errors: ReadonlyArray<string>
  constructor(message: string, errors: ReadonlyArray<string> = []) {
    super(message)
    this.name = 'RoutineReportRefusal'
    this.errors = errors
  }
}

export const HIDDEN_COLS = 120
export const HIDDEN_ROWS = 30
export const REPORT_VIEW_ID = 'clave.routine-report/report'
export const CHAT_VIEW_ID = 'clave.chat-view/chat'
/** How long a run waits for the agent tools before it is failed unstarted. */
export const AGENT_TOOLS_WAIT_MS = 90_000

export interface RoutineServiceOptions {
  readonly sessions: SessionHostService
  readonly files: WorkspaceFiles
  /** The workspace registry this server runs on, and its changes. */
  readonly workspaces: () => Promise<ReadonlyArray<RegistryWorkspace>>
  readonly onWorkspacesChanged?: (listener: () => void) => Unsubscribe
  readonly facts: LaunchFacts
  /** Where `routines.json` lives (the storage port of the data directory). */
  readonly storage: Pick<StoragePort, 'read' | 'write'>
  /** The data directory, for the decks under `routines/decks/`. */
  readonly dataDir: string
  /** The claims folder; the user's `~/.clave/routines/claims` by default. */
  readonly claimsDir?: string
  /** Who claims: this server's id. */
  readonly holder: string
  /** The contract skill's plugin folder (`skill.ts`, `contractPluginDir`). */
  readonly pluginDir: string
  /** This server as a routine's `server` field names it (PRDCT-4149): its
   *  id and its own name. Read at each use: an app-run server knows its id
   *  only once its listener is up. */
  readonly identity: () => ServerIdentity
  /** The Slideless publisher for routines whose report says `publish: true`
   *  (PRDCT-4149); absent or `false`, such a run carries why nothing was published. */
  readonly publisher?: RoutinePublisher | false
  /** The viewer: the login shell's environment the CLI is found in; `false` for no viewer (tests). */
  readonly viewer?:
    | { env: () => Promise<Record<string, string>>; spawn?: ViewerOptions['spawn'] }
    | false
  /** The session belongs to the window from now on (the discussion in a window's panel). */
  readonly rehome: (sessionId: string, windowKey: string) => void
  /** The provider's own conversation id of a session (a Claude session id, a Codex thread), when known. */
  readonly providerSessionIdOf: (sessionId: string) => string | null
  /** Resolves once the agent tools have an address a run can report to (the
   *  MCP server listening in-process, the shell's address announced to a
   *  standalone server). A run waits for it, bounded, and is failed with the
   *  reason rather than started with no way to report (round 1, F1). */
  readonly agentToolsReady?: () => Promise<void>
  /** The bound on that wait; tests shorten it. */
  readonly agentToolsWaitMs?: number
  readonly now?: () => number
  readonly tickMs?: number
  /** Whether the scheduler ticks at all; off, the routines are listed and run by hand only (tests). */
  readonly schedule?: boolean
  readonly log?: (level: 'info' | 'warn', message: string) => void
}

interface LiveRun {
  readonly run: RoutineRun
  readonly declaration: RoutineDeclaration
  readonly offs: Unsubscribe[]
  timeout: ReturnType<typeof setTimeout> | null
  /** The report taken so far: its status, applied when the run ends. */
  report: { status: RoutineStatus } | null
  ended: boolean
  /** The turn was interrupted (the app quitting or restarting stops its chats that way, as does a stop). */
  interrupted?: boolean
}

/** Why a run that was interrupted before its report ended (7 November 2026: a run cut by
 *  the update to beta.15 read as "ended without a report", which said the agent failed). */
export const INTERRUPTED_REASON =
  'interrupted before its report: Clave quit or restarted, or the run was stopped'

export interface RoutineService extends RoutinesService {
  /** The listing, answered at once: this implementation needs no await. */
  list(): RoutinesListing
  /** Read the files and arm the tick; idempotent. */
  start(): Promise<void>
  /** Read the routines again now (a file changed, the registry changed). */
  refresh(): Promise<void>
  /** One tick, now: what the interval does; the tests drive it. */
  tick(): Promise<boolean>
  /** Stop the tick, the viewer and nothing else: the runs die with their sessions. */
  close(): Promise<void>
  readonly declarations: () => ReadonlyArray<RoutineDeclaration>
}

export function createRoutineService(options: RoutineServiceOptions): RoutineService {
  const now = options.now ?? ((): number => Date.now())
  const log = options.log ?? ((): void => {})
  const store = new RoutinesStore(options.storage, now)
  const claims = new Claims({
    holder: options.holder,
    now,
    ...(options.claimsDir !== undefined ? { dir: options.claimsDir } : {})
  })
  const decksRoot = path.join(options.dataDir, DECKS_DIR)
  const listeners = new Set<(event: RoutinesEvent) => void>()
  const live = new Map<string, LiveRun>()
  let declarations: RoutineDeclaration[] = []
  let watched = new Set<string>()
  let claimsProblem: string | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let offFiles: Unsubscribe | null = null
  let offWorkspaces: Unsubscribe | null = null
  let viewer: Viewer | null = null
  let started = false
  let ticking: Promise<boolean> | null = null
  let refreshing: Promise<void> | null = null

  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener({ _tag: 'routines.changed' })
      } catch (error) {
        log('warn', `a routines listener failed: ${String(error)}`)
      }
    }
  }

  const declaration = (key: string): RoutineDeclaration | undefined =>
    declarations.find((d) => d.key === key)
  const runningOf = (key: string): LiveRun | undefined =>
    [...live.values()].find((l) => l.run.routineKey === key && !l.ended)

  // ── The viewer ──

  function startViewer(): void {
    if (viewer || options.viewer === false) return
    writeRootIndex(decksRoot)
    viewer = new Viewer({
      root: decksRoot,
      savedPort: store.viewerPort(),
      onPort: (port) => store.setViewerPort(port),
      env: options.viewer?.env ?? (async () => ({ ...process.env }) as Record<string, string>),
      ...(options.viewer?.spawn ? { spawn: options.viewer.spawn } : {}),
      log: (level, message) => log(level, `viewer: ${message}`)
    })
    void viewer.start().then(() => emit())
  }

  const viewerState = (): RoutinesListing['viewer'] => {
    if (options.viewer === false)
      return { url: null, note: 'The decks are not served in this process.' }
    if (!viewer) return { url: null, note: 'The Slideless viewer has not started.' }
    return { url: viewer.url(), note: viewer.note() }
  }

  // ── The routines ──

  async function refresh(): Promise<void> {
    if (refreshing) return refreshing
    refreshing = (async () => {
      const workspaces = await options.workspaces()
      const resolved = await resolveRoutines(
        options.files,
        workspaces,
        undefined,
        options.identity()
      )
      declarations = resolved.declarations
      const liveKeys = new Set(declarations.map((d) => d.key))
      for (const d of declarations) store.seen(d.key)
      for (const key of store.prune(liveKeys)) removeRoutineDecks(decksRoot, key)
      // Watch what was read, and stop watching what left the set.
      const next = new Set(resolved.files)
      for (const file of next) if (!watched.has(file)) options.files.watch(file, 'routines')
      for (const file of watched) if (!next.has(file)) options.files.unwatch(file, 'routines')
      watched = next
      emit()
    })().finally(() => {
      refreshing = null
    })
    return refreshing
  }

  // ── A run ──

  function recordFailed(
    d: RoutineDeclaration,
    trigger: RoutineRunTrigger,
    reason: string
  ): RoutineRun {
    const at = now()
    const run: RoutineRun = {
      id: randomUUID(),
      routineKey: d.key,
      trigger,
      startedAt: at,
      endedAt: at,
      state: 'failed',
      headline: null,
      summary: null,
      reason,
      sessionId: null,
      providerSessionId: null,
      discussionSessionId: null,
      agent: (d.launch.agent ?? 'claude') as RoutineRun['agent'],
      form: (d.launch.form ?? 'chat') as RoutineRun['form'],
      model: d.launch.model ?? null,
      account: d.launch.account ?? null,
      deck: null,
      seen: false
    }
    store.addRun(run)
    log('warn', `routine "${d.name}" failed before it started: ${reason}`)
    return run
  }

  function finish(entry: LiveRun, outcome: { status?: RoutineStatus; reason?: string }): void {
    if (entry.ended) return
    entry.ended = true
    for (const off of entry.offs) off()
    if (entry.timeout) clearTimeout(entry.timeout)
    const status = entry.report?.status ?? 'failed'
    const reason = entry.report ? null : (outcome.reason ?? 'ended without a report')
    // The conversation id the stream named stands; the record is the fallback
    // (a server whose record answers nothing must not erase what the stream
    // said, which is what the discussion resumes on).
    const providerSessionId =
      store.run(entry.run.id)?.providerSessionId ??
      (entry.run.sessionId ? options.providerSessionIdOf(entry.run.sessionId) : null)
    store.updateRun(entry.run.id, {
      state: status,
      endedAt: now(),
      ...(reason !== null ? { reason } : {}),
      providerSessionId
    })
    live.delete(entry.run.id)
    // The process stops with the run: the transcript stays, the discussion resumes it.
    if (entry.run.sessionId) void options.sessions.stop(entry.run.sessionId).catch(() => undefined)
    emit()
    // The deck goes to Slideless once the run has ended, not at each report
    // (round 1, Minor 2): a run may correct its report, and one run is one
    // version, the last deck it wrote.
    const final = store.run(entry.run.id)
    if (entry.report && entry.declaration.report.publish && final?.deck)
      void publishRun(
        entry.declaration,
        entry.run.id,
        path.dirname(path.resolve(decksRoot, final.deck))
      )
  }

  /** A discussion continues the run's conversation, and a resumed chat may
   *  carry it on under a new provider id: the run's `providerSessionId` follows
   *  the discussion's latest one, so the next resume (the panel reopened after
   *  its session stopped, a relaunch, Open as a tab) picks the conversation up
   *  after the person's own messages, not back at the run's last word (seen on
   *  6 November 2026: messages sent in Discussion were gone on reopening). */
  function followConversation(runId: string, sessionId: string): void {
    const offs: Array<() => void> = []
    const stop = (): void => {
      for (const off of offs.splice(0)) off()
    }
    try {
      offs.push(
        options.sessions.subscribe(sessionId, (frame: SessionStream) => {
          if (frame.kind !== 'event') return
          const event = frame.event
          if (event.type === 'session_meta' && event.providerSessionId) {
            if (store.run(runId)?.providerSessionId !== event.providerSessionId) {
              store.updateRun(runId, { providerSessionId: event.providerSessionId })
            }
          } else if (event.type === 'state_change' && event.state === 'ended') {
            stop()
          }
        })
      )
      offs.push(options.sessions.subscribeExit(sessionId, () => stop()))
    } catch {
      /* no stream: the resume falls back to the run's own id */
    }
  }

  function watch(entry: LiveRun, sessionId: string): void {
    const { sessions } = options
    const onStream = (frame: SessionStream): void => {
      if (frame.kind !== 'event') return
      const event = frame.event
      if (event.type === 'session_meta' && event.providerSessionId) {
        store.updateRun(entry.run.id, { providerSessionId: event.providerSessionId })
      }
      if (event.type === 'turn_interrupted') entry.interrupted = true
      if (event.type === 'state_change') {
        if (event.state === 'blocked') {
          store.updateRun(entry.run.id, { state: 'waiting' })
          emit()
        } else if (event.state === 'working' || event.state === 'idle') {
          const current = store.run(entry.run.id)
          if (current?.state === 'waiting') {
            store.updateRun(entry.run.id, { state: 'running' })
            emit()
          }
        } else if (event.state === 'done' || event.state === 'ended') {
          finish(entry, {
            reason: entry.interrupted ? INTERRUPTED_REASON : 'ended without a report'
          })
        }
      }
    }
    try {
      // Subscribing is what starts a chat's process (the host readies it).
      entry.offs.push(sessions.subscribe(sessionId, onStream))
      entry.offs.push(
        sessions.subscribeExit(sessionId, (code) =>
          finish(entry, {
            reason: entry.interrupted
              ? INTERRUPTED_REASON
              : `the process exited with code ${code} without a report`
          })
        )
      )
    } catch (error) {
      finish(entry, { reason: `the session could not be watched: ${String(error)}` })
    }
  }

  async function startRun(d: RoutineDeclaration, trigger: RoutineRunTrigger): Promise<RoutineRun> {
    const resolved = resolveLaunch(d, options.facts)
    if (!resolved.ok) return recordFailed(d, trigger, resolved.reason)
    if (!REPORTING_AGENTS.has(resolved.agent))
      return recordFailed(
        d,
        trigger,
        `this agent cannot report: ${resolved.agent} has no Clave tools`
      )
    const schema: SchemaCheck = compileSchemaFile(d.report.schema)
    if (!schema.ok) return recordFailed(d, trigger, schema.reason)
    const run: RoutineRun = {
      id: randomUUID(),
      routineKey: d.key,
      trigger,
      startedAt: now(),
      endedAt: null,
      state: 'running',
      headline: null,
      summary: null,
      reason: null,
      sessionId: null,
      providerSessionId: null,
      discussionSessionId: null,
      agent: resolved.agent,
      form: resolved.form,
      model: resolved.model,
      account: resolved.account,
      deck: null,
      seen: false
    }
    const entry: LiveRun = {
      run,
      declaration: d,
      offs: [],
      timeout: null,
      report: null,
      ended: false
    }
    live.set(run.id, entry)
    store.addRun(run)
    emit()
    // The run reports through the agent tools: without an address for them it
    // would start with no way to report, so it waits for one, bounded and
    // paced. The run is already on the record, so a server that stops during
    // the wait leaves a run its next start marks failed (round 2, N1), and
    // a readiness that refuses at once cannot spin (round 2, N2).
    if (options.agentToolsReady) {
      const waitMs = options.agentToolsWaitMs ?? AGENT_TOOLS_WAIT_MS
      const deadline = now() + waitMs
      let reachable = false
      let lastError: unknown = null
      while (!reachable) {
        try {
          await options.agentToolsReady()
          reachable = true
        } catch (error) {
          lastError = error
          if (now() >= deadline) break
          await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, waitMs)))
        }
      }
      if (!reachable) {
        entry.ended = true
        live.delete(run.id)
        store.updateRun(run.id, {
          state: 'failed',
          endedAt: now(),
          reason: `the agent tools are not reachable: no MCP address within ${Math.round(waitMs / 1000)} seconds, so the run could not report (${lastError instanceof Error ? lastError.message : String(lastError)})`
        })
        emit()
        return store.run(run.id) ?? run
      }
    }
    const message = firstMessage({ routine: d, run, pluginDir: options.pluginDir })
    const spawn: SpawnOptions = {
      ...resolved.spawn,
      initialPrompt: message,
      workspaceId: d.workspaceId,
      link: { kind: 'routine', routineKey: d.key, runId: run.id },
      // A run dies with the server by design: no tmux session to survive it.
      tmuxMode: false,
      ...(resolved.agent === 'claude'
        ? { pluginDir: options.pluginDir, appendSystemPrompt: SYSTEM_PROMPT_LINE }
        : {})
    }
    let sessionId: string
    try {
      const info = await options.sessions.start({ cwd: d.cwd, options: spawn })
      sessionId = info.id
    } catch (error) {
      entry.ended = true
      live.delete(run.id)
      store.updateRun(run.id, {
        state: 'failed',
        endedAt: now(),
        reason: `the session could not start: ${error instanceof Error ? error.message : String(error)}`
      })
      emit()
      return store.run(run.id) ?? run
    }
    const withSession = { ...run, sessionId }
    live.set(run.id, { ...entry, run: withSession })
    const liveEntry = live.get(run.id)!
    store.updateRun(run.id, { sessionId })
    try {
      options.sessions.setView(sessionId, REPORT_VIEW_ID)
    } catch {
      /* a host without views keeps the default */
    }
    watch(liveEntry, sessionId)
    if (resolved.form === 'terminal') {
      // A terminal's first size starts its process.
      try {
        options.sessions.resize(sessionId, HIDDEN_COLS, HIDDEN_ROWS)
      } catch (error) {
        finish(liveEntry, { reason: `the terminal could not start: ${String(error)}` })
      }
    }
    liveEntry.timeout = setTimeout(
      () => finish(liveEntry, { reason: `timed out after ${d.timeoutMinutes} minutes` }),
      d.timeoutMinutes * 60_000
    )
    liveEntry.timeout.unref?.()
    emit()
    return store.run(run.id) ?? withSession
  }

  // ── The publish (PRDCT-4149) ──

  /** The run's deck pushed to Slideless as a new version of the routine's
   *  deck, after the report was taken; the outcome lands on the run and
   *  never changes its state. One push at a time per routine, in order. */
  const publishing = new Map<string, Promise<void>>()
  async function publishRun(d: RoutineDeclaration, runId: string, folder: string): Promise<void> {
    const previous = publishing.get(d.key) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (!options.publisher) {
          store.updateRun(runId, {
            publishError:
              'this server publishes no decks: no Slideless publisher runs in this process'
          })
          emit()
          return
        }
        try {
          const outcome = await options.publisher.publish({
            folder,
            title: d.name,
            state: store.publishState(d.key),
            shareName: `${SHARE_NAME_PREFIX} · ${d.name} · ${options.identity().name}`
          })
          store.setPublishState(d.key, outcome.state)
          store.updateRun(runId, {
            published: { deckId: outcome.deckId, version: outcome.version, url: outcome.url },
            publishError: outcome.shareError
          })
          log(
            'info',
            `routine "${d.name}": run ${runId} published as version ${outcome.version} of deck ${outcome.deckId}`
          )
        } catch (error) {
          const reason =
            error instanceof PublishFailure
              ? error.message
              : `the publish failed: ${error instanceof Error ? error.message : String(error)}`
          store.updateRun(runId, { publishError: reason })
          log('warn', `routine "${d.name}": ${reason}`)
        }
        emit()
      })
    publishing.set(d.key, next)
    await next
  }

  // ── The tick ──

  async function tick(): Promise<boolean> {
    if (ticking) return ticking
    ticking = (async () => {
      let changed = false
      const at = now()
      for (const d of declarations) {
        // Pinned to another server (PRDCT-4149): listed, its next occurrence
        // shown, and never considered here, so the server it names runs it alone.
        if (d.runsHere === false) continue
        const state = store.seen(d.key)
        const decision = decideTick({
          schedule: d.schedule,
          catchUp: d.catchUp,
          invalid: d.invalid,
          clock: { lastConsideredAt: state.lastConsideredAt, schedule: state.schedule },
          running: runningOf(d.key) !== undefined,
          now: at
        })
        if (decision.kind === 'run' || decision.kind === 'fail') {
          if (claimsProblem) {
            log(
              'warn',
              `routine "${d.name}": not run, the claims folder is unwritable (${claimsProblem})`
            )
          } else {
            const claimed = claims.claim(d.key, decision.occurrence)
            if (claimed.kind === 'claimed') {
              if (decision.kind === 'run') void startRun(d, decision.trigger)
              else
                recordFailed(
                  d,
                  at - decision.occurrence < ON_TIME_MS ? 'scheduled' : 'catch-up',
                  decision.reason
                )
              changed = true
            } else if (claimed.kind === 'taken') {
              log(
                'info',
                `routine "${d.name}": occurrence ${decision.occurrence} already run by ${claimed.by ?? 'another server'}`
              )
            } else {
              claimsProblem = claimed.reason
              log('warn', `routine "${d.name}": the claims folder is unwritable: ${claimed.reason}`)
            }
          }
        } else if (decision.kind === 'skip') {
          log(
            'info',
            `routine "${d.name}": occurrence ${decision.occurrence} skipped (${decision.reason})`
          )
        }
        store.considered(d.key, at, d.schedule)
      }
      if (changed) emit()
      return changed
    })().finally(() => {
      ticking = null
    })
    return ticking
  }

  // ── The port ──

  const service: RoutineService = {
    declarations: () => declarations,
    async start() {
      if (started) return
      started = true
      const probe = claims.probe()
      if (!probe.ok) {
        claimsProblem = probe.reason
        log('warn', `the routines will not run: the claims folder is unwritable (${probe.reason})`)
      }
      claims.prune()
      // A run this process (or its predecessor on this data) never finished.
      const cutOff: RoutineRun[] = []
      for (const open of store.openRuns()) {
        const ended = store.updateRun(open.id, {
          state: 'failed',
          endedAt: now(),
          reason: 'the server stopped during the run'
        })
        if (ended) cutOff.push(ended)
      }
      await refresh()
      // A run that reported and was then cut off by the stop (the ADR's own
      // case: an update ending the app) still has its deck and nothing on
      // Slideless, since the publish waits for the run's end and that end
      // never came (round 2, Minor 1): it is published now, once. Only the
      // runs THIS start ended, oldest first, so a routine that turns
      // publishing on does not push its whole history with the oldest run
      // ending as the version the link shows (round 3, Minor 1); and not a
      // routine this server no longer runs (round 3, Note 2).
      for (const run of [...cutOff].sort((a, b) => a.startedAt - b.startedAt)) {
        const d = declaration(run.routineKey)
        if (!d || !d.report.publish || d.runsHere === false) continue
        if (!run.deck || run.published || run.publishError) continue
        void publishRun(d, run.id, path.dirname(path.resolve(decksRoot, run.deck)))
      }
      offFiles = options.files.onEvent((event) => {
        if (event._tag === 'workspace_files.changed' && watched.has(event.path)) void refresh()
      })
      offWorkspaces = options.onWorkspacesChanged?.(() => void refresh()) ?? null
      startViewer()
      if (options.schedule !== false) {
        timer = setInterval(() => void tick(), options.tickMs ?? TICK_MS)
        timer.unref?.()
        void tick()
      }
    },
    refresh,
    tick,
    async close() {
      if (timer) clearInterval(timer)
      timer = null
      offFiles?.()
      offWorkspaces?.()
      for (const file of watched) options.files.unwatch(file, 'routines')
      watched = new Set()
      if (viewer) await viewer.stop()
      viewer = null
    },
    list() {
      const at = now()
      return {
        routines: declarations.map((routine) => ({
          routine,
          nextRunAt: nextRunAt(routine.schedule, routine.invalid, at),
          runs: store.state(routine.key)?.runs ?? []
        })),
        viewer: viewerState(),
        server: options.identity()
      }
    },
    async deck(runId) {
      const run = store.run(runId)
      if (!run) throw new Error(`No run "${runId}"`)
      if (!run.deck) throw new Error('This run has no deck: it ended without a valid report')
      // The relative path the service itself wrote: confined to the decks root all the same.
      const file = path.resolve(decksRoot, run.deck)
      const rel = path.relative(decksRoot, file)
      if (rel.startsWith('..') || path.isAbsolute(rel))
        throw new Error('This run’s deck is outside the decks folder')
      let stat: fs.Stats
      try {
        stat = fs.statSync(file)
      } catch {
        throw new Error('This run’s deck is no longer on disk')
      }
      if (stat.size > MAX_TEMPLATE_BYTES) throw new Error('This run’s deck is larger than 5 MiB')
      return { html: fs.readFileSync(file, 'utf8') }
    },
    async runNow(key) {
      const d = declaration(key)
      if (!d) throw new Error(`No routine "${key}" is declared on this server`)
      if (d.invalid) throw new Error(`"${d.name}" cannot run: ${d.invalid}`)
      if (d.runsHere === false)
        throw new Error(
          `"${d.name}" runs on ${d.runsOn ?? 'another server'}, not on ${options.identity().name}: ask that server to run it`
        )
      if (runningOf(key)) throw new Error(`"${d.name}" is running; wait for it to end`)
      if (claimsProblem)
        throw new Error(
          `The routines cannot run: the claims folder is unwritable (${claimsProblem})`
        )
      const runId = randomUUID()
      const claimed = claims.claim(key, `manual-${runId}`)
      if (claimed.kind !== 'claimed')
        throw new Error(
          claimed.kind === 'taken'
            ? 'Another server took this run'
            : `The claims folder is unwritable (${claimed.reason})`
        )
      const run = await startRun(d, 'manual')
      return run
    },
    dismiss(runId) {
      if (!store.run(runId)) throw new Error(`No run "${runId}"`)
      store.updateRun(runId, { seen: true })
      emit()
    },
    async report(input: RoutineReportInput) {
      const run = store.runBySession(input.sessionId)
      if (!run || run.sessionId !== input.sessionId)
        throw new RoutineReportRefusal(
          'clave_routine_report is for a routine run: this session is not one (a discussion of a run cannot report either)'
        )
      const entry = live.get(run.id)
      if (!entry || entry.ended)
        throw new RoutineReportRefusal('this run has ended; a report after the end is refused')
      const d = entry.declaration
      const schema = compileSchemaFile(d.report.schema)
      if (!schema.ok) throw new RoutineReportRefusal(schema.reason)
      const checked = schema.validate(input.data)
      if (!checked.ok)
        throw new RoutineReportRefusal(
          `the data does not match the routine schema (${d.report.schema}); correct it and call clave_routine_report again`,
          checked.errors
        )
      const at = now()
      const envelope: DeckEnvelope = {
        routine: { key: d.key, name: d.name, schedule: d.schedule, file: d.file },
        run: {
          id: run.id,
          trigger: run.trigger,
          startedAt: run.startedAt,
          endedAt: at,
          status: input.status,
          headline: input.headline,
          summary: input.summary,
          reportedAt: at,
          agent: run.agent,
          model: run.model,
          account: run.account
        },
        data: input.data
      }
      let deck: string
      try {
        deck = writeDeck({
          decksRoot,
          routineKey: d.key,
          runId: run.id,
          template: d.report.template,
          envelope
        }).relative
      } catch (error) {
        throw new RoutineReportRefusal(
          `the deck could not be written: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      entry.report = { status: input.status }
      store.updateRun(run.id, {
        headline: input.headline,
        summary: input.summary,
        deck,
        seen: false
      })
      emit()
      return { runId: run.id, deck }
    },
    async openDiscussion(runId, windowKey, mode) {
      const run = store.run(runId)
      if (!run) throw new Error(`No run "${runId}"`)
      const d = declaration(run.routineKey)
      const alive = (id: string | null): id is string => !!id && !!options.sessions.get(id)
      if (mode === 'panel') {
        // The run's own session while it runs, or a discussion already opened.
        const current =
          alive(run.sessionId) && live.get(run.id) && !live.get(run.id)!.ended
            ? run.sessionId
            : null
        const existing =
          current ?? (alive(run.discussionSessionId) ? run.discussionSessionId : null)
        if (existing) {
          options.rehome(existing, windowKey)
          return { sessionId: existing }
        }
      }
      const providerSessionId =
        run.providerSessionId ?? (run.sessionId ? options.providerSessionIdOf(run.sessionId) : null)
      if (!providerSessionId) throw new Error('This run left no conversation to resume')
      if (!d)
        throw new Error('This routine is no longer declared; its conversation cannot be resumed')
      const resolved = resolveLaunch(d, options.facts)
      if (!resolved.ok) throw new Error(`The discussion cannot start: ${resolved.reason}`)
      if (resolved.form !== 'chat') throw new Error('A terminal run has no conversation to resume')
      const spawn: SpawnOptions = {
        ...resolved.spawn,
        resumeSessionId: providerSessionId,
        workspaceId: d.workspaceId,
        tmuxMode: false,
        ...(mode === 'panel' ? { link: { kind: 'routine', routineKey: d.key, runId: run.id } } : {})
      }
      const info = await options.sessions.start({ cwd: d.cwd, windowKey, options: spawn })
      try {
        options.sessions.setView(info.id, CHAT_VIEW_ID)
      } catch {
        /* default view */
      }
      followConversation(run.id, info.id)
      if (mode === 'panel') {
        store.updateRun(run.id, { discussionSessionId: info.id })
        emit()
      }
      return { sessionId: info.id }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
  return service
}

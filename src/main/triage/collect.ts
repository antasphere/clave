/**
 * The triage snapshot, assembled (issue #227). Pure over `TriageSources`:
 * no Electron, no filesystem, no network here, so every rule below is tested
 * on fakes (`collect.test.ts`) and `sources.ts` is only the wiring.
 *
 * Three rules hold whatever a source answers:
 *  - Every source is read-only and has a deadline. One that throws, hangs or
 *    does not apply becomes a typed `TriageSource` failure and a warning;
 *    the snapshot always resolves, which is what makes it useful when the
 *    server is the broken part.
 *  - Each source is projected onto the contract's allowlisted fields. The
 *    discovery files' tokens and the MCP token are dropped here, and added
 *    to the redactor's known secrets so an error quoting one is scrubbed.
 *  - Titles Clave generated from a first prompt and provider conversation
 *    ids are never copied; a tab carries the label its user gave it, or none.
 */
import type {
  TriageAgent,
  TriageApp,
  TriageClient,
  TriageListedGroup,
  TriageListedSession,
  TriageOrigin,
  TriageProcess,
  TriageReconciliation,
  TriageRecord,
  TriageRecordKind,
  TriageServer,
  TriageServerMode,
  TriageServerOwnership,
  TriageSession,
  TriageSnapshot,
  TriageSource,
  TriageWindow,
  TriageWindowListing,
  TriageWorkspace
} from '../../shared/triage'
import { TRIAGE_SNAPSHOT_VERSION } from '../../shared/triage'
import { createRedactor, errorText, type Redactor } from './redact'

export interface TriageLimitsConfig {
  maxSessions: number
  maxRecords: number
  maxTmux: number
  maxGroupsPerWindow: number
  sourceTimeoutMs: number
}

export const DEFAULT_LIMITS: Readonly<TriageLimitsConfig> = {
  maxSessions: 500,
  maxRecords: 500,
  maxTmux: 500,
  maxGroupsPerWindow: 500,
  sourceTimeoutMs: 3000
}

export type TriageLimitsInput = Partial<TriageLimitsConfig>

/** The shell's `clave-server.json`, as parsed (token included: dropped here). */
export interface RawShellDiscovery {
  url?: unknown
  token?: unknown
  mode?: unknown
  ok?: unknown
  error?: unknown
  pid?: unknown
  clientId?: unknown
  serverPid?: unknown
}

/** The separate server's own `clave-server.json` under `<userData>/server`. */
export interface RawServerDiscovery {
  url?: unknown
  token?: unknown
  pid?: unknown
  terminalProcessPid?: unknown
  terminalProcessGeneration?: unknown
  terminalProcessGivenUp?: unknown
}

/** One record file, its name and its parsed content (unvalidated). */
export interface RawRecordFile {
  key: string
  content: unknown
}

export interface RawWindowReply {
  windowId: number
  ok: boolean
  result?: unknown
  error?: string
}

/** What the assembler reads. Every async member may throw or hang. */
export interface TriageSources {
  now: () => Date
  origin: TriageOrigin
  home: string
  app: () => TriageApp
  appVersion: string
  paths: { userData: string; serverData: string; mainLog: string }
  /** Both discovery files, parsed; null when absent or unreadable. */
  shellDiscovery: () => Promise<RawShellDiscovery | null>
  serverDiscovery: () => Promise<RawServerDiscovery | null>
  /** The address main itself holds, for when no discovery file says it. */
  endpoint: () => { url: string; mode: 'in-process' | 'attached' } | null
  mcpRuntime: () => { url: string; token: string } | null
  isAlive: (pid: number) => boolean
  processes: () => Promise<TriageProcess[]>
  /** GET an open route of the server (no token); answers status and text. */
  health: (origin: string, path: string) => Promise<{ status: number; body: string }>
  clients: () => Promise<ReadonlyArray<unknown>>
  sessions: () => Promise<ReadonlyArray<unknown>>
  workspaces: () => TriageWorkspace[]
  windows: () => TriageWindow[]
  /** Each window's renderer listing, with the deadline the assembler gives. */
  windowListings: (timeoutMs: number) => Promise<RawWindowReply[]>
  /** The record files of `dir`, at most `max`; `total` counts them all. */
  records: (dir: string, max: number) => Promise<{ total: number; files: RawRecordFile[] }>
  tmuxSessions: () => Promise<string[]>
  /** The agent updater's cached state (no probe, no spawn). */
  agents: () => unknown
  /** Absolute paths of the files holding credentials. */
  neverRead: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const pidOf = (v: unknown): number | null => {
  const n = num(v)
  return n !== null && Number.isInteger(n) && n > 0 ? n : null
}

/** Run one source under a deadline, answering a typed outcome, never a throw. */
export async function withDeadline<T>(
  redact: Redactor,
  timeoutMs: number,
  label: string,
  run: () => Promise<T> | T
): Promise<TriageSource<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<TriageSource<T>>((resolve) => {
    timer = setTimeout(
      () => resolve({ status: 'timeout', error: `${label} did not answer within ${timeoutMs} ms` }),
      timeoutMs
    )
  })
  try {
    return await Promise.race([
      Promise.resolve()
        .then(run)
        .then(
          (value): TriageSource<T> => ({ status: 'ok', value }),
          (error): TriageSource<T> => ({ status: 'error', error: errorText(redact, error) })
        ),
      timeout
    ])
  } finally {
    clearTimeout(timer)
  }
}

function originOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function ownershipOf(mode: TriageServerMode): TriageServerOwnership {
  if (mode === 'in-process') return 'shell-process'
  if (mode === 'separate') return 'shell-child'
  if (mode === 'attached') return 'external'
  return 'unknown'
}

function recordKind(r: Record<string, unknown>): TriageRecordKind {
  if (r.antigravityMode === true) return 'antigravity'
  if (r.codexMode === true) return 'codex'
  if (r.piMode === true) return 'pi'
  if (r.claudeAgentsMode === true) return 'claude'
  // An absent `claudeMode` always meant Claude (pty-backend's listing rule).
  if (r.claudeMode !== false) return 'claude'
  return 'terminal'
}

/** The label a user gave a tab, never one Clave generated. */
function userLabelOf(r: Record<string, unknown> | undefined, redact: Redactor): string | null {
  if (!r || r.userRenamed !== true) return null
  const label = str(r.displayName)
  return label ? redact.text(label, 120) : null
}

function projectRecord(file: RawRecordFile, redact: Redactor): TriageRecord | null {
  const r = file.content
  if (!isObject(r)) return null
  const id = str(r.id)
  const cwd = str(r.cwd)
  if (!id || cwd === null) return null
  const transport = r.transport === 'pty' || r.transport === 'events' ? r.transport : null
  const link = isObject(r.link) ? str(r.link.kind) : null
  return {
    key: redact.text(file.key, 200),
    id: redact.text(id, 200),
    kind: recordKind(r),
    transport,
    adapterId: str(r.adapterId) ? redact.text(str(r.adapterId)!, 120) : null,
    tmuxName: str(r.tmuxName) ? redact.text(str(r.tmuxName)!, 200) : null,
    windowKey: str(r.windowKey) ? redact.text(str(r.windowKey)!, 120) : null,
    workspaceId: str(r.workspaceId) ? redact.text(str(r.workspaceId)!, 120) : null,
    cwd: redact.text(cwd, 1000),
    link: link ? redact.text(link, 60) : null,
    startedAt: num(r.startedAt),
    userLabel: userLabelOf(r, redact),
    hasProviderConversation: !!(
      str(r.claudeSessionId) ||
      str(r.codexThreadId) ||
      str(r.piSessionId)
    )
  }
}

function projectSession(
  s: unknown,
  recordById: Map<string, Record<string, unknown>>,
  redact: Redactor
): TriageSession | null {
  if (!isObject(s)) return null
  const id = str(s.id)
  if (!id) return null
  return {
    id: redact.text(id, 200),
    provider: redact.text(str(s.provider) ?? 'unknown', 60),
    transport: s.transport === 'events' ? 'events' : 'pty',
    state: redact.text(str(s.state) ?? 'unknown', 30),
    adapterId: redact.text(str(s.adapterId) ?? 'unknown', 120),
    windowKey: redact.text(str(s.windowKey) ?? '', 120),
    groupId: str(s.groupId) ? redact.text(str(s.groupId)!, 120) : null,
    cwd: redact.text(str(s.cwd) ?? '', 1000),
    createdAt: num(s.createdAt) ?? 0,
    viewId: str(s.viewId) ? redact.text(str(s.viewId)!, 200) : null,
    // The server's `title` is deliberately not read: it is the generated one
    // unless the record says the user named the tab.
    userLabel: userLabelOf(recordById.get(id), redact)
  }
}

function projectClient(c: unknown, redact: Redactor): TriageClient | null {
  if (!isObject(c)) return null
  const id = str(c.id)
  if (!id) return null
  return {
    id: redact.text(id, 200),
    kind: redact.text(str(c.kind) ?? 'other', 30),
    name: redact.text(str(c.name) ?? '', 120),
    pid: pidOf(c.pid),
    registeredAt: num(c.registeredAt) ?? 0
  }
}

function projectListing(
  reply: RawWindowReply,
  redact: Redactor,
  maxSessions: number,
  maxGroups: number
): { listing: TriageWindowListing; truncated: boolean } {
  if (!reply.ok || !isObject(reply.result)) {
    return {
      listing: {
        windowId: reply.windowId,
        status: 'error',
        error: redact.text(reply.error ?? 'the window did not answer', 400)
      },
      truncated: false
    }
  }
  const rawSessions = Array.isArray(reply.result.sessions) ? reply.result.sessions : []
  const rawGroups = Array.isArray(reply.result.groups) ? reply.result.groups : []
  const sessions: TriageListedSession[] = []
  for (const s of rawSessions.slice(0, maxSessions)) {
    if (!isObject(s) || !str(s.id)) continue
    const account = isObject(s.account) ? str(s.account.id) : null
    sessions.push({
      id: redact.text(str(s.id)!, 200),
      mode: redact.text(str(s.mode) ?? 'unknown', 30),
      alive: s.alive === true,
      agentState: str(s.agentState) ? redact.text(str(s.agentState)!, 30) : null,
      groupId: str(s.groupId) ? redact.text(str(s.groupId)!, 120) : null,
      workspaceId: str(s.workspaceId) ? redact.text(str(s.workspaceId)!, 120) : null,
      accountId: account ? redact.text(account, 120) : null
    })
  }
  const groups: TriageListedGroup[] = []
  for (const g of rawGroups.slice(0, maxGroups)) {
    if (!isObject(g) || !str(g.id)) continue
    const terminals = Array.isArray(g.terminals) ? g.terminals : []
    groups.push({
      id: redact.text(str(g.id)!, 120),
      name: redact.text(str(g.name) ?? '', 120),
      sessionIds: (Array.isArray(g.sessionIds) ? g.sessionIds : [])
        .filter((x): x is string => typeof x === 'string')
        .slice(0, maxSessions)
        .map((x) => redact.text(x, 200)),
      terminalCount: terminals.length,
      terminalSessionIds: terminals
        .map((t) => (isObject(t) ? str(t.sessionId) : null))
        .filter((x): x is string => !!x)
        .map((x) => redact.text(x, 200)),
      workspaceId: str(g.workspaceId) ? redact.text(str(g.workspaceId)!, 120) : null,
      hasView: isObject(g.view) || typeof g.view === 'string'
    })
  }
  return {
    listing: { windowId: reply.windowId, status: 'ok', value: { sessions, groups } },
    truncated: rawSessions.length > maxSessions || rawGroups.length > maxGroups
  }
}

function projectAgents(state: unknown, redact: Redactor): TriageAgent[] {
  if (!isObject(state) || !Array.isArray(state.agents)) return []
  return state.agents.filter(isObject).map((a) => ({
    id: redact.text(str(a.id) ?? 'unknown', 30),
    installed: a.installed === true,
    currentVersion: str(a.currentVersion) ? redact.text(str(a.currentVersion)!, 60) : null,
    latestVersion: str(a.latestVersion) ? redact.text(str(a.latestVersion)!, 60) : null,
    lastCheckedAt: num(a.lastCheckedAt)
  }))
}

const difference = (a: Iterable<string>, b: Set<string>): string[] =>
  [...new Set(a)].filter((x) => !b.has(x)).sort()

export function reconcile(input: {
  sessions: TriageSource<TriageSession[]>
  listings: TriageWindowListing[]
  windows: TriageWindow[]
  records: TriageSource<{ items: TriageRecord[] }>
  tmux: TriageSource<{ live: string[] }>
  truncated: boolean
}): TriageReconciliation {
  const server = input.sessions.status === 'ok' ? input.sessions.value : null
  const okListings = input.listings.filter(
    (l): l is Extract<TriageWindowListing, { status: 'ok' }> => l.status === 'ok'
  )
  const allListed = okListings.length === input.listings.length
  const records = input.records.status === 'ok' ? input.records.value.items : null
  const live = input.tmux.status === 'ok' ? input.tmux.value.live : null

  const shown = new Set<string>()
  const tabWindow = new Map<string, number>()
  for (const l of okListings) {
    for (const s of l.value.sessions) {
      shown.add(s.id)
      tabWindow.set(s.id, l.windowId)
    }
    for (const g of l.value.groups) for (const id of g.terminalSessionIds) shown.add(id)
  }
  // A hidden session belongs to its owner (a group terminal, a session
  // view's server, a toolbar button): it is never a row of its own.
  const hidden = new Set((records ?? []).filter((r) => r.link).map((r) => r.id))
  const serverIds = new Set((server ?? []).map((s) => s.id))
  const keyOfWindow = new Map(input.windows.map((w) => [w.id, w.key]))

  const windowMismatch: string[] = []
  for (const s of server ?? []) {
    const listedIn = tabWindow.get(s.id)
    if (listedIn === undefined || !s.windowKey) continue
    const key = keyOfWindow.get(listedIn)
    if (key && key !== s.windowKey) windowMismatch.push(s.id)
  }

  const recordTmux = new Set((records ?? []).map((r) => r.tmuxName).filter((n): n is string => !!n))
  return {
    uiOnly: server ? difference(shown, serverIds) : [],
    serverOnly:
      server && allListed
        ? difference(
            server.map((s) => s.id),
            new Set([...shown, ...hidden])
          )
        : [],
    windowMismatch: windowMismatch.sort(),
    recordsWithoutSession:
      server && records
        ? difference(
            records.map((r) => r.id),
            serverIds
          )
        : [],
    tmuxWithoutRecord:
      live && records
        ? difference(
            live.filter((n) => n.startsWith('clave-')),
            recordTmux
          )
        : [],
    complete: !!server && allListed && !!records && !!live && !input.truncated
  }
}

/** Collect the snapshot. Never rejects for a source; see the module note. */
export async function collectSnapshot(
  sources: TriageSources,
  limitsInput: TriageLimitsInput = {}
): Promise<TriageSnapshot> {
  const limits = { ...DEFAULT_LIMITS, ...limitsInput }
  const ms = limits.sourceTimeoutMs
  const warnings: string[] = []
  const truncated: string[] = []

  // The discovery files and the MCP runtime first: their tokens become known
  // secrets before anything else is scrubbed.
  const bare = createRedactor({ home: sources.home })
  const [shellDisc, serverDisc] = await Promise.all([
    withDeadline(bare, ms, 'the shell discovery file', sources.shellDiscovery),
    withDeadline(bare, ms, 'the server discovery file', sources.serverDiscovery)
  ])
  const shell = shellDisc.status === 'ok' ? shellDisc.value : null
  const serverFile = serverDisc.status === 'ok' ? serverDisc.value : null
  const mcp = (() => {
    try {
      return sources.mcpRuntime()
    } catch {
      return null
    }
  })()
  const redact = createRedactor({
    home: sources.home,
    secrets: [str(shell?.token), str(serverFile?.token), mcp?.token]
  })
  if (shellDisc.status !== 'ok')
    warnings.push(
      `The shell's server discovery file could not be read: ${redact.text(shellDisc.error)}`
    )

  // ── Server mode and ownership ──
  const endpoint = (() => {
    try {
      return sources.endpoint()
    } catch {
      return null
    }
  })()
  const discoveryMode = str(shell?.mode)
  let mode: TriageServerMode =
    discoveryMode === 'in-process' || discoveryMode === 'separate' || discoveryMode === 'attached'
      ? discoveryMode
      : endpoint?.mode === 'in-process'
        ? 'in-process'
        : 'unknown'
  const discoveryShellPid = pidOf(shell?.pid)
  if (shell && discoveryShellPid !== null && discoveryShellPid !== sources.origin.shellPid) {
    warnings.push(
      `The server discovery file was written by pid ${discoveryShellPid}, not this shell (pid ${sources.origin.shellPid}): it may describe another Clave instance.`
    )
    mode = endpoint?.mode === 'in-process' ? 'in-process' : 'unknown'
  }
  const ownership = ownershipOf(mode)
  const url = str(shell?.url) || endpoint?.url || null
  const origin = originOf(url)
  const serverPid =
    mode === 'in-process'
      ? sources.origin.shellPid
      : mode === 'separate'
        ? pidOf(shell?.serverPid)
        : null
  const alive = (pid: number | null): boolean | null => {
    if (pid === null) return null
    try {
      return sources.isAlive(pid)
    } catch {
      return null
    }
  }
  const serverAlive = mode === 'in-process' ? true : alive(serverPid)
  let terminalProcess: TriageServer['terminalProcess'] = null
  if (mode === 'separate') {
    if (serverFile && pidOf(serverFile.pid) === serverPid) {
      const tpid = pidOf(serverFile.terminalProcessPid)
      terminalProcess = {
        pid: tpid,
        alive: alive(tpid),
        generation: num(serverFile.terminalProcessGeneration),
        givenUp: bool(serverFile.terminalProcessGivenUp)
      }
    } else {
      warnings.push(
        serverFile
          ? "The separate server's discovery file names another server process: its terminal process facts are not reported."
          : "The separate server's discovery file could not be read: its terminal process is not reported."
      )
    }
  }
  if (mode === 'separate' && serverAlive === false)
    warnings.push(`The separate server (pid ${serverPid}) is not running.`)
  if (shell && shell.ok === false)
    warnings.push(
      `The server discovery file records a failure: ${redact.text(str(shell.error) ?? 'no reason given', 400)}`
    )

  const health = async (path: string): Promise<{ status: number | null; body: string | null }> => {
    if (!origin) return { status: null, body: null }
    const r = await withDeadline(redact, ms, `GET ${path}`, () => sources.health(origin, path))
    return r.status === 'ok'
      ? { status: r.value.status, body: redact.text(r.value.body, 2000) }
      : { status: null, body: null }
  }

  // ── The rest, in parallel ──
  const recordsDir =
    mode === 'in-process'
      ? `${sources.paths.userData}/session-records`
      : mode === 'separate'
        ? `${sources.paths.serverData}/session-records`
        : null
  const [live, ready, clientsR, sessionsR, processesR, listingsR, recordsR, tmuxR, agentsR] =
    await Promise.all([
      health('/health/live'),
      health('/health/ready'),
      origin
        ? withDeadline(redact, ms, 'the server clients', sources.clients)
        : Promise.resolve<TriageSource<ReadonlyArray<unknown>>>({
            status: 'unavailable',
            error: 'no server address is known'
          }),
      withDeadline(redact, ms, 'the server sessions', sources.sessions),
      withDeadline(redact, ms, 'the process metrics', sources.processes),
      withDeadline(redact, ms + 500, 'the window listings', () => sources.windowListings(ms)),
      recordsDir
        ? withDeadline(redact, ms, 'the session records', () =>
            sources.records(recordsDir, limits.maxRecords)
          )
        : Promise.resolve<TriageSource<{ total: number; files: RawRecordFile[] }>>({
            status: 'unavailable',
            error:
              mode === 'attached'
                ? 'an attached server keeps its session records in its own data directory'
                : 'the server mode is unknown, so is its records directory'
          }),
      withDeadline(redact, ms, 'tmux', sources.tmuxSessions),
      withDeadline(redact, ms, 'the agent updater state', sources.agents)
    ])

  // Records first: the sessions read their user labels off them.
  let records: TriageSnapshot['records']
  const recordById = new Map<string, Record<string, unknown>>()
  if (recordsR.status === 'ok') {
    const items: TriageRecord[] = []
    for (const file of recordsR.value.files.slice(0, limits.maxRecords)) {
      const projected = projectRecord(file, redact)
      if (projected) items.push(projected)
      if (isObject(file.content) && str(file.content.id))
        recordById.set(str(file.content.id)!, file.content)
    }
    if (recordsR.value.total > items.length && recordsR.value.total > limits.maxRecords)
      truncated.push('records')
    records = {
      status: 'ok',
      value: { dir: redact.path(recordsDir!), total: recordsR.value.total, items }
    }
  } else records = recordsR

  let sessions: TriageSource<TriageSession[]>
  if (sessionsR.status === 'ok') {
    const all = sessionsR.value
      .map((s) => projectSession(s, recordById, redact))
      .filter((s): s is TriageSession => s !== null)
    if (all.length > limits.maxSessions) truncated.push('sessions')
    sessions = { status: 'ok', value: all.slice(0, limits.maxSessions) }
  } else sessions = sessionsR

  const clients: TriageSource<TriageClient[]> =
    clientsR.status === 'ok'
      ? {
          status: 'ok',
          value: clientsR.value
            .map((c) => projectClient(c, redact))
            .filter((c): c is TriageClient => c !== null)
            .slice(0, 100)
        }
      : clientsR

  const windows = (() => {
    try {
      return sources.windows().map((w) => ({
        ...w,
        boundSessionIds: w.boundSessionIds.slice(0, limits.maxSessions)
      }))
    } catch (error) {
      warnings.push(`The window registry could not be read: ${errorText(redact, error)}`)
      return [] as TriageWindow[]
    }
  })()

  let windowListings: TriageWindowListing[]
  if (listingsR.status === 'ok') {
    windowListings = listingsR.value.map((reply) => {
      const { listing, truncated: cut } = projectListing(
        reply,
        redact,
        limits.maxSessions,
        limits.maxGroupsPerWindow
      )
      if (cut && !truncated.includes('windowListings')) truncated.push('windowListings')
      return listing
    })
  } else {
    // The fan-out itself failed: every window is said to have failed with it.
    windowListings = windows.map((w) => ({
      windowId: w.id,
      status: listingsR.status,
      error: listingsR.error
    }))
  }

  let tmux: TriageSnapshot['tmux']
  if (tmuxR.status === 'ok') {
    const names = tmuxR.value.map((n) => redact.text(n, 200))
    if (names.length > limits.maxTmux) truncated.push('tmux')
    tmux = { status: 'ok', value: { live: names.slice(0, limits.maxTmux) } }
  } else tmux = tmuxR

  const workspaces = await withDeadline(redact, ms, 'the workspaces', () =>
    sources.workspaces().map((w) => ({
      id: redact.text(w.id, 120),
      name: redact.text(w.name, 120),
      rootDir: redact.text(w.rootDir, 1000)
    }))
  )

  const app = sources.app()
  const snapshot: TriageSnapshot = {
    version: TRIAGE_SNAPSHOT_VERSION,
    generatedAt: sources.now().toISOString(),
    origin: sources.origin,
    app: {
      ...app,
      flags: app.flags.map((f) => redact.text(f, 200)),
      paths: {
        userData: redact.path(app.paths.userData),
        logs: redact.path(app.paths.logs),
        crashDumps: redact.path(app.paths.crashDumps)
      }
    },
    processes: processesR,
    server: {
      mode,
      ownership,
      discoveryOk: bool(shell?.ok),
      discoveryError: str(shell?.error) ? redact.text(str(shell!.error)!, 400) : null,
      origin,
      discoveryShellPid,
      serverPid,
      serverAlive,
      clientId: str(shell?.clientId) ? redact.text(str(shell!.clientId)!, 120) : null,
      version: mode === 'in-process' || mode === 'separate' ? sources.appVersion : 'unknown',
      terminalProcess,
      health: { live: live.status, ready: ready.status, readyBody: ready.body },
      clients
    },
    mcp: { listening: mcp !== null, origin: originOf(mcp?.url ?? null) },
    workspaces,
    windows,
    sessions,
    windowListings,
    records,
    tmux,
    agents:
      agentsR.status === 'ok'
        ? { status: 'ok', value: projectAgents(agentsR.value, redact) }
        : agentsR,
    reconciliation: reconcile({
      sessions,
      listings: windowListings,
      windows,
      records,
      tmux,
      truncated: truncated.length > 0
    }),
    paths: {
      mainLog: redact.path(sources.paths.mainLog),
      sessionRecords: redact.path(recordsDir ?? ''),
      serverData: mode === 'separate' ? redact.path(sources.paths.serverData) : null,
      neverRead: sources.neverRead.map((p) => redact.path(p))
    },
    limits: {
      maxSessions: limits.maxSessions,
      maxRecords: limits.maxRecords,
      maxTmux: limits.maxTmux,
      sourceTimeoutMs: ms,
      truncated
    },
    warnings
  }

  for (const [name, source] of [
    ['server sessions', sessions],
    ['window listings', listingsR],
    ['session records', records],
    ['tmux', tmux],
    ['process metrics', processesR],
    ['server clients', clients],
    ['agent updater state', snapshot.agents]
  ] as const) {
    if (source.status !== 'ok' && source.status !== 'unavailable')
      warnings.push(`The ${name} are incomplete: ${source.error}`)
  }
  if (listingsR.status === 'ok')
    for (const l of windowListings)
      if (l.status !== 'ok') warnings.push(`Window ${l.windowId} did not list its tabs: ${l.error}`)
  if (truncated.length) warnings.push(`Cut at their limit: ${truncated.join(', ')}.`)
  return snapshot
}

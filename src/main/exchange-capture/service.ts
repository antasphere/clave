import { sessionManager } from '../sessions/session-manager'
import { ptyBackend } from '../sessions/adapters/pty-backend'
import type { SessionState } from './types'
import * as path from 'path'
import { app } from 'electron'
import { validateWorkstreamEvent } from './contract/workstream-events'
import { CaptureStore } from './store'
import {
  computeSessionSnapshot,
  listSidecars,
  rootTranscriptPath,
  subagentsDir
} from './transcript'
import type {
  CaptureEvent,
  EndpointIdentity,
  MessageCapturePayload,
  MessageEvent,
  SessionStateCapturePayload,
  SessionStateEvent,
  TabClosedCapturePayload,
  TabClosedEvent,
  TabSpawnCapturePayload,
  TabSpawnEvent,
  UsageSnapshot
} from './types'

/**
 * Exchange-capture service: the main-process owner of the capture store.
 * Capture is observability — it must never fail or delay what it records, so
 * the renderer fires capture IPC without waiting and failures are logged
 * loudly here instead of propagating.
 *
 * Every line written is `v: 2` and is checked against the mirrored contract
 * validator before the append: a line that would not conform is logged with
 * its problems and NOT written (the record's readers type known kinds from
 * their bodies; one malformed body would be a reported problem on every read
 * of every workstream the line lands in). The conformance tests make that
 * branch unreachable for the shapes this file builds.
 */

let store: CaptureStore | null = null

function getStore(): CaptureStore {
  if (!store) store = new CaptureStore(path.join(app.getPath('userData'), 'exchange-capture'))
  return store
}

/** Validate, then append. The one place a line enters the store. */
function write(event: CaptureEvent): void {
  const verdict = validateWorkstreamEvent(event)
  if (!verdict.ok) {
    console.error(
      `[exchange-capture] refusing to write a non-conforming ${event.kind} event: ${verdict.problems.join('; ')}`
    )
    return
  }
  getStore().append(event)
}

function snapshotFor(endpoint: EndpointIdentity): {
  usage: UsageSnapshot | null
  error: string | null
} {
  if (!endpoint.claudeSessionId) {
    return {
      usage: null,
      error: `no token snapshot: "${endpoint.name}" is a ${endpoint.mode} session with no Claude Code transcript`
    }
  }
  try {
    return { usage: computeSessionSnapshot(endpoint.cwd, endpoint.claudeSessionId), error: null }
  } catch (err) {
    const file = rootTranscriptPath(endpoint.cwd, endpoint.claudeSessionId)
    const message = err instanceof Error ? err.message : String(err)
    return { usage: null, error: `transcript unreadable at ${file}: ${message}` }
  }
}

/** Record any not-yet-seen Task-subagent sidecars of an endpoint as
 *  subagent_spawn events. Called at every delivery involving the session —
 *  discovery is lazy by design (Clave does not observe Task spawns live),
 *  and durable from first sight. */
function discoverSubagents(endpoint: EndpointIdentity): void {
  if (!endpoint.claudeSessionId) return
  const captureStore = getStore()
  for (const sidecar of listSidecars(subagentsDir(endpoint.cwd, endpoint.claudeSessionId))) {
    if (captureStore.hasSubagent(endpoint.claudeSessionId, sidecar.agentId)) continue
    const now = new Date().toISOString()
    write({
      v: 2,
      kind: 'subagent_spawn',
      ts: sidecar.spawnedAt ?? now,
      discoveredAt: now,
      session: endpoint,
      agentId: sidecar.agentId,
      prompt: sidecar.prompt,
      transcriptPath: sidecar.transcriptPath
    })
  }
}

export function captureMessage(payload: MessageCapturePayload): void {
  try {
    discoverSubagents(payload.sender)
    discoverSubagents(payload.target)
    const sender = snapshotFor(payload.sender)
    const target = snapshotFor(payload.target)
    const event: MessageEvent = {
      v: 2,
      kind: 'message',
      ts: payload.ts,
      sender: payload.sender,
      target: payload.target,
      text: payload.text,
      provenance: payload.provenance,
      delivered: payload.delivered,
      senderUsage: sender.usage,
      senderUsageError: sender.error,
      targetUsage: target.usage,
      targetUsageError: target.error
    }
    write(event)
  } catch (err) {
    console.error('[exchange-capture] failed to record message delivery', err)
  }
}

export function captureTabSpawn(payload: TabSpawnCapturePayload): void {
  try {
    const event: TabSpawnEvent = { v: 2, kind: 'tab_spawn', ...payload }
    write(event)
  } catch (err) {
    console.error('[exchange-capture] failed to record tab spawn', err)
  }
}

// Writes are synchronous and append-ordered. Renderer identities enrich only
// subsequent transitions; capture never waits for a renderer acknowledgement.
const endpoints = new Map<string, EndpointIdentity>()
const capturedStates = new Map<string, SessionState>()
const managerReports = new Map<string, Pick<SessionStateCapturePayload, 'state' | 'previous'>[]>()

// Terminal acknowledgements can arrive after the manager has forgotten a tab.
// Consult the append-only record for this rare path instead of retaining dead
// session ids or timers forever. No event is rewritten or buffered.
function terminalEventRecorded(id: string): boolean {
  const createdAt = sessionManager.get(id)?.createdAt ?? 0
  const events = getStore().readAll().events
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.kind !== 'session_state' && event.kind !== 'tab_closed') continue
    const session = event.session as EndpointIdentity | undefined
    if (session?.sessionId !== id || Date.parse(event.ts) < createdAt) continue
    return event.kind === 'tab_closed' || event.state === 'exited'
  }
  return false
}

export function forgetCaptureSession(id: string): void {
  endpoints.delete(id)
  capturedStates.delete(id)
  managerReports.delete(id)
}

sessionManager.subscribeRemoved(forgetCaptureSession)

sessionManager.subscribeAll((id, stream) => {
  if (stream.kind !== 'event' || stream.event.type !== 'state_change') return
  // Codex titles and their exit identity remain renderer-owned, as on base.
  // Pi is excluded by the existing exos contract (no Pi EndpointMode).
  const session = sessionManager.get(id)
  if (!session || !['claude', 'claude-agents', 'antigravity'].includes(session.provider)) return
  const state: SessionState =
    stream.event.state === 'ended'
      ? 'exited'
      : stream.event.state === 'working' || stream.event.state === 'blocked'
        ? stream.event.state
        : 'idle'
  // A close is already captured as tab_closed. An adapter's synthetic exit
  // during kill must not invent an additional lifecycle event after it.
  if (state === 'exited' && terminalEventRecorded(id)) {
    forgetCaptureSession(id)
    return
  }
  const previous = capturedStates.get(id) ?? null
  if (state === previous) return
  const pty = ptyBackend.getSession(id)
  const cached = endpoints.get(id)
  const endpoint: EndpointIdentity = {
    sessionId: id,
    name: session.title,
    mode: session.provider as EndpointIdentity['mode'],
    cwd: session.cwd,
    claudeSessionId: pty?.claudeSessionId ?? cached?.claudeSessionId ?? null,
    groupId: session.groupId ?? cached?.groupId ?? null,
    groupName: cached?.groupName ?? null,
    model: pty?.model ?? cached?.model ?? null
  }
  const payload: SessionStateCapturePayload = {
    ts: new Date().toISOString(),
    session: endpoint,
    state,
    previous,
    source: state === 'exited' ? 'pty' : 'hooks'
  }
  recordSessionState(payload)
  capturedStates.set(id, state)
  if (state === 'exited') {
    forgetCaptureSession(id)
    return
  }
  const reports = managerReports.get(id) ?? []
  reports.push({ state, previous })
  managerReports.set(id, reports)
})

function recordSessionState(payload: SessionStateCapturePayload): void {
  try {
    const event: SessionStateEvent = { v: 2, kind: 'session_state', ...payload }
    write(event)
  } catch (err) {
    console.error('[exchange-capture] failed to record session state', err)
  }
}

export function captureSessionState(payload: SessionStateCapturePayload): void {
  const id = payload.session.sessionId
  if (payload.session.mode !== 'codex' && payload.state === 'exited' && terminalEventRecorded(id)) {
    forgetCaptureSession(id)
    return
  }
  endpoints.set(id, payload.session)
  const reports = managerReports.get(id)
  const match =
    reports?.findIndex(
      (report) => report.state === payload.state && report.previous === payload.previous
    ) ?? -1
  if (match >= 0) reports!.splice(match, 1)
  else {
    recordSessionState(payload)
    capturedStates.set(id, payload.state)
  }
  if (payload.state === 'exited') forgetCaptureSession(id)
}

export function captureTabClosed(payload: TabClosedCapturePayload): void {
  try {
    const event: TabClosedEvent = { v: 2, kind: 'tab_closed', ...payload }
    write(event)
    forgetCaptureSession(payload.session.sessionId)
  } catch (err) {
    console.error('[exchange-capture] failed to record tab close', err)
  }
}

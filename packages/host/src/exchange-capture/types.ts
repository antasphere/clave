/**
 * Exchange-capture event schema — Clave is a PRODUCER of the exos workstream
 * event stream (spec §1 of the workstream-dashboard lane, PRDCT-1629).
 *
 * The schema is exos's: `@exos/contract` `workstream-events.ts`, mirrored
 * verbatim in `./contract/workstream-events.ts` (the copy's header names the
 * contract commit it mirrors; the conformance test pins it against the
 * copied fixtures). Clave never depends on exos. What Clave writes:
 *
 *   <userData>/exchange-capture/events.jsonl — ONE append-only JSON Lines
 *   store for the whole install, one event per line, `v: 2`, the
 *   `v`/`kind`/`ts` envelope on every line. `exos workstream capture` tails
 *   it and lands the lines that belong to a workstream into that
 *   workstream's record; Clave itself never writes there and no longer
 *   serves the store to agents (the clave_read_exchanges tool and its reach
 *   gate are gone: the record is the read path).
 *
 * Kinds Clave produces: `message` (each clave_send_to_session delivery, both
 * endpoints' usage snapshots deduplicated per API call), `tab_spawn`
 * (clave_open_session by an agent), `subagent_spawn` (Task sidecars,
 * discovered lazily), `session_state` (each agent-run-state transition),
 * `tab_closed` (a tab closed by the user, an agent, or the app). The sixth
 * kind, `usage_summary`, is the exos CLI's.
 *
 * Lines Clave ≤ 1.66 wrote are `v: 1` (`billed`/`contextOccupancy`, summed
 * per transcript ENTRY — inflated on multi-entry calls); readers keep
 * accepting them, nothing rewrites them.
 */

import type {
  EndpointIdentity,
  MessageEvent,
  SessionStateEvent,
  TabClosedEvent,
  TabSpawnEvent
} from './contract/workstream-events'

export type {
  EndpointIdentity,
  EndpointMode,
  KnownWorkstreamEvent as CaptureEvent,
  MessageEvent,
  ModelUsage,
  SessionState,
  SessionStateEvent,
  SessionStateSource,
  SubagentSpawnEvent,
  TabClosedBy,
  TabClosedEvent,
  TabSpawnEvent,
  UsageSnapshot,
  UsageSnapshotV1,
  WorkstreamEventLine
} from './contract/workstream-events'

/** What the renderer sends over IPC after a delivery — everything except the
 *  usage snapshots, which the main process computes from disk. */
export type MessageCapturePayload = Omit<
  MessageEvent,
  'v' | 'kind' | 'senderUsage' | 'senderUsageError' | 'targetUsage' | 'targetUsageError'
>

export type TabSpawnCapturePayload = Omit<TabSpawnEvent, 'v' | 'kind'>

/** One agent-run-state transition, already MAPPED to the contract's states by
 *  the renderer (Clave's `done` → `idle`; a pty exit → `exited`, source `pty`)
 *  and already deduplicated on the mapped state (a no-op transition never
 *  reaches the main process). */
export type SessionStateCapturePayload = Omit<SessionStateEvent, 'v' | 'kind'>

/** A tab closed: `by: 'user'` from the UI (sidebar, header, Cmd+Backspace),
 *  `'agent'` from clave_close_session (`closer` = the calling tab), `'app'`
 *  from a kill-all. An app QUIT emits nothing: the session survives in tmux. */
export type TabClosedCapturePayload = Omit<TabClosedEvent, 'v' | 'kind'>

/** Re-exported so renderer code that only needs the identity shape keeps one import. */
export type CaptureEndpoint = EndpointIdentity

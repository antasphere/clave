/* eslint-disable */
// MIRROR of @exos/contract packages/contract/src/workstream-events.ts at exos commit 4fa4886
// (antasphere/exos, branch feat/prdct-1629-event-stream). Clave never depends on exos: this file is a
// verbatim copy of the contract module — regenerate it with scripts/sync-exos-contract.sh, never
// edit it by hand. The conformance test (contract.test.ts) pins it against the copied fixtures.
/**
 * The workstream event stream — the settled cross-product contract (spec §1,
 * Lane · workstream-dashboard, 2026-08-21).
 *
 * One workstream = one `knowledge/workstreams/artefacts/<stem>/events.jsonl`,
 * JSON Lines, append-only, one event per line, appended as the producer stored
 * it. Exos OWNS this schema; producers conform to it. Clave is the first
 * producer (it mirrors this file verbatim — `@exos/contract` is private and
 * Clave never depends on exos — with the contract commit sha in the copy's
 * header); any other harness can write the same lines. The exos CLI is the
 * only thing that lands lines into a workstream record (`exos workstream
 * capture`), and the only thing that reads them back (`events`, `stats`,
 * `log`, the viewer).
 *
 * Three layers, deliberately separate:
 * - the ENVELOPE (`v`, `kind`, `ts`) — the only thing lint validates on a
 *   stored line; identical predicate in the CLI and in exos-sync lint;
 * - the BODIES per kind, validated here (`validateWorkstreamEvent`) by every
 *   reader that wants typed events and by every producer's conformance test;
 *   unknown kinds pass with their envelope (kinds are additive);
 * - the USAGE READER (§1.4) — the normative algorithm that turns a Claude Code
 *   transcript into a `UsageSnapshot`, deduplicated per API call. Pure over
 *   parsed JSON Lines (no fs, no Electron, no node built-ins), so the CLI
 *   imports it and Clave mirrors it, and ONE fixture pins both.
 *
 * Version: `v: 2` is this shape. `v: 1` lines are the legacy Clave ≤ 1.66
 * shape (§1.7): readers accept them, label their numbers "legacy per-entry
 * sum", and never rewrite them.
 */

// ─── Version + kinds ─────────────────────────────────────────────────────────

export const WORKSTREAM_EVENT_VERSION = 2 as const;

export const WORKSTREAM_EVENT_KINDS = [
  "message",
  "tab_spawn",
  "subagent_spawn",
  "session_state",
  "tab_closed",
  "usage_summary",
] as const;
export type WorkstreamEventKind = (typeof WORKSTREAM_EVENT_KINDS)[number];

// ─── Endpoint identity (§1.1) ────────────────────────────────────────────────

/** The tab modes a producer may stamp. Clave emits every value but `gemini`
 *  today (its Gemini CLI mode was retired into Antigravity); the list stays a
 *  superset so a producer that still runs Gemini conforms. */
export const ENDPOINT_MODES = [
  "claude",
  "antigravity",
  "gemini",
  "codex",
  "claude-agents",
  "terminal",
] as const;
export type EndpointMode = (typeof ENDPOINT_MODES)[number];

/**
 * Identity of one endpoint of an event, stamped AT CAPTURE TIME: events keep
 * the names and group membership that were true when they happened. A
 * session has two ids — the producer's tab id (`sessionId`, what the clave_*
 * tools use) and the Claude Code host session id (`claudeSessionId`, the
 * transcript stem, `CLAUDE_CODE_SESSION_ID`); the pair is one LOGICAL session.
 */
export interface EndpointIdentity {
  sessionId: string;
  name: string;
  mode: EndpointMode;
  cwd: string;
  /** null for tabs with no Claude Code transcript (terminals, other CLIs). */
  claudeSessionId: string | null;
  groupId: string | null;
  groupName: string | null;
  /** ADDITIVE (v2): the model the tab was opened with, when the producer knows
   *  it. Absent = unknown; null = known to be the CLI's default. */
  model?: string | null;
}

// ─── Usage snapshot (§1.2): per model, deduplicated per API call ─────────────

export interface ModelUsage {
  /** Distinct API calls (distinct `message.id`), never transcript entries. */
  calls: number;
  /** usage.input_tokens */
  input: number;
  /** usage.output_tokens */
  output: number;
  /** usage.cache_creation_input_tokens */
  cacheWrite: number;
  /** usage.cache_read_input_tokens */
  cacheRead: number;
  /** OPTIONAL, additive: usage.cache_creation.ephemeral_1h_input_tokens when
   *  present (priced 2× the 5-minute write). */
  cacheWrite1h?: number;
  /** OPTIONAL, additive: usage.cache_creation.ephemeral_5m_input_tokens when present. */
  cacheWrite5m?: number;
}

export interface UsageSnapshot {
  /** When the reader ran (ISO UTC). */
  computedAt: string;
  cumulative: {
    /** Root transcript AND every Task sidecar, keyed by `message.model`
     *  (`unknown` when an entry carries none). Spend over the whole transcript. */
    byModel: Record<string, ModelUsage>;
    /** The sidecar share ALREADY INCLUDED above, broken out. `count` is the
     *  number of sidecar files listed, readable or not. */
    subagents: { count: number; byModel: Record<string, ModelUsage> };
  };
  context: {
    /** Occupancy of the ROOT window: input + cacheWrite + cacheRead of the
     *  latest completed root call. How full the window is now, not spend. */
    tokens: number;
    /** Timestamp of that transcript entry; null when no usage-bearing entry yet. */
    asOf: string | null;
  };
}

// ─── Legacy v1 (Clave ≤ 1.66, §1.7): read, label, never rewrite ──────────────

/** The four flat counters of a v1 snapshot, summed per transcript ENTRY (so
 *  inflated ~3–4× on multi-entry calls). `contextOccupancy` was correct. */
export interface BilledCountersV1 {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  apiCalls: number;
}

export interface UsageSnapshotV1 {
  computedAt: string;
  billed: BilledCountersV1 & { subagents: BilledCountersV1 & { count: number } };
  contextOccupancy: { tokens: number; asOf: string | null };
}

// ─── Kinds (§1.3) ────────────────────────────────────────────────────────────

export interface WorkstreamEventEnvelope {
  v: typeof WORKSTREAM_EVENT_VERSION;
  kind: WorkstreamEventKind;
  /** Producer-side, ISO 8601 with an explicit timezone (producers write the
   *  `toISOString()` form). Trusted as data; readers sort by it, never reject. */
  ts: string;
}

/** A `clave_send_to_session` delivery (or any producer's cross-session message). */
export interface MessageEvent extends WorkstreamEventEnvelope {
  kind: "message";
  sender: EndpointIdentity;
  target: EndpointIdentity;
  /** The message without the provenance header. */
  text: string;
  /** The header the producer stamped on delivery. */
  provenance: string;
  delivered: boolean;
  senderUsage: UsageSnapshot | null;
  senderUsageError: string | null;
  targetUsage: UsageSnapshot | null;
  targetUsageError: string | null;
}

/** A sibling tab opened by an agent. */
export interface TabSpawnEvent extends WorkstreamEventEnvelope {
  kind: "tab_spawn";
  spawner: EndpointIdentity;
  session: EndpointIdentity;
  prompt: string | null;
  model: string | null;
}

/** A Task-subagent fan-out, discovered lazily from a sidecar transcript.
 *  `ts` is the true spawn time; the line is appended at `discoveredAt`. */
export interface SubagentSpawnEvent extends WorkstreamEventEnvelope {
  kind: "subagent_spawn";
  discoveredAt: string;
  /** The parent (root) session. */
  session: EndpointIdentity;
  agentId: string;
  prompt: string | null;
  transcriptPath: string;
}

export const SESSION_STATES = ["working", "idle", "blocked", "exited"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const SESSION_STATE_SOURCES = ["hooks", "pty"] as const;
export type SessionStateSource = (typeof SESSION_STATE_SOURCES)[number];

/** One agent-run-state transition. Mapping from Clave's `AgentRunState`:
 *  working → working; idle and done → idle; blocked (a permission or input
 *  prompt is waiting) → blocked; a pty exit → exited (source `pty`). One
 *  event per transition, none on a no-op. "Waiting for an answer" is NOT a
 *  state: readers derive it from messages. */
export interface SessionStateEvent extends WorkstreamEventEnvelope {
  kind: "session_state";
  session: EndpointIdentity;
  state: SessionState;
  previous: SessionState | null;
  source: SessionStateSource;
}

export const TAB_CLOSED_BY = ["user", "agent", "app"] as const;
export type TabClosedBy = (typeof TAB_CLOSED_BY)[number];

/** Emitted once when a tab is closed; a `session_state: exited` may precede
 *  it. Carries the full identity so the record survives the tab's deletion.
 *  `by`: `user` = a UI close (sidebar, header, Cmd+Backspace; `closer` null),
 *  `agent` = the close tool called from another agent tab (`closer` = that
 *  tab), `app` = an app-initiated kill-all (Clave's reset). An app QUIT emits
 *  no `tab_closed`: the session survives in tmux and is re-adopted at the next
 *  launch, so it was never closed. */
export interface TabClosedEvent extends WorkstreamEventEnvelope {
  kind: "tab_closed";
  session: EndpointIdentity;
  by: TabClosedBy;
  /** The agent tab that called the close tool, else null. */
  closer: EndpointIdentity | null;
}

export const USAGE_SUMMARY_SOURCES = ["transcript", "last-snapshot"] as const;
export type UsageSummarySource = (typeof USAGE_SUMMARY_SOURCES)[number];

/** Written by the exos CLI (`capture --summarize`), one per logical session:
 *  the session's authoritative total at the time of the pass. Readers use
 *  the LATEST per session. */
export interface UsageSummaryEvent extends WorkstreamEventEnvelope {
  kind: "usage_summary";
  /** As last seen in the workstream's events; a registered session that
   *  never appeared gets a minimal identity (empty sessionId and name,
   *  mode claude, null group). */
  session: EndpointIdentity;
  usage: UsageSnapshot;
  source: UsageSummarySource;
  transcriptPath: string | null;
}

/** The six v2 kinds. */
export type KnownWorkstreamEvent =
  | MessageEvent
  | TabSpawnEvent
  | SubagentSpawnEvent
  | SessionStateEvent
  | TabClosedEvent
  | UsageSummaryEvent;

/**
 * Any stored line with a valid envelope, as stored: a legacy `v: 1` line, or
 * a `v: 2` line of a kind this contract version does not know. Readers render
 * the envelope and move on.
 */
export interface WorkstreamEventLine {
  v: number;
  kind: string;
  ts: string;
  [key: string]: unknown;
}

/** What `validateWorkstreamEvent` hands back on success: a typed v2 event when
 *  the kind is known, else the envelope-valid line as stored. Narrow with
 *  `isKnownWorkstreamEvent`. */
export type WorkstreamEvent = KnownWorkstreamEvent | WorkstreamEventLine;

export function isKnownWorkstreamEvent(event: WorkstreamEvent): event is KnownWorkstreamEvent {
  return (
    event.v === WORKSTREAM_EVENT_VERSION &&
    (WORKSTREAM_EVENT_KINDS as readonly string[]).includes(event.kind)
  );
}

/** The endpoint identities an event carries, per kind (§1.5). A v1 line of a
 *  known kind has the same endpoint fields (identity never changed shape), so
 *  the join rule works on legacy lines too; an unknown kind has none. */
export function workstreamEventEndpoints(event: WorkstreamEventLine): EndpointIdentity[] {
  const pick = (key: string): EndpointIdentity | null => {
    const value = event[key];
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as EndpointIdentity)
      : null;
  };
  const keys =
    event.kind === "message"
      ? ["sender", "target"]
      : event.kind === "tab_spawn"
        ? ["spawner", "session"]
        : (WORKSTREAM_EVENT_KINDS as readonly string[]).includes(event.kind)
          ? ["session"]
          : [];
  return keys.map(pick).filter((e): e is EndpointIdentity => e !== null);
}

// ─── Roles (§3.3) and headlines (§4.2) — vocabularies exos owns ──────────────

export const WORKSTREAM_SESSION_ROLES = [
  "orchestrator",
  "implementer",
  "verifier",
  "coordination",
  "publisher",
] as const;
export type WorkstreamSessionRole = (typeof WORKSTREAM_SESSION_ROLES)[number];

/** The closed headline list (§4.2), 30 markers in three classes. The class of
 *  a few depends on who sends it to whom; readers derive that from the
 *  sessions' roles. A first line matching nothing is a plain message. */
export const WORKSTREAM_HEADLINES = [
  "SPEC READY",
  "RULING NEEDED",
  "DESIGN PREVIEW",
  "GATES GREEN",
  "VERDICT",
  "BLOCKED",
  "STATUS",
  "SPEC APPROVED",
  "SPEC AMENDED",
  "RULING",
  "SCOPE",
  "LOOK APPROVED",
  "MERGED",
  "WORKSTREAM OPEN",
  "ASSIGNMENT",
  "SPAWNED",
  "REGISTERED",
  "EXPLORATION DONE",
  "FLAG",
  "BUILD UPDATE",
  "HOLD",
  "FINDING",
  "FINDING FIXED",
  "CORRECTION",
  "REBASE",
  "RECONFIRMED",
  "QUESTION",
  "RELEASED",
  "ACK",
  "LANE DONE",
] as const;
export type WorkstreamHeadline = (typeof WORKSTREAM_HEADLINES)[number];

/**
 * The §4.1 grammar: take the first line, match the LONGEST leading sequence of
 * capital words against the list (`FINDING FIXED` before `FINDING`, `SPEC
 * READY` before nothing), and return the marker or null. Free text may follow
 * after ` · `, `: `, ` — ` or any non-word boundary.
 */
export function parseWorkstreamHeadline(text: string): WorkstreamHeadline | null {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const m = /^\s*((?:[A-Z]+)(?:\s+[A-Z]+)*)(?![A-Za-z])/.exec(first);
  if (!m || m[1] === undefined) return null;
  const words = m[1].trim().split(/\s+/);
  for (let n = words.length; n >= 1; n--) {
    const candidate = words.slice(0, n).join(" ");
    if ((WORKSTREAM_HEADLINES as readonly string[]).includes(candidate)) {
      return candidate as WorkstreamHeadline;
    }
  }
  return null;
}

// ─── Validation (envelope strict; body per known kind) ───────────────────────

/** ISO 8601 with an explicit timezone (Z or offset); seconds optional,
 *  fractional seconds allowed. Same predicate as the CLI readback and
 *  exos-sync lint: "parseable" must be a deterministic rule. */
export const WORKSTREAM_EVENT_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function validCalendarDay(ts: string): boolean {
  const year = Number(ts.slice(0, 4));
  const month = Number(ts.slice(5, 7));
  const day = Number(ts.slice(8, 10));
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** True for a string this contract accepts as an event timestamp. */
export function isWorkstreamEventTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    WORKSTREAM_EVENT_TIMESTAMP.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    validCalendarDay(value)
  );
}

/**
 * The envelope verdict for one parsed line: null when valid, else the reason
 * clause. Implemented identically by exos-sync lint — one format, two
 * parsers, identical answers.
 */
export function workstreamEnvelopeProblem(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "an event must be a JSON object";
  }
  const event = value as Record<string, unknown>;
  if (typeof event["v"] !== "number") {
    return `\`v\` must be a number, got ${JSON.stringify(event["v"]) ?? "undefined"}`;
  }
  if (typeof event["kind"] !== "string" || event["kind"].trim() === "") {
    return `\`kind\` must be a non-empty string, got ${JSON.stringify(event["kind"]) ?? "undefined"}`;
  }
  if (!isWorkstreamEventTimestamp(event["ts"])) {
    return `\`ts\` must be ISO 8601 with an explicit timezone (Z or an offset), got ${JSON.stringify(event["ts"]) ?? "undefined"}`;
  }
  return null;
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function checkString(o: Obj, key: string, at: string, problems: string[]): void {
  if (typeof o[key] !== "string") problems.push(`${at}.${key} must be a string`);
}

function checkNullableString(o: Obj, key: string, at: string, problems: string[]): void {
  if (o[key] !== null && typeof o[key] !== "string") {
    problems.push(`${at}.${key} must be a string or null`);
  }
}

function checkEnum(
  o: Obj,
  key: string,
  values: readonly string[],
  at: string,
  problems: string[],
  nullable = false,
): void {
  const v = o[key];
  if (nullable && v === null) return;
  if (typeof v !== "string" || !values.includes(v)) {
    problems.push(`${at}.${key} must be one of ${values.join(" | ")}${nullable ? " | null" : ""}`);
  }
}

function checkIdentity(value: unknown, at: string, problems: string[]): void {
  if (!isObj(value)) {
    problems.push(`${at} must be an endpoint identity object`);
    return;
  }
  checkString(value, "sessionId", at, problems);
  checkString(value, "name", at, problems);
  checkEnum(value, "mode", ENDPOINT_MODES, at, problems);
  checkString(value, "cwd", at, problems);
  checkNullableString(value, "claudeSessionId", at, problems);
  checkNullableString(value, "groupId", at, problems);
  checkNullableString(value, "groupName", at, problems);
  if (value["model"] !== undefined) checkNullableString(value, "model", at, problems);
}

function checkModelUsageMap(value: unknown, at: string, problems: string[]): void {
  if (!isObj(value)) {
    problems.push(`${at} must be an object keyed by model`);
    return;
  }
  for (const [model, usage] of Object.entries(value)) {
    const here = `${at}[${JSON.stringify(model)}]`;
    if (!isObj(usage)) {
      problems.push(`${here} must be a ModelUsage object`);
      continue;
    }
    for (const key of ["calls", "input", "output", "cacheWrite", "cacheRead"]) {
      if (!isCount(usage[key])) problems.push(`${here}.${key} must be a finite number ≥ 0`);
    }
    for (const key of ["cacheWrite1h", "cacheWrite5m"]) {
      if (usage[key] !== undefined && !isCount(usage[key])) {
        problems.push(`${here}.${key} must be a finite number ≥ 0 when present`);
      }
    }
  }
}

function checkSnapshot(value: unknown, at: string, problems: string[], nullable: boolean): void {
  if (nullable && value === null) return;
  if (!isObj(value)) {
    problems.push(`${at} must be a UsageSnapshot${nullable ? " or null" : ""}`);
    return;
  }
  checkString(value, "computedAt", at, problems);
  const cumulative = value["cumulative"];
  if (!isObj(cumulative)) {
    problems.push(`${at}.cumulative must be an object`);
  } else {
    checkModelUsageMap(cumulative["byModel"], `${at}.cumulative.byModel`, problems);
    const subagents = cumulative["subagents"];
    if (!isObj(subagents)) {
      problems.push(`${at}.cumulative.subagents must be an object`);
    } else {
      if (!isCount(subagents["count"]) || !Number.isInteger(subagents["count"])) {
        problems.push(`${at}.cumulative.subagents.count must be an integer ≥ 0`);
      }
      checkModelUsageMap(subagents["byModel"], `${at}.cumulative.subagents.byModel`, problems);
    }
  }
  const context = value["context"];
  if (!isObj(context)) {
    problems.push(`${at}.context must be an object`);
  } else {
    if (!isCount(context["tokens"])) problems.push(`${at}.context.tokens must be a finite number ≥ 0`);
    checkNullableString(context, "asOf", `${at}.context`, problems);
  }
}

function checkBody(kind: WorkstreamEventKind, e: Obj, problems: string[]): void {
  switch (kind) {
    case "message":
      checkIdentity(e["sender"], "sender", problems);
      checkIdentity(e["target"], "target", problems);
      checkString(e, "text", "message", problems);
      checkString(e, "provenance", "message", problems);
      if (typeof e["delivered"] !== "boolean") problems.push("message.delivered must be a boolean");
      checkSnapshot(e["senderUsage"], "senderUsage", problems, true);
      checkSnapshot(e["targetUsage"], "targetUsage", problems, true);
      checkNullableString(e, "senderUsageError", "message", problems);
      checkNullableString(e, "targetUsageError", "message", problems);
      return;
    case "tab_spawn":
      checkIdentity(e["spawner"], "spawner", problems);
      checkIdentity(e["session"], "session", problems);
      checkNullableString(e, "prompt", "tab_spawn", problems);
      checkNullableString(e, "model", "tab_spawn", problems);
      return;
    case "subagent_spawn":
      checkString(e, "discoveredAt", "subagent_spawn", problems);
      checkIdentity(e["session"], "session", problems);
      checkString(e, "agentId", "subagent_spawn", problems);
      checkNullableString(e, "prompt", "subagent_spawn", problems);
      checkString(e, "transcriptPath", "subagent_spawn", problems);
      return;
    case "session_state":
      checkIdentity(e["session"], "session", problems);
      checkEnum(e, "state", SESSION_STATES, "session_state", problems);
      checkEnum(e, "previous", SESSION_STATES, "session_state", problems, true);
      checkEnum(e, "source", SESSION_STATE_SOURCES, "session_state", problems);
      return;
    case "tab_closed":
      checkIdentity(e["session"], "session", problems);
      checkEnum(e, "by", TAB_CLOSED_BY, "tab_closed", problems);
      if (e["closer"] !== null) checkIdentity(e["closer"], "closer", problems);
      return;
    case "usage_summary":
      checkIdentity(e["session"], "session", problems);
      checkSnapshot(e["usage"], "usage", problems, false);
      checkEnum(e, "source", USAGE_SUMMARY_SOURCES, "usage_summary", problems);
      checkNullableString(e, "transcriptPath", "usage_summary", problems);
      return;
  }
}

export type WorkstreamEventValidation =
  | { ok: true; event: WorkstreamEvent; problems: [] }
  | { ok: false; problems: string[] };

/**
 * Validate one parsed line. The envelope is strict for every line. The body
 * is checked per known kind when `v` is this contract's version; a `v: 2`
 * line of an unknown kind passes with `ok: true` and no problems (kinds are
 * additive); a `v: 1` line passes on its envelope alone (the legacy shape is
 * documented, not enforced — it was never validated when written).
 */
export function validateWorkstreamEvent(value: unknown): WorkstreamEventValidation {
  const envelope = workstreamEnvelopeProblem(value);
  if (envelope !== null) return { ok: false, problems: [envelope] };
  const e = value as Obj;
  const kind = e["kind"] as string;
  if (
    e["v"] === WORKSTREAM_EVENT_VERSION &&
    (WORKSTREAM_EVENT_KINDS as readonly string[]).includes(kind)
  ) {
    const problems: string[] = [];
    checkBody(kind as WorkstreamEventKind, e, problems);
    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, event: e as unknown as KnownWorkstreamEvent, problems: [] };
  }
  return { ok: true, event: e as unknown as WorkstreamEventLine, problems: [] };
}

/** True for a v1 (legacy) usage snapshot value, the `billed`/`contextOccupancy`
 *  shape Clave ≤ 1.66 wrote on every `message` line. */
export function isUsageSnapshotV1(value: unknown): value is UsageSnapshotV1 {
  if (!isObj(value)) return false;
  const billed = value["billed"];
  const occ = value["contextOccupancy"];
  return (
    typeof value["computedAt"] === "string" &&
    isObj(billed) &&
    isCount(billed["apiCalls"]) &&
    isCount(billed["totalTokens"]) &&
    isObj(occ) &&
    isCount(occ["tokens"])
  );
}

/** True for a v2 usage snapshot value. */
export function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  const problems: string[] = [];
  checkSnapshot(value, "snapshot", problems, false);
  return problems.length === 0;
}

/**
 * The idempotence normalization (§1.6): a stored line's canonical text is
 * `JSON.stringify(JSON.parse(line))`, so a re-serialized copy and its source
 * collapse to one key. The hash itself (sha256 of these bytes) is the
 * landing tool's; the contract only pins what is hashed. Returns null for a
 * line that is not JSON.
 */
export function normalizeWorkstreamEventLine(line: string): string | null {
  try {
    return JSON.stringify(JSON.parse(line));
  } catch {
    return null;
  }
}

// ─── Transcript layout (shared by every reader) ──────────────────────────────

/** Claude Code's project-directory encoding of a cwd: `/` and `.` → `-`. */
export function transcriptProjectDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** Root transcript and sidecar directory, RELATIVE to `~/.claude/projects/`
 *  (the reader stays path-library-free; callers join with their home). */
export function transcriptRelPaths(
  cwd: string,
  claudeSessionId: string,
): { root: string; subagentsDir: string } {
  const dir = transcriptProjectDirName(cwd);
  return {
    root: `${dir}/${claudeSessionId}.jsonl`,
    subagentsDir: `${dir}/${claudeSessionId}/subagents`,
  };
}

// ─── The usage reader (§1.4, normative) ──────────────────────────────────────

/** Parse JSON Lines into values; unparseable lines are counted, never fatal. */
export function parseTranscriptLines(text: string): { entries: unknown[]; skipped: number } {
  const entries: unknown[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      skipped++;
    }
  }
  return { entries, skipped };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function emptyModelUsage(): ModelUsage {
  return { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

/** Add `from` into `into` per model (the optional cache-write split is
 *  carried only when at least one side carries it). */
export function mergeModelUsage(
  into: Record<string, ModelUsage>,
  from: Record<string, ModelUsage>,
): void {
  for (const [model, usage] of Object.entries(from)) {
    const target = into[model] ?? emptyModelUsage();
    target.calls += usage.calls;
    target.input += usage.input;
    target.output += usage.output;
    target.cacheWrite += usage.cacheWrite;
    target.cacheRead += usage.cacheRead;
    if (usage.cacheWrite1h !== undefined || target.cacheWrite1h !== undefined) {
      target.cacheWrite1h = (target.cacheWrite1h ?? 0) + (usage.cacheWrite1h ?? 0);
    }
    if (usage.cacheWrite5m !== undefined || target.cacheWrite5m !== undefined) {
      target.cacheWrite5m = (target.cacheWrite5m ?? 0) + (usage.cacheWrite5m ?? 0);
    }
    into[model] = target;
  }
}

/** A reader-side total over a per-model map (never stored). */
export function sumModelUsage(byModel: Record<string, ModelUsage>): ModelUsage {
  const holder: Record<string, ModelUsage> = { all: emptyModelUsage() };
  for (const usage of Object.values(byModel)) mergeModelUsage(holder, { all: usage });
  return holder["all"] ?? emptyModelUsage();
}

export interface TranscriptUsage {
  /** Per model, deduplicated per API call (steps 2–4). */
  byModel: Record<string, ModelUsage>;
  /** Step 5, root files only: the latest non-sidechain usage-bearing entry. */
  context: { tokens: number; asOf: string | null };
  /** Usage-bearing assistant entries seen (before dedup) — what a naive
   *  per-entry sum would have counted as calls. Diagnostic only. */
  entries: number;
}

/**
 * Steps 2–5 of §1.4 over ONE transcript's parsed entries.
 *
 * 2. Keep entries with `type === 'assistant'` and an object `message.usage`.
 * 3. Deduplicate by `message.id`: one streamed API call is stored as several
 *    entries (thinking, text, each tool_use) sharing one id; the LAST entry
 *    of each id in file order wins (all entries of an id carry identical usage
 *    today; taking the last keeps the rule right if a runtime ever writes
 *    progressive usage). An entry without an id is its own call.
 * 4. Per distinct id: model = `message.model ?? 'unknown'`; calls += 1; the
 *    four counters from `usage`; the optional 1h/5m split from
 *    `usage.cache_creation` when it is an object. Missing or non-finite
 *    numbers count 0.
 * 5. Context: among entries with `isSidechain !== true`, the LAST
 *    usage-bearing entry in file order gives tokens = input + cacheWrite +
 *    cacheRead of that single call, and asOf = its `timestamp`.
 */
export function readTranscriptUsage(entries: unknown[]): TranscriptUsage {
  const lastById = new Map<string, Obj>();
  let anonymous = 0;
  let entryCount = 0;
  const context: TranscriptUsage["context"] = { tokens: 0, asOf: null };
  for (const value of entries) {
    if (!isObj(value) || value["type"] !== "assistant") continue;
    const message = value["message"];
    if (!isObj(message)) continue;
    const usage = message["usage"];
    if (!isObj(usage)) continue;
    entryCount++;
    const id = typeof message["id"] === "string" && message["id"] !== "" ? message["id"] : `#anon-${anonymous++}`;
    lastById.delete(id);
    lastById.set(id, value);
    if (value["isSidechain"] !== true) {
      context.tokens =
        num(usage["input_tokens"]) +
        num(usage["cache_creation_input_tokens"]) +
        num(usage["cache_read_input_tokens"]);
      context.asOf = typeof value["timestamp"] === "string" ? value["timestamp"] : null;
    }
  }
  const byModel: Record<string, ModelUsage> = {};
  for (const value of lastById.values()) {
    const message = value["message"] as Obj;
    const usage = message["usage"] as Obj;
    const model = typeof message["model"] === "string" && message["model"] !== "" ? message["model"] : "unknown";
    const one: ModelUsage = {
      calls: 1,
      input: num(usage["input_tokens"]),
      output: num(usage["output_tokens"]),
      cacheWrite: num(usage["cache_creation_input_tokens"]),
      cacheRead: num(usage["cache_read_input_tokens"]),
    };
    const split = usage["cache_creation"];
    if (isObj(split)) {
      one.cacheWrite1h = num(split["ephemeral_1h_input_tokens"]);
      one.cacheWrite5m = num(split["ephemeral_5m_input_tokens"]);
    }
    mergeModelUsage(byModel, { [model]: one });
  }
  return { byModel, context, entries: entryCount };
}

/**
 * The whole snapshot (§1.4 steps 1–7 minus the file reads): the root
 * transcript's parsed entries plus one parsed-entries array per sidecar file
 * LISTED (null for a sidecar that could not be read — it still counts). The
 * sidecar share goes into `cumulative.subagents` AND into `cumulative.byModel`.
 */
export function computeUsageSnapshot(
  rootEntries: unknown[],
  sidecars: ReadonlyArray<unknown[] | null>,
  computedAt: string,
): UsageSnapshot {
  const root = readTranscriptUsage(rootEntries);
  const subagents: Record<string, ModelUsage> = {};
  for (const sidecar of sidecars) {
    if (sidecar === null) continue;
    mergeModelUsage(subagents, readTranscriptUsage(sidecar).byModel);
  }
  const byModel: Record<string, ModelUsage> = {};
  mergeModelUsage(byModel, root.byModel);
  mergeModelUsage(byModel, subagents);
  return {
    computedAt,
    cumulative: { byModel, subagents: { count: sidecars.length, byModel: subagents } },
    context: root.context,
  };
}

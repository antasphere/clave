/**
 * The routines domain (ADR 0004, PRDCT-4102): the agent sessions a `.clave`
 * file schedules, run by the server by itself. The server owns the scheduler
 * (it reads the routines off the workspace files it already trusts, decides
 * when an occurrence is due, claims it so no other server runs it, starts
 * the hidden session, watches it, takes its report and writes its deck); the
 * windows read the routines and their runs back, ask for a run by hand,
 * dismiss a run's badge and open a run's discussion. The report tool the
 * agent calls (`clave_routine_report`, in both MCP servers) is a thin arm
 * over `ReportRoutineRun`.
 */
import { Schema } from 'effect'
import { Command, Query } from '@structure-ai/cqrs'

// ---------------------------------------------------------------------------
// The declaration, as the scheduler sees it: resolved from a `.clave` group.
// ---------------------------------------------------------------------------

/** The agent a routine runs on, the `clave_open_session` modes less the terminal. */
export const RoutineAgent = Schema.Literal('claude', 'codex', 'pi', 'antigravity')
export type RoutineAgent = typeof RoutineAgent.Type
/** The form the agent opens in: the chat view (an events session) or a terminal (a PTY). */
export const RoutineForm = Schema.Literal('chat', 'terminal')
export type RoutineForm = typeof RoutineForm.Type
/** Where "once" is counted: once per machine (built), once for the team (refused until a shared claim exists). */
export const RoutineScope = Schema.Literal('machine', 'team')
export type RoutineScope = typeof RoutineScope.Type

/** Every launch parameter a person chooses when opening a tab, each optional:
 *  a missing one falls back to the workspace's launch defaults exactly as
 *  `clave_open_session` resolves them, and an invalid one fails the run. */
export const RoutineLaunch = Schema.Struct({
  agent: Schema.optional(RoutineAgent),
  form: Schema.optional(RoutineForm),
  model: Schema.optional(Schema.String),
  /** Claude's reasoning effort, in the CLI's own word. */
  effort: Schema.optional(Schema.String),
  /** Pi's thinking level and provider. */
  thinking: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  /** A launch profile by id or name (ADR 0001). */
  profile: Schema.optional(Schema.String),
  /** An account by id or label, or `any` for the pool (ADR 0002). */
  account: Schema.optional(Schema.String),
  /** Permissions off: Claude's skip flag, Codex's yolo. */
  dangerousMode: Schema.optional(Schema.Boolean),
  /** The mode a Claude run without `dangerousMode` asks under. */
  permissionMode: Schema.optional(Schema.Literal('default', 'acceptEdits', 'plan'))
})
export type RoutineLaunch = typeof RoutineLaunch.Type

/** The deck the run's report is written into: the template folder and the
 *  schema its data is validated against, both absolute once resolved, and
 *  the panel's ideal size in CSS pixels. */
export const RoutineReportSpec = Schema.Struct({
  template: Schema.String,
  schema: Schema.String,
  width: Schema.Number,
  height: Schema.Number
})
export type RoutineReportSpec = typeof RoutineReportSpec.Type

export const RoutineDeclaration = Schema.Struct({
  /** `<file path>::<name>`: the identity of the routine and of its history. */
  key: Schema.String,
  name: Schema.String,
  /** The `.clave` file it was read from, its root dir, and the group it sits in. */
  file: Schema.String,
  rootDir: Schema.String,
  group: Schema.String,
  workspaceId: Schema.String,
  workspaceName: Schema.String,
  /** The five-field cron expression, as written. */
  schedule: Schema.String,
  /** The job, after `{{param}}` substitution and the `@`-tokens. */
  prompt: Schema.String,
  skill: Schema.NullOr(Schema.String),
  /** Absolute: the group's cwd when the routine names none. */
  cwd: Schema.String,
  launch: RoutineLaunch,
  icon: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  catchUp: Schema.Boolean,
  timeoutMinutes: Schema.Number,
  scope: RoutineScope,
  report: RoutineReportSpec,
  /** Why this routine can never run as declared (an unknown scope, a
   *  schedule that does not parse, a template outside the file's folder):
   *  shown on the badge, every occurrence recorded as failed with it. */
  invalid: Schema.NullOr(Schema.String)
})
export type RoutineDeclaration = typeof RoutineDeclaration.Type

// ---------------------------------------------------------------------------
// A run.
// ---------------------------------------------------------------------------

/** What the agent reported, or that it did not. */
export const RoutineStatus = Schema.Literal('ok', 'attention', 'failed')
export type RoutineStatus = typeof RoutineStatus.Type
/** Where a run stands: in flight, waiting on the person (a permission, a
 *  question nobody answers), or ended with its status. */
export const RoutineRunState = Schema.Literal('running', 'waiting', 'ok', 'attention', 'failed')
export type RoutineRunState = typeof RoutineRunState.Type
export const RoutineRunTrigger = Schema.Literal('scheduled', 'catch-up', 'manual')
export type RoutineRunTrigger = typeof RoutineRunTrigger.Type

export const RoutineRun = Schema.Struct({
  id: Schema.String,
  routineKey: Schema.String,
  trigger: RoutineRunTrigger,
  startedAt: Schema.Number,
  endedAt: Schema.NullOr(Schema.Number),
  state: RoutineRunState,
  headline: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  /** Why the run failed, when it did without a report of its own. */
  reason: Schema.NullOr(Schema.String),
  /** The hidden session the run was, and the provider's own conversation id
   *  (a Claude session id, a Codex thread), what a discussion resumes. */
  sessionId: Schema.NullOr(Schema.String),
  providerSessionId: Schema.NullOr(Schema.String),
  /** The session the discussion goes on in once the run ended, when one was opened. */
  discussionSessionId: Schema.NullOr(Schema.String),
  agent: RoutineAgent,
  form: RoutineForm,
  model: Schema.NullOr(Schema.String),
  account: Schema.NullOr(Schema.String),
  /** The run's deck, as a path under the viewer's root (`<routine>/<run>/index.html`), null until a valid report. */
  deck: Schema.NullOr(Schema.String),
  /** Whether the person dismissed the run's badge. */
  seen: Schema.Boolean
})
export type RoutineRun = typeof RoutineRun.Type

export const RoutineView = Schema.Struct({
  routine: RoutineDeclaration,
  /** The next occurrence on the clock, null for a routine that cannot run. */
  nextRunAt: Schema.NullOr(Schema.Number),
  /** The last 20 runs, newest first. */
  runs: Schema.Array(RoutineRun)
})
export type RoutineView = typeof RoutineView.Type

/** What a window reads: every routine of every workspace this server knows,
 *  and where the decks are served from (null when the viewer is not up, the
 *  note saying why). */
export const RoutinesListing = Schema.Struct({
  routines: Schema.Array(RoutineView),
  viewer: Schema.Struct({ url: Schema.NullOr(Schema.String), note: Schema.String })
})
export type RoutinesListing = typeof RoutinesListing.Type

// ---------------------------------------------------------------------------
// Failures.
// ---------------------------------------------------------------------------

/** The scheduler refused: the sentence to show. */
export class RoutineRefused extends Schema.TaggedError<RoutineRefused>()('RoutineRefused', {
  message: Schema.String
}) {}

/** A report the server would not take: not a run's session, a run already
 *  ended, or data the schema refuses, the errors listed for the agent. */
export class RoutineReportRefused extends Schema.TaggedError<RoutineReportRefused>()(
  'RoutineReportRefused',
  { message: Schema.String, errors: Schema.Array(Schema.String) }
) {}

// ---------------------------------------------------------------------------
// Commands and queries.
// ---------------------------------------------------------------------------

export const ListRoutines = Query.define('ListRoutines', {
  payload: Schema.Struct({}),
  success: RoutinesListing
})

/** A run outside the schedule, the person's own ask; refused while one is in flight. */
export const RunRoutineNow = Command.define('RunRoutineNow', {
  payload: Schema.Struct({ key: Schema.String }),
  success: RoutineRun,
  failure: RoutineRefused
})

/** The badge of a run put away. */
export const DismissRoutineRun = Command.define('DismissRoutineRun', {
  payload: Schema.Struct({ runId: Schema.String }),
  success: Schema.Void,
  failure: RoutineRefused
})

/** The agent's report, through the MCP tool: the session the tool was
 *  called from names the run. The data is validated against the routine's
 *  schema; a refusal lists the errors so the agent can correct and call again. */
export const ReportRoutineRun = Command.define('ReportRoutineRun', {
  payload: Schema.Struct({
    sessionId: Schema.String,
    status: RoutineStatus,
    headline: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
    summary: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4000)),
    data: Schema.Unknown
  }),
  success: Schema.Struct({ runId: Schema.String, deck: Schema.String }),
  failure: RoutineReportRefused
})

/** The run's conversation continued: in the panel (`panel`, the run's own
 *  hidden session re-homed to the asking window, or a hidden session resumed
 *  on the provider's conversation when the run ended), or as an ordinary tab
 *  (`tab`, a new session the window places). */
export const OpenRoutineDiscussion = Command.define('OpenRoutineDiscussion', {
  payload: Schema.Struct({
    runId: Schema.String,
    windowKey: Schema.String,
    mode: Schema.Literal('panel', 'tab')
  }),
  success: Schema.Struct({ sessionId: Schema.String }),
  failure: RoutineRefused
})

// ---------------------------------------------------------------------------
// Events: members of the server's one event union (`./events.ts`).
// ---------------------------------------------------------------------------

/** The routines, their next occurrence or their runs changed; a client re-lists. */
export const RoutinesChanged = Schema.TaggedStruct('routines.changed', {})
export type RoutinesEvent = typeof RoutinesChanged.Type

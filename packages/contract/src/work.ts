/**
 * Which work a session does, on the wire (PRDCT-4123): the Effect Schema
 * mirror of the plain types in `work-rules.ts`. The rules live there (what a
 * record's assignment keeps, how a change applies to the records, how the
 * sidebar reads them), in plain TypeScript the renderer imports; this file
 * is only what crosses the wire: a record's `work`, the change a
 * `ChangeSessionWork` carries, the records it rewrote, and its refusal.
 * `work.test.ts` holds the two copies together, as `records-contract.test.ts`
 * does for the session record.
 *
 * An assignment a record carries is checked here to the lengths the rules
 * keep; what an assigner sends (`WorkAssignInput`) is not, since the rule
 * checks it and refuses in words an agent can act on, where a schema would
 * answer with a parse error.
 */
import { Schema } from 'effect'
import { WORK_KINDS, WORK_LIMITS, WORK_ROLES, WORK_STANDINGS } from './work-rules'

export const WorkKind = Schema.Literal(...WORK_KINDS)
export const WorkRole = Schema.Literal(...WORK_ROLES)
export const WorkStanding = Schema.Literal(...WORK_STANDINGS)

/** A unit's or a wave's key. */
const Key = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(WORK_LIMITS.unit))
/** A unit's or a wave's label, as its sidebar entry shows it. */
const Label = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(WORK_LIMITS.label))

/** A session's assignment, as its record keeps it. */
export const WorkAssignment = Schema.Struct({
  unit: Key,
  kind: WorkKind,
  label: Label,
  wave: Schema.optional(Key),
  waveLabel: Schema.optional(Label),
  role: WorkRole,
  task: Schema.optional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(WORK_LIMITS.task))
  ),
  standing: WorkStanding,
  joinedAt: Schema.Number,
  since: Schema.Number,
  from: Schema.optional(Schema.String)
})

/** What an assigner says about a session's work. */
export const WorkAssignInput = Schema.Struct({
  unit: Schema.String,
  kind: Schema.optional(WorkKind),
  label: Schema.optional(Schema.String),
  wave: Schema.optional(Schema.String),
  waveLabel: Schema.optional(Schema.String),
  role: WorkRole,
  task: Schema.optional(Schema.String)
})

/** One change to one session's assignment; `applyWorkChange` says what each does. */
export const WorkChange = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('assign'),
    work: WorkAssignInput,
    replace: Schema.optional(Schema.Boolean)
  }),
  Schema.Struct({ type: Schema.Literal('complete') }),
  Schema.Struct({ type: Schema.Literal('leave') }),
  Schema.Struct({ type: Schema.Literal('offer'), to: Schema.String }),
  Schema.Struct({ type: Schema.Literal('cancel') }),
  Schema.Struct({ type: Schema.Literal('accept'), replace: Schema.optional(Schema.Boolean) })
)

/** One record rewritten: its new assignment, or null for none. */
export const WorkUpdate = Schema.Struct({
  id: Schema.String,
  work: Schema.NullOr(WorkAssignment)
})

/** The records refused the change: the rule's own words. */
export class WorkChangeRefused extends Schema.TaggedError<WorkChangeRefused>()(
  'WorkChangeRefused',
  { id: Schema.String, message: Schema.String }
) {}

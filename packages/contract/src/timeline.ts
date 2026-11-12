import { Schema } from 'effect'
import { Query } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from './errors'
import { SessionEvent, SessionNotFound } from './sessions'
import { SessionPosition, SessionSequence } from './session-position'

export { SessionPosition, SessionSequence } from './session-position'

export const TimelineItem = Schema.Struct({
  event: SessionEvent,
  at: Schema.optional(Schema.Number),
  position: SessionPosition
})
export type TimelineItem = typeof TimelineItem.Type
export const TimelinePage = Schema.Struct({
  items: Schema.Array(TimelineItem),
  /** Exclusive sequence boundary for the older page, in cursor.generation. */
  before: Schema.NullOr(SessionSequence),
  /** Highest position captured, including events outside this older page. */
  cursor: SessionPosition,
  /** Retention dropped events. This is not evidence of a complete transcript. */
  truncated: Schema.Boolean
})
export type TimelinePage = typeof TimelinePage.Type

export class TimelineReadFailed extends Schema.TaggedError<TimelineReadFailed>()(
  'TimelineReadFailed',
  { id: Schema.String, message: Schema.String }
) {}

/** Subscribe and buffer first, then replace from this snapshot and apply
 * buffered positions above cursor in the same generation. A new generation
 * requires a new snapshot. No identity survives a provider/server restart. */
export const GetSessionTimeline = Query.define('GetSessionTimeline', {
  payload: Schema.Struct({
    id: Schema.String,
    before: Schema.optional(
      Schema.NumberFromString.pipe(Schema.int(), Schema.between(0, Number.MAX_SAFE_INTEGER))
    ),
    limit: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 2000)))
  }),
  success: TimelinePage,
  failure: Schema.Union(SessionNotFound, CapabilityUnavailable, TimelineReadFailed)
})

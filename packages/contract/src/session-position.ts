import { Schema } from 'effect'

/** Process-local, per-adoption ordering. Compare sequences only within the
 * same generation. A provider reattach or server restart starts a new one. */
export const SessionSequence = Schema.Number.pipe(
  Schema.int(),
  Schema.between(0, Number.MAX_SAFE_INTEGER)
)
export const SessionPosition = Schema.Struct({
  generation: Schema.NonEmptyString,
  sequence: SessionSequence
})
export type SessionPosition = typeof SessionPosition.Type

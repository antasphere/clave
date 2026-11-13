import { describe, expect, it } from 'vitest'
import { Either, Schema } from 'effect'
import { WorkAssignment, WorkAssignInput, WorkChange, WorkUpdate } from './work'
import {
  sanitizeWork,
  type WorkAssignInput as PlainAssignInput,
  type WorkAssignment as PlainAssignment,
  type WorkChange as PlainChange,
  type WorkUpdate as PlainUpdate
} from './work-rules'

/**
 * The wire's copy of a session's work (`work.ts`) and the rules' plain types
 * (`work-rules.ts`) are one shape written twice (PRDCT-4123). A Struct drops
 * a field it does not name on decode, so a field the wire forgets is lost
 * crossing the server, and the record listing is refused whole for one
 * assignment the schema does not take. This holds the two together.
 */
const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown): Either.Either<A, string> =>
  Either.mapLeft(Schema.decodeUnknownEither(schema)(input), (e) => e.message)

const full: PlainAssignment = {
  unit: 'stable-wave/lane-a',
  kind: 'lane',
  label: 'Stable wave lanes',
  wave: 'stable-wave',
  waveLabel: 'Stable waves',
  role: 'lead',
  task: 'the plumbing',
  standing: 'current',
  joinedAt: 1_700_000_000_000,
  since: 1_700_000_100_000,
  from: '6f1c2c8e-1b9a-4d6e-9b1a-2f3c4d5e6f70'
}

describe('an assignment on the wire', () => {
  it('decodes with every field intact, and the rules keep it whole too', () => {
    const decoded = Schema.decodeUnknownSync(WorkAssignment)(full) as Record<string, unknown>
    for (const key of Object.keys(full)) {
      expect(decoded, `the wire schema dropped "${key}"`).toHaveProperty(key)
    }
    expect(decoded).toEqual(full)
    expect(sanitizeWork(full)).toEqual(full)
  })

  it('keeps the plain types and the wire types assignable both ways', () => {
    // Compile-time proof: a field added to one copy and not the other, or a
    // literal one side does not know, is a type error here.
    const plain: PlainAssignment = full
    const onWire: typeof WorkAssignment.Type = plain
    const back: PlainAssignment = onWire
    expect(back).toBe(full)

    const input: PlainAssignInput = { unit: 'u', role: 'worker' }
    const inputOnWire: typeof WorkAssignInput.Type = input
    const inputBack: PlainAssignInput = inputOnWire
    const change: PlainChange = { type: 'assign', work: inputBack, replace: true }
    const changeOnWire: typeof WorkChange.Type = change
    const changeBack: PlainChange = changeOnWire
    const update: PlainUpdate = { id: 's1', work: null }
    const updateOnWire: typeof WorkUpdate.Type = update
    const updateBack: PlainUpdate = updateOnWire
    expect([changeBack, updateBack]).toEqual([change, update])
  })

  it('refuses a standing it does not know, an empty unit and a label over 80 characters', () => {
    // `unresolved` is what the sidebar says of records that disagree, never
    // something a record stores.
    expect(Either.isLeft(decode(WorkAssignment, { ...full, standing: 'unresolved' }))).toBe(true)
    expect(Either.isLeft(decode(WorkAssignment, { ...full, unit: '' }))).toBe(true)
    expect(Either.isLeft(decode(WorkAssignment, { ...full, label: 'x'.repeat(81) }))).toBe(true)
    expect(Either.isRight(decode(WorkAssignment, { ...full, label: 'x'.repeat(80) }))).toBe(true)
  })
})

describe('a change on the wire', () => {
  const changes: PlainChange[] = [
    {
      type: 'assign',
      work: {
        unit: 'stable-wave/lane-a',
        kind: 'lane',
        label: 'Stable wave lanes',
        wave: 'stable-wave',
        waveLabel: 'Stable waves',
        role: 'lead',
        task: 'the plumbing'
      },
      replace: true
    },
    { type: 'assign', work: { unit: 'stable-wave/lane-a', role: 'verifier' } },
    { type: 'complete' },
    { type: 'leave' },
    { type: 'offer', to: '6f1c2c8e-1b9a-4d6e-9b1a-2f3c4d5e6f70' },
    { type: 'cancel' },
    { type: 'accept' },
    { type: 'accept', replace: true }
  ]

  it.each(changes.map((change) => [JSON.stringify(change), change]))('decodes %s', (_, change) => {
    expect(decode(WorkChange, change)).toEqual(Either.right(change))
  })

  it('refuses a change it does not know, and an assign with no role', () => {
    expect(Either.isLeft(decode(WorkChange, { type: 'promote' }))).toBe(true)
    expect(Either.isLeft(decode(WorkChange, { type: 'assign', work: { unit: 'u' } }))).toBe(true)
  })
})

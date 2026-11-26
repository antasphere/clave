import { describe, expect, it } from 'vitest'
import { Either, Schema } from 'effect'
import { ProjectPick, TabProjects } from './tab-projects'
import {
  PROJECT_LIMITS,
  sanitizeTabProjects,
  type ProjectPick as PlainPick,
  type TabProjects as PlainTabProjects
} from './tab-projects-rules'

/**
 * The wire's copy of a tab's reading (`tab-projects.ts`) and the rules'
 * plain types (`tab-projects-rules.ts`) are one shape written twice
 * (PRDCT-5179), the rule `work.test.ts` keeps for `work`. A Struct drops a
 * field it does not name on decode, so a field the wire forgets is lost
 * crossing the server. This holds the two together.
 */
const decode = (input: unknown): Either.Either<PlainTabProjects, string> =>
  Either.mapLeft(Schema.decodeUnknownEither(TabProjects)(input), (e) => e.message)

const full: PlainTabProjects = {
  status: 'decided',
  picks: [
    { file: '/w/quill/.clave/workspaces/default.clave', name: 'Quill', p: 0.66 },
    { file: '/w/atlas/.clave/workspaces/default.clave', name: 'Atlas', p: 0.33 }
  ],
  fits: 0.94,
  readAt: 1_700_000_000_000,
  model: 'jev-1.14.0',
  basis: 'sha256-0123456789abcdef'
}

describe('a tab reading on the wire', () => {
  it('decodes with every field intact, and the rules keep it whole too', () => {
    const decoded = Schema.decodeUnknownSync(TabProjects)(full) as Record<string, unknown>
    for (const key of Object.keys(full))
      expect(decoded, `the wire schema dropped "${key}"`).toHaveProperty(key)
    expect(decoded).toEqual(full)
    expect(Schema.decodeUnknownSync(ProjectPick)(full.picks[0])).toEqual(full.picks[0])
    expect(sanitizeTabProjects(full)).toEqual(full)
    const none: PlainTabProjects = { ...full, status: 'none', picks: [], fits: 0.2 }
    expect(decode(none)).toEqual(Either.right(none))
    expect(sanitizeTabProjects(none)).toEqual(none)
  })

  it('keeps the plain types and the wire types assignable both ways', () => {
    // Compile-time proof: a field added to one copy and not the other, or a
    // status one side does not know, is a type error here.
    const plain: PlainTabProjects = full
    const onWire: typeof TabProjects.Type = plain
    const back: PlainTabProjects = onWire
    const pick: PlainPick = full.picks[0]
    const pickOnWire: typeof ProjectPick.Type = pick
    const pickBack: PlainPick = pickOnWire
    expect([back, pickBack]).toEqual([full, pick])
  })

  it('refuses what the rules refuse: a status, a share, a length or a count out of bounds', () => {
    const refused: unknown[] = [
      { ...full, status: 'maybe' },
      { ...full, fits: 1.5 },
      { ...full, fits: -0.1 },
      { ...full, readAt: -1 },
      { ...full, model: '' },
      { ...full, model: 'm'.repeat(PROJECT_LIMITS.model + 1) },
      { ...full, basis: 'b'.repeat(PROJECT_LIMITS.basis + 1) },
      { ...full, picks: [{ ...full.picks[0], p: 2 }] },
      { ...full, picks: [{ ...full.picks[0], name: '' }] },
      { ...full, picks: [{ ...full.picks[0], file: 'f'.repeat(PROJECT_LIMITS.file + 1) }] },
      { ...full, picks: Array.from({ length: PROJECT_LIMITS.picks + 1 }, () => full.picks[0]) }
    ]
    for (const input of refused) {
      expect(Either.isLeft(decode(input)), JSON.stringify(input).slice(0, 80)).toBe(true)
      expect(sanitizeTabProjects(input)).toBeUndefined()
    }
    // At the limits, both keep it.
    const edge = {
      ...full,
      model: 'm'.repeat(PROJECT_LIMITS.model),
      basis: 'b'.repeat(PROJECT_LIMITS.basis)
    }
    expect(Either.isRight(decode(edge))).toBe(true)
    expect(sanitizeTabProjects(edge)).toEqual(edge)
  })
})

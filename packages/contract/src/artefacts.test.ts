import { describe, expect, it } from 'vitest'
import { Either, Schema } from 'effect'
import type { SlidelessState as SharedSlidelessState } from '../../../src/shared/slideless'
import {
  Artefact,
  ArtefactPreview,
  ArtefactRefused,
  ArtefactVersion,
  HoldArtefactPreview,
  OpenArtefact,
  SlidelessState
} from './artefacts'
import { ServerEvent } from './events'

/** The artefacts contract (PRDCT-4472): what the service answers decodes and
 *  encodes unchanged; the events are server events. */
describe('the artefacts contract', () => {
  const artefact = {
    sessionId: 's1',
    target: '/work/deck',
    page: '/work/deck/index.html',
    title: 'deck',
    openedAt: '2026-11-12T10:00:00.000Z'
  }

  it('decodes and encodes an artefact, a preview and a version as the service answers them', () => {
    for (const [schema, value] of [
      [Artefact, artefact],
      [
        ArtefactPreview,
        {
          holdId: 'h1',
          lease: '0123456789abcdef0123456789abcdef',
          url: 'http://127.0.0.1:4100/',
          ttlMs: 90_000
        }
      ],
      [ArtefactVersion, { version: 3, created: false }]
    ] as const) {
      const decoded = Schema.decodeUnknownSync(schema as Schema.Schema<unknown, unknown>)(value)
      expect(decoded).toEqual(value)
      expect(Schema.encodeSync(schema as Schema.Schema<unknown, unknown>)(decoded)).toEqual(value)
    }
  })

  it('refuses a preview whose lease is not a forward lease', () => {
    const bad = Schema.decodeUnknownEither(ArtefactPreview)({
      holdId: 'h1',
      lease: 'not-a-lease',
      url: 'http://127.0.0.1:4100/',
      ttlMs: 1
    })
    expect(Either.isLeft(bad)).toBe(true)
  })

  it('takes a session and a path to open, a hold with or without its id', () => {
    const open = Schema.decodeUnknownEither(OpenArtefact.payload)
    expect(open({ sessionId: 's1', path: '/work/deck' })._tag).toBe('Right')
    expect(open({ sessionId: '', path: '/work/deck' })._tag).toBe('Left')
    expect(open({ sessionId: 's1', path: '' })._tag).toBe('Left')
    const hold = Schema.decodeUnknownEither(HoldArtefactPreview.payload)
    expect(hold({ sessionId: 's1' })._tag).toBe('Right')
    expect(hold({ sessionId: 's1', holdId: 'h1' })._tag).toBe('Right')
  })

  it('keeps the refusal its sentence', () => {
    const refused = new ArtefactRefused({ message: 'This session has no artefact open.' })
    expect(refused._tag).toBe('ArtefactRefused')
    expect(refused.message).toBe('This session has no artefact open.')
  })

  it('holds the Slideless state field for field with the shared one', () => {
    // Both directions, at the type level: a drift in either copy fails the typecheck.
    const fromShared = (state: SharedSlidelessState): SlidelessState => state
    const toShared = (state: SlidelessState): SharedSlidelessState => state
    const keys = <T extends object>(value: T): string[] => Object.keys(value).sort()
    const samples: SharedSlidelessState[] = [
      { phase: 'missing', version: null, error: 'Slideless is not installed yet' },
      { phase: 'installing', version: null, error: null },
      { phase: 'ready', version: '0.14.1', error: null, override: false },
      { phase: 'error', version: null, error: 'The registry did not answer in time' }
    ]
    for (const sample of samples) {
      const decoded = Schema.decodeUnknownSync(SlidelessState)(fromShared(sample))
      expect(toShared(decoded)).toEqual(sample)
      expect(keys(decoded)).toEqual(keys(sample))
    }
    // The phases are the same list on both sides.
    const phases: ReadonlyArray<SharedSlidelessState['phase']> =
      SlidelessState.fields.phase.literals
    expect([...phases].sort()).toEqual(['error', 'installing', 'missing', 'ready'])
    expect(Object.keys(SlidelessState.fields).sort()).toEqual([
      'error',
      'override',
      'phase',
      'version'
    ])
  })

  it('carries its three events as server events', () => {
    const decode = Schema.decodeUnknownSync(ServerEvent)
    for (const event of [
      { _tag: 'artefact.changed', sessionId: 's1', artefact },
      { _tag: 'artefact.changed', sessionId: 's1', artefact: null },
      { _tag: 'artefact.preview_exited', sessionId: 's1' },
      {
        _tag: 'slideless.state_changed',
        state: { phase: 'ready', version: '0.14.1', error: null, override: false }
      }
    ])
      expect(decode(event)).toEqual(event)
  })
})

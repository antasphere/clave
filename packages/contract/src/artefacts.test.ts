import { describe, expect, it } from 'vitest'
import { Either, Schema } from 'effect'
import {
  Artefact,
  ArtefactPreview,
  ArtefactRefused,
  ArtefactVersion,
  HoldArtefactPreview,
  OpenArtefact
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

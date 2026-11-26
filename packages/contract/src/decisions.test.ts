import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import { READ_TAB_PROJECTS_MAX, ReadTabProjects } from './decisions'

/** The decisions contract (PRDCT-5179): what a client may send, what it gets. */
describe('the decisions contract', () => {
  const payload = Schema.decodeUnknownEither(ReadTabProjects.payload)
  const result = Schema.decodeUnknownEither(ReadTabProjects.success)
  const reading = {
    status: 'decided',
    picks: [{ file: '/w/quill/.clave/workspaces/default.clave', name: 'Quill', p: 0.95 }],
    fits: 0.9,
    readAt: 1,
    model: 'jev-1.14.0',
    basis: 'b'
  }

  it('takes one to fifty tab ids, never an empty one', () => {
    expect(payload({ sessionIds: ['s1'] })._tag).toBe('Right')
    const most = Array.from({ length: READ_TAB_PROJECTS_MAX }, (_, i) => `s${i}`)
    expect(payload({ sessionIds: most })._tag).toBe('Right')
    expect(payload({ sessionIds: [...most, 'one-more'] })._tag).toBe('Left')
    expect(payload({ sessionIds: [] })._tag).toBe('Left')
    expect(payload({ sessionIds: [''] })._tag).toBe('Left')
  })

  it('answers each tab with its reading or null, and a reason it knows', () => {
    const tabs = [
      { sessionId: 'a', projects: reading },
      { sessionId: 'b', projects: null, reason: 'nothing' },
      { sessionId: 'c', projects: reading, reason: 'unreachable' }
    ]
    expect(Schema.decodeUnknownSync(ReadTabProjects.success)({ tabs })).toEqual({ tabs })
    // A reason this Mac does not know (a newer server's) reads as absent;
    // the rest of the answer, the reading included, is kept.
    expect(
      Schema.decodeUnknownSync(ReadTabProjects.success)({
        tabs: [{ sessionId: 'd', projects: reading, reason: 'a-newer-reason' }]
      })
    ).toEqual({ tabs: [{ sessionId: 'd', projects: reading }] })
    expect(
      result({ tabs: [{ sessionId: 'e', projects: { ...reading, status: 'maybe' } }] })._tag
    ).toBe('Left')
  })
})

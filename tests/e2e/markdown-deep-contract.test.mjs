import { describe, expect, it } from 'vitest'
import {
  DEPTHS,
  STAGES,
  ROLES,
  literal,
  checkClientRows,
  checkNativeRows
} from './markdown-deep-contract.mjs'

const row = (depth, stage) => ({
  depth,
  stage,
  ...literal(depth, stage),
  em: depth,
  strong: depth,
  paragraphsCount: 2,
  middleOccurrences: 1,
  connected: true,
  errors: []
})
const client = () =>
  DEPTHS.flatMap((d) => STAGES.flatMap((s) => ROLES.map((role) => ({ ...row(d, s), role }))))
const cleanup = { unmountedRoots: 12, rootsUnmounted: true, containersEmpty: true, errors: [] }
const native = () =>
  ['chat', 'terminal'].flatMap((view) =>
    DEPTHS.flatMap((depth) =>
      STAGES.map((stage) => ({
        ...row(depth, stage),
        view,
        runId: 'run',
        sessionId: view + depth,
        articleCount: 1,
        sameArticle: true,
        receipt: {
          kind: 'event',
          event: {
            type: 'assistant_text',
            delta: stage === 'initial' ? literal(depth, stage).input : ' grows',
            final: false
          }
        },
        receivedAt: 100,
        sampledAt: 310,
        animationFrames: 2,
        sampleCount: 1
      }))
    )
  )

describe('literal deep client contract checker negatives', () => {
  it('accepts only the complete declared matrices', () => {
    checkClientRows(client(), cleanup)
    checkNativeRows(native())
  })
  it.each([
    'html',
    'text',
    'input',
    'paragraphs',
    'em',
    'strong',
    'middleOccurrences',
    'connected',
    'errors'
  ])('rejects shared wrong %s before parity', (field) => {
    const rows = client()
    for (const r of rows)
      r[field] = {
        html: '<p>truncated</p>',
        text: 'truncated',
        input: '',
        paragraphs: [],
        em: 0,
        strong: 0,
        middleOccurrences: 0,
        connected: false,
        errors: ['error']
      }[field]
    expect(() => checkClientRows(rows, cleanup)).toThrow()
  })
  it('rejects missing/duplicate/reordered client rows and incomplete cleanup', () => {
    const missing = client()
    missing.pop()
    expect(() => checkClientRows(missing, cleanup)).toThrow()
    const duplicate = client()
    duplicate[1] = duplicate[0]
    expect(() => checkClientRows(duplicate, cleanup)).toThrow()
    expect(() => checkClientRows(client().reverse(), cleanup)).toThrow()
    expect(() => checkClientRows(client(), { ...cleanup, unmountedRoots: 11 })).toThrow()
  })
  it.each(['session', 'identity', 'receipt', 'first-sample', 'frame', 'count', 'error'])(
    'rejects native %s violations',
    (kind) => {
      const rows = native(),
        r = rows[1]
      if (kind === 'session') r.sessionId = 'different'
      if (kind === 'identity') r.sameArticle = false
      if (kind === 'receipt') r.receipt.event.delta = 'different'
      if (kind === 'first-sample') r.sampledAt = 299
      if (kind === 'frame') r.animationFrames = 3
      if (kind === 'count') r.sampleCount = 2
      if (kind === 'error') r.errors.push('callback error')
      expect(() => checkNativeRows(rows)).toThrow()
    }
  )
})

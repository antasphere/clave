/**
 * The provenance contract's one dangerous edge: the checkpoint header (a
 * self-addressed send, logged, never delivered) must NEVER be matched by
 * `hasProvenanceHeader`, whose semantics are "this text was DELIVERED into a
 * transcript by a sibling". A checkpoint matching it would let a pasted
 * checkpoint body relabel human text as a sibling's message.
 */
import { describe, expect, it } from 'vitest'
import {
  ANONYMOUS_CHECKPOINT_HEADER,
  buildCheckpointProvenance,
  buildProvenanceHeader,
  hasProvenanceHeader,
  parseDelivery
} from './exchange-provenance'

describe('buildCheckpointProvenance', () => {
  it('names the tab and says logged, not delivered', () => {
    expect(buildCheckpointProvenance({ id: 'abc', name: 'Exos' })).toBe(
      '[Checkpoint by Clave tab "Exos" — logged, not delivered]'
    )
    expect(buildCheckpointProvenance(undefined)).toBe(ANONYMOUS_CHECKPOINT_HEADER)
  })

  it('is never matched by hasProvenanceHeader, while delivery headers still are', () => {
    expect(hasProvenanceHeader(buildCheckpointProvenance({ id: 'abc', name: 'Exos' }))).toBe(false)
    expect(hasProvenanceHeader(buildCheckpointProvenance(undefined))).toBe(false)
    expect(hasProvenanceHeader(buildProvenanceHeader({ id: 'abc', name: 'Exos' }))).toBe(true)
    expect(hasProvenanceHeader(buildProvenanceHeader(undefined))).toBe(true)
  })
})

describe('parseDelivery', () => {
  it('reads back the sender and the body of what a delivery writes', () => {
    const sender = { id: '3f1c-9a', name: 'Lane A · "keypad" · Opus' }
    const text = `${buildProvenanceHeader(sender)}\nMERGED · PR 12\n\nsecond line`
    expect(parseDelivery(text)).toEqual({ sender, body: 'MERGED · PR 12\n\nsecond line' })
  })
  it('reads the anonymous header as a delivery with no sender', () => {
    expect(parseDelivery(`${buildProvenanceHeader(undefined)}\nhello`)).toEqual({
      sender: null,
      body: 'hello'
    })
  })
  it('leaves what the human typed alone, a quoted header and a checkpoint included', () => {
    expect(parseDelivery('look at this')).toBeNull()
    expect(
      parseDelivery(`quoting:\n${buildProvenanceHeader({ id: 'x', name: 'Y' })}\nhi`)
    ).toBeNull()
    expect(parseDelivery(`${buildCheckpointProvenance({ id: 'x', name: 'Y' })}\nnote`)).toBeNull()
  })
})

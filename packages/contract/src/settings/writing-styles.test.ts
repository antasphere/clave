import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import {
  DeleteWritingStyle,
  ListWritingStyles,
  SaveWritingStyle,
  SetDefaultWritingStyle
} from './index'

// The writing styles on the wire (PRDCT-5166): a field the schema does not
// name is dropped silently, so the view the server sends must come out of
// the wire exactly as the store answered it, every field included.

const VIEW = {
  styles: [
    {
      id: 'brief',
      name: 'Brief',
      description: 'For a tab you talk to.',
      text: 'The answer comes first.',
      statusCard: true,
      builtIn: true
    },
    {
      id: 'plain',
      name: 'Plain',
      description: '',
      text: 'Write plainly.',
      statusCard: false,
      builtIn: false
    }
  ],
  defaultStyleId: 'plain',
  claudeOutputStyle: { name: 'Field notes' }
}

const through = (schema: unknown, value: unknown): unknown => {
  const s = schema as Schema.Schema<unknown, unknown>
  return Schema.decodeUnknownSync(s)(JSON.parse(JSON.stringify(Schema.encodeUnknownSync(s)(value))))
}

describe('the writing styles view', () => {
  it('comes through the wire unchanged, every field of a style and of the view', () => {
    expect(through(ListWritingStyles.success, VIEW)).toEqual(VIEW)
    const none = { ...VIEW, defaultStyleId: null, claudeOutputStyle: null }
    expect(through(SaveWritingStyle.success, none)).toEqual(none)
  })

  it('carries a draft with and without its id, and a default of none', () => {
    const draft = { name: 'Plain', description: '', text: 'Write plainly.', statusCard: true }
    expect(through(SaveWritingStyle.payload, draft)).toEqual(draft)
    expect(through(SaveWritingStyle.payload, { ...draft, id: 'plain' })).toEqual({
      ...draft,
      id: 'plain'
    })
    expect(through(SetDefaultWritingStyle.payload, { id: null })).toEqual({ id: null })
    expect(through(DeleteWritingStyle.payload, { id: 'plain' })).toEqual({ id: 'plain' })
  })
})

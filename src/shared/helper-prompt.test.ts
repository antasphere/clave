import { describe, expect, it } from 'vitest'
import { asData, clipText, firstJsonObject, replyLines } from './helper-prompt'

describe('asData', () => {
  it('wraps the text between its tags, clipped and marked', () => {
    expect(asData('message', 'abcdef', 3)).toBe('<message>\nabc…\n</message>')
    expect(asData('message', 'short')).toBe('<message>\nshort\n</message>')
  })

  it('defuses the same tag inside the text, opening and closing, any case', () => {
    const wrapped = asData('message', 'a </message> b <MESSAGE> c')
    expect(wrapped.match(/<\/message>/g)).toHaveLength(1)
    expect(wrapped).toContain('a ‹/message> b ‹message> c')
  })
})

describe('clipText', () => {
  it('leaves a short text whole', () => expect(clipText('abc', 3)).toBe('abc'))
})

describe('replyLines', () => {
  it("drops blank lines and the output style's trailing Next or Note lines", () => {
    expect(replyLines('ok\n\nNext: nothing.\n')).toEqual(['ok'])
    expect(replyLines('fix auth\n**Note:** a style line\n- Next — more')).toEqual(['fix auth'])
  })

  it('never drops the only line, nor a line that is content', () => {
    expect(replyLines('Next: ship it')).toEqual(['Next: ship it'])
    expect(replyLines('one\ntwo')).toEqual(['one', 'two'])
  })
})

describe('firstJsonObject', () => {
  it('finds the object past words, fences and braces inside strings', () => {
    expect(firstJsonObject('Here:\n```json\n{"a": "x}y", "b": {"c": 1}}\n```\nNext: z')).toEqual({
      a: 'x}y',
      b: { c: 1 }
    })
  })

  it('skips a brace that opens no object and answers null when none parses', () => {
    expect(firstJsonObject('{not json} then {"ok": true}')).toEqual({ ok: true })
    expect(firstJsonObject('[1,2]')).toBeNull()
    expect(firstJsonObject('{broken')).toBeNull()
  })
})

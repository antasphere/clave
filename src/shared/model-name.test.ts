import { describe, expect, it } from 'vitest'
import { isValidModelName } from './model-name'

describe('model references', () => {
  it.each([
    'fable',
    'opus',
    'claude-opus-5-5',
    'opus[1m]',
    'claude-opus-5-5[1m]',
    'sonnet[200k]',
    'us.anthropic.claude-opus-5-5-v1:0',
    'publishers/anthropic/models/claude-opus-5-5',
    'a',
    'a'.repeat(200)
  ])('accepts %s', (model) => expect(isValidModelName(model)).toBe(true))

  it.each([
    '',
    '-opus',
    '../opus',
    'opus/../fable',
    'opus;',
    'opus && echo unsafe',
    'opus$(echo unsafe)',
    'opus`echo unsafe`',
    "opus'",
    'opus"',
    'opus\n',
    'opus\u0000',
    ' opus',
    'opus ',
    '/opus',
    'opus/',
    'opus[]',
    'opus[1m',
    'opus1m]',
    '[1m]',
    'opus[1m]suffix',
    'opus[1m][1m]',
    'opus[0m]',
    'opus[*]',
    'opus[1m;echo]',
    'a'.repeat(201),
    `${'a'.repeat(200)}[1m]`
  ])('rejects malformed or unsafe reference %j', (model) =>
    expect(isValidModelName(model)).toBe(false)
  )
})

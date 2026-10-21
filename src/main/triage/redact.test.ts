import { describe, expect, it } from 'vitest'
import { REDACTED, createRedactor, errorText } from './redact'

const redact = createRedactor({ home: '/Users/tester', secrets: ['known-secret-value-123'] })

describe('createRedactor', () => {
  it.each([
    ['a known secret anywhere', 'url?t=known-secret-value-123&x', 'known-secret-value-123'],
    ['a bearer value', 'Authorization: Bearer abc.def-ghi', 'abc.def-ghi'],
    [
      'an environment assignment',
      'OPENAI_API_KEY=sk-proj-abcdefgh123 npm start',
      'sk-proj-abcdefgh123'
    ],
    ['a provider key', 'key sk-ant-api03-abcdefghijkl', 'sk-ant-api03-abcdefghijkl'],
    ['a GitHub token', 'ghp_abcdefghijklmnop1234', 'ghp_abcdefghijklmnop1234'],
    ['a JSON token field', '{"access_token": "zzzzzzzz"}', 'zzzzzzzz'],
    ['a query token', 'https://x/cb?token=qqqqqqqq&a=1', 'qqqqqqqq'],
    ['a password', 'password: hunter2hunter2', 'hunter2hunter2'],
    ['a token cut mid-quote', 'Unexpected token in "{"token":"abcdefghij1234', 'abcdefghij1234'],
    [
      'a JWT',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVl',
      'eyJzdWIiOiIxMjM0NSJ9'
    ]
  ])('scrubs %s', (_name, input, secret) => {
    const out = redact.text(input)
    expect(out).not.toContain(secret)
    expect(out).toContain(REDACTED)
  })

  it('writes the home directory as ~ and leaves other paths alone', () => {
    expect(redact.path('/Users/tester/Library/Logs')).toBe('~/Library/Logs')
    expect(redact.path('/Users/tester')).toBe('~')
    expect(redact.path('/Users/testerx/a')).toBe('/Users/testerx/a')
    expect(redact.text('/opt/homebrew/bin/tmux')).toBe('/opt/homebrew/bin/tmux')
  })

  it('cuts a long value and says so', () => {
    const out = redact.text('a'.repeat(50), 10)
    expect(out.startsWith('aaaaaaaaaa…')).toBe(true)
    expect(out).toContain('40 more characters cut')
  })

  it('scrubs a known secret whatever its case (a URL lowercases its host)', () => {
    const r = createRedactor({ home: '/h', secrets: ['MixedCaseToken42xyz'] })
    expect(r.text('http://mixedcasetoken42xyz.localhost:1')).toBe(`http://${REDACTED}.localhost:1`)
  })

  it('ignores secrets too short to be one', () => {
    const r = createRedactor({ home: '/h', secrets: ['ab', null, undefined] })
    expect(r.text('ab cd')).toBe('ab cd')
  })
})

describe('errorText', () => {
  it('keeps the first line, redacted', () => {
    const e = new TypeError('fetch failed for Bearer xyzxyzxyz\nstack line')
    expect(errorText(redact, e)).toBe(`TypeError: fetch failed for Bearer ${REDACTED}`)
  })
})

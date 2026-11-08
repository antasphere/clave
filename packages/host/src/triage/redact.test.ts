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

  it('scrubs a secret of any length without building an expression from it', () => {
    const huge = `tok${'Z9'.repeat(100_000)}`
    const r = createRedactor({ home: '/h', secrets: [huge, 'a(b)[c]*+?{d}|^$.x'] })
    expect(r.text(`x ${huge} y`, 500)).toBe(`x ${REDACTED} y`)
    expect(r.text(`x ${huge.toLowerCase()} y`, 500)).toBe(`x ${REDACTED} y`)
    expect(r.text('literal a(b)[c]*+?{d}|^$.x here')).toBe(`literal ${REDACTED} here`)
  })

  it('scrubs known secrets from paths and from every string of a value', () => {
    const r = createRedactor({ home: '/Users/t', secrets: ['window-secret-key'] })
    expect(r.path('/Users/t/window-secret-key/x')).toBe(`~/${REDACTED}/x`)
    expect(r.deep({ a: ['WINDOW-SECRET-KEY'], b: { c: 'ok' }, n: 3 })).toEqual({
      a: [REDACTED],
      b: { c: 'ok' },
      n: 3
    })
  })

  it('never renames a field, and keeps a fixed value only in the field the caller names', () => {
    const r = createRedactor({ home: '/h', secrets: ['terminalSessionIds', 'separate'] })
    const keepMode = (path: readonly (string | number)[]): boolean =>
      path.length === 1 && path[0] === 'mode'
    expect(
      r.deep(
        {
          terminalSessionIds: ['terminalSessionIds'],
          mode: 'separate',
          windowKey: 'separate',
          warning: 'the separate server'
        },
        keepMode
      )
    ).toEqual({
      terminalSessionIds: [REDACTED],
      mode: 'separate',
      windowKey: REDACTED,
      warning: `the ${REDACTED} server`
    })
  })

  it('has no value exemption of its own: a known token equal to a contract word is scrubbed', () => {
    // The coordinator's probe: createRedactor({secrets:['separate']}).text('separate').
    const r = createRedactor({ home: '/h', secrets: ['separate'] })
    expect(r.text('separate')).toBe(REDACTED)
    expect(r.path('separate')).toBe(REDACTED)
    expect(r.deep({ mode: 'separate' })).toEqual({ mode: REDACTED })
  })

  it('scrubs a known secret as short as six characters, as before', () => {
    const r = createRedactor({ home: '/h', secrets: ['secret1234', 'abc123', 'abc12'] })
    expect(r.text('key secret1234 in an error')).toBe(`key ${REDACTED} in an error`)
    expect(r.path('/data/SECRET1234/x')).toBe(`/data/${REDACTED}/x`)
    expect(r.deep({ k: 'window-abc123' })).toEqual({ k: `window-${REDACTED}` })
    // Five characters is below the known-secret floor (the patterns still apply).
    expect(r.text('abc12')).toBe('abc12')
  })

  it('folds case without changing length, whatever else the string holds', () => {
    const r = createRedactor({ home: '/h', secrets: ['MixedCaseToken42xyz'] })
    // U+0130 lowercases to two code units; it must not disable the case fold.
    expect(r.text('İstanbul http://mixedcasetoken42xyz.localhost')).toBe(
      `İstanbul http://${REDACTED}.localhost`
    )
    expect(r.deep('ß İ MIXEDCASETOKEN42XYZ')).toBe(`ß İ ${REDACTED}`)
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

import { describe, expect, it } from 'vitest'
import { lastWords, startRefusal } from './start-refusal'

/**
 * What a Pi or OpenCode chat says when its agent ends before it spoke
 * (PRDCT-4427): the agent's last words and its status, never a value of its
 * environment.
 */
describe('startRefusal', () => {
  it("says the agent's last line and its status", () => {
    expect(
      startRefusal(
        'Pi',
        1,
        'Error: --provider requires --model (for example: --provider kimi-coding --model <pattern>)\n'
      )
    ).toBe(
      'Pi could not start: Error: --provider requires --model (for example: --provider kimi-coding --model <pattern>) (exit status 1)'
    )
  })

  it('says the status alone when the agent said nothing', () => {
    expect(startRefusal('OpenCode', 3, '  \n')).toBe(
      'OpenCode could not start: it exited with status 3 and said nothing'
    )
    expect(startRefusal('OpenCode', 3, undefined)).toBe(
      'OpenCode could not start: it exited with status 3 and said nothing'
    )
  })
})

describe('lastWords', () => {
  it('keeps the last three non-empty lines, plain text', () => {
    expect(lastWords('one\n\ntwo\r\nthree\n\u001b[31mfour\u001b[0m\n')).toBe('two three four')
  })

  it('masks a credential of the environment wherever it shows', () => {
    const env = {
      KIMI_API_KEY: 'made-up-kimi-value',
      CLAVE_CONNECTION_API_KEY: 'made-up-clave-value',
      CLAUDE_CODE_OAUTH_TOKEN: 'made-up-token-value',
      PI_CODING_AGENT_DIR: '/made-up/dir'
    }
    const words = lastWords(
      'refused made-up-kimi-value and made-up-clave-value, made-up-token-value in /made-up/dir\n',
      env
    )
    expect(words).toBe('refused ‹hidden› and ‹hidden›, ‹hidden› in /made-up/dir')
  })

  it('cuts a long tail to its end', () => {
    const words = lastWords(`${'x'.repeat(2000)}\n`)
    expect(words.length).toBe(500)
    expect(words.startsWith('…')).toBe(true)
  })
})

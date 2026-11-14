import { describe, expect, it } from 'vitest'
import { STDERR_TAIL_BYTES, lastWords, startRefusal } from './start-refusal'

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

  // The verifier's F2: a value cut by the 4 KB tail's edge is no longer the
  // whole value the mask looks for. Made-up value only.
  it('drops the first, partial line of a tail cut at its start', () => {
    const key = 'madeup-kimi-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const full = `using key ${key}\n${'\u001b[0m'.repeat(1008)}fatal: provider refused\n`
    const tail = Buffer.from(full).subarray(-STDERR_TAIL_BYTES).toString('utf8')
    expect(tail.includes(key)).toBe(false)
    const notice = startRefusal('Pi', 1, tail, { KIMI_API_KEY: key })
    expect(notice).toBe('Pi could not start: fatal: provider refused (exit status 1)')
    expect(notice).not.toMatch(/[A-Z0-9]{10,}/)
    // A tail cut inside its only line keeps nothing of it.
    const one = Buffer.from(`${key}${'x'.repeat(5000)}`)
      .subarray(-STDERR_TAIL_BYTES)
      .toString()
    expect(startRefusal('Pi', 1, one, { KIMI_API_KEY: key })).toBe(
      'Pi could not start: it exited with status 1 and said nothing'
    )
    // A tail that was not cut keeps its first line.
    expect(lastWords(`using key ${key}\nfatal\n`, { KIMI_API_KEY: key })).toBe(
      'using key ‹hidden› fatal'
    )
  })

  it('cuts a long tail to its end', () => {
    const words = lastWords(`${'x'.repeat(2000)}\n`)
    expect(words.length).toBe(500)
    expect(words.startsWith('…')).toBe(true)
  })
})

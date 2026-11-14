import { describe, expect, it } from 'vitest'
import { OPENCODE_MADE_ID_RE, newOpencodeSessionId } from './opencode-session-id'

describe('an OpenCode session id Clave names (PRDCT-4551)', () => {
  it("is in OpenCode's own shape, its time part the one OpenCode 2.3.0 wrote for the same moment", () => {
    // `ses_e25814e9dffeR7V70TG8uC9soo` was made by the real program 97 ms
    // before its `time.created` (1794667098563), first of its millisecond:
    // the twelve hex digits are the same for the same moment.
    const id = newOpencodeSessionId(1794667098466)
    expect(id).toMatch(OPENCODE_MADE_ID_RE)
    expect(id.slice(0, 16)).toBe('ses_e25814e9dffe')
    expect('ses_e25814e9dffeR7V70TG8uC9soo').toMatch(OPENCODE_MADE_ID_RE)
  })

  it('sorts newer first, as OpenCode lists its sessions, and never repeats', () => {
    const a = newOpencodeSessionId(1000)
    const b = newOpencodeSessionId(1000)
    const c = newOpencodeSessionId(2000)
    expect(new Set([a, b, c]).size).toBe(3)
    expect([a, b, c].map((id) => id.slice(4, 16)).sort()).toEqual(
      [c, b, a].map((id) => id.slice(4, 16))
    )
  })
})

import { randomBytes } from 'crypto'

/**
 * A new OpenCode session id, in OpenCode's own shape (PRDCT-4551):
 * `ses_`, twelve hex digits of the time counted down (OpenCode lists its
 * newest sessions first by id), then fourteen base-62 characters, as
 * OpenCode 2.3.0 names the sessions it makes (`ses_e25814e9dffeR7V70TG8uC9soo`).
 * Clave names an OpenCode terminal's session itself at its start:
 * `opencode --session <id>` continues the session, "or creates it if it does
 * not exist" (`opencode --help`, 2.3.0; the real TUI and `opencode run` both
 * took an id Clave made, checked on 14 November 2026), so the tab's usage is
 * known to be the tab's from its first turn.
 */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
let lastTime = 0
let counter = 0

export function newOpencodeSessionId(now: number = Date.now()): string {
  if (now !== lastTime) {
    lastTime = now
    counter = 0
  }
  counter++
  // OpenCode's descending identifier: the time and a counter, bits inverted,
  // the low 48 bits as twelve hex digits.
  const value = ~(BigInt(now) * 0x1000n + BigInt(counter)) & 0xffffffffffffn
  const time = value.toString(16).padStart(12, '0')
  const bytes = randomBytes(14)
  let tail = ''
  for (const byte of bytes) tail += BASE62[byte % 62]
  return `ses_${time}${tail}`
}

/** An OpenCode session id as OpenCode 2.3.0 makes them. */
export const OPENCODE_MADE_ID_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

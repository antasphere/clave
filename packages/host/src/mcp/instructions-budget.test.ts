import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The host truncates MCP server instructions at ~2048 characters, silently:
 * no error, no marker in the app, just tools that agents never learn about.
 * Measured 2026-09-08 with a 4242-char block, cut mid-word at 2047 — half the
 * tools (clave_open_side_panel, clave_notify, clave_request_secret,
 * clave_offer_copy) were unreachable from the instructions for months.
 *
 * 2000 leaves headroom for a host that counts bytes rather than code points.
 */
const BUDGET = 2000

function instructions(): string {
  const src = readFileSync(join(__dirname, 'mcp-server.ts'), 'utf8')
  const match = src.match(/const INSTRUCTIONS = `([\s\S]*?)`\n/)
  if (!match) throw new Error('INSTRUCTIONS block not found in mcp-server.ts')
  return match[1]
}

describe('MCP server instructions', () => {
  it('fits inside the host truncation budget', () => {
    const text = instructions()
    expect(text.length).toBeLessThanOrEqual(BUDGET)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2048)
  })

  it('names the side panel early enough to survive any plausible cut', () => {
    // Whatever else gets trimmed, the tool users ask for by name ("open the
    // panel") must sit in the first quarter of the block.
    const at = instructions().indexOf('clave_open_side_panel')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(at).toBeLessThan(BUDGET / 2)
  })
})

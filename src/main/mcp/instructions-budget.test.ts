import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ROUTINE_TOOLS_INSTRUCTION } from './routine-tools'

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

  it("sends every question through the form, never the agent's own question tool (PRDCT-4322)", () => {
    const text = instructions()
    expect(text).toMatch(/any question or value -> clave_request_input/)
    expect(text).toMatch(/Never ask in prose or with your own question tool\./)
  })

  it("tells a server's agents the same: every question through the form (PRDCT-4322)", () => {
    const src = readFileSync(join(__dirname, 'standalone-mcp.ts'), 'utf8')
    const at = src.indexOf("'Your Clave tools run on this server")
    expect(at).toBeGreaterThanOrEqual(0)
    const head = src.slice(at, src.indexOf('\n', at))
    expect(head).toMatch(
      /every question, value, choice, file or link to open with clave_request_input/
    )
    expect(head).toMatch(/never with your own question tool/)
  })

  it('names the side panel early enough to survive any plausible cut', () => {
    // Whatever else gets trimmed, the tool users ask for by name ("open the
    // panel") must sit in the first quarter of the block.
    const at = instructions().indexOf('clave_open_side_panel')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(at).toBeLessThan(BUDGET / 2)
  })

  it('says how an HTML artefact is made and shown, beside the side panel (PRDCT-4263, PRDCT-4472)', () => {
    // Every session learns it here or nowhere: a folder with index.html,
    // opened once with clave_open_artefact, then edited; the page reloads
    // and keeps the versions. The side panel is Markdown and email only.
    const text = instructions()
    const panel = text.split('\n').find((l) => l.includes('clave_open_side_panel')) ?? ''
    expect(panel).not.toMatch(/HTML/)
    const line = text.split('\n').find((l) => l.includes('clave_open_artefact')) ?? ''
    expect(line).toContain('folder with index.html')
    expect(line).toContain('ONCE')
    expect(line).toMatch(/reloads itself/)
    expect(line).toMatch(/version per turn/)
  })

  it("holds a server's block under the budget, and names clave_open_artefact (PRDCT-4472)", () => {
    const src = readFileSync(join(__dirname, 'standalone-mcp.ts'), 'utf8')
    const at = src.indexOf("'Your Clave tools run on this server")
    const line = src.slice(at, src.indexOf('\n', at))
    const literal = line.match(/^'((?:[^'\\]|\\.)*)' \+$/)
    expect(literal).not.toBeNull()
    expect(src.slice(src.indexOf('\n', at) + 1)).toMatch(
      /^\s*ROUTINE_TOOLS_INSTRUCTION\.slice\(2\)\n/
    )
    const block = literal![1]!.replace(/\\(.)/g, '$1') + ROUTINE_TOOLS_INSTRUCTION.slice(2)
    expect(block.length).toBeLessThanOrEqual(BUDGET)
    expect(block).toMatch(
      /clave_open_artefact with its folder \(index\.html inside\): open it ONCE/
    )
  })

  it('registers clave_launch_options on the Mac, routed to the launchOptions command (PRDCT-4485)', () => {
    const src = readFileSync(join(__dirname, 'mcp-server.ts'), 'utf8')
    const at = src.indexOf("server.registerTool(\n    'clave_launch_options',")
    expect(at).toBeGreaterThanOrEqual(0)
    const block = src.slice(at, src.indexOf('\n  )\n', at))
    expect(block).toContain('description: LAUNCH_OPTIONS_DESCRIPTION')
    expect(block).toContain("run('launchOptions', { ...args, callerSessionId })")
    expect(src).toMatch(
      /const LAUNCH_OPTIONS_DESCRIPTION =\n {2}'Before opening a tab, or when asked which harness, model or connection has room: lists, for this machine \(or for a connected server with server\)/
    )
    expect(src).toMatch(
      /Pass what you read to clave_open_session as mode, model, account and profile\.'/
    )
  })
})

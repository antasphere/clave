import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentTokenStore } from './agent-tokens'

let dir: string
const windows = new Map<string, string | null>()
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-tokens-'))
  windows.clear()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const store = (): ReturnType<typeof createAgentTokenStore> =>
  createAgentTokenStore(dir, (id) => windows.get(id) ?? null)

describe('the standalone agent token store', () => {
  it('writes no config until the shell has announced its MCP address', () => {
    const s = store()
    expect(s.mcpConfig.write('s1')).toBeNull()
    s.announce('http://127.0.0.1:4711/mcp')
    const file = s.mcpConfig.write('s1')
    expect(file).not.toBeNull()
    const cfg = JSON.parse(readFileSync(file as string, 'utf-8'))
    expect(cfg.mcpServers.clave.url).toBe('http://127.0.0.1:4711/mcp')
    expect(cfg.mcpServers.clave.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/)
  })
  it('resolves the token it minted to the session and its window', () => {
    const s = store()
    s.announce('http://127.0.0.1:4711/mcp')
    windows.set('s1', 'w1')
    const file = s.mcpConfig.write('s1') as string
    const token = JSON.parse(
      readFileSync(file, 'utf-8')
    ).mcpServers.clave.headers.Authorization.slice(7)
    expect(s.resolve(token)).toEqual({ sessionId: 's1', windowKey: 'w1' })
    expect(s.resolve('nope')).toBeUndefined()
  })
  it('reuses a session’s token across a rewrite, and forgets it on remove', () => {
    const s = store()
    s.announce('http://127.0.0.1:4711/mcp')
    const first = JSON.parse(
      readFileSync(s.mcpConfig.write('s1') as string, 'utf-8')
    ).mcpServers.clave.headers.Authorization.slice(7)
    const second = JSON.parse(
      readFileSync(s.mcpConfig.write('s1') as string, 'utf-8')
    ).mcpServers.clave.headers.Authorization.slice(7)
    expect(second).toBe(first)
    s.mcpConfig.remove('s1')
    expect(s.resolve(first)).toBeUndefined()
  })
  it('rebuilds the token map from the configs on disk at construction', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 's9.json'),
      JSON.stringify({ mcpServers: { clave: { headers: { Authorization: 'Bearer survivor' } } } })
    )
    windows.set('s9', 'w9')
    expect(store().resolve('survivor')).toEqual({ sessionId: 's9', windowKey: 'w9' })
  })
  it('answers a null window for a session the port does not place', () => {
    const s = store()
    s.announce('http://127.0.0.1:4711/mcp')
    const token = JSON.parse(
      readFileSync(s.mcpConfig.write('loose') as string, 'utf-8')
    ).mcpServers.clave.headers.Authorization.slice(7)
    expect(s.resolve(token)).toEqual({ sessionId: 'loose', windowKey: null })
  })
})

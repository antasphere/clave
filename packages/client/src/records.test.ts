import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startEmbedded, type EmbeddedServer } from '@clave/server'
import { FakeSource, aRecord, aSession } from '@clave/server/test-support'
import { AgentTokenUnknown } from '@clave/contract/agent-tools'
import { CapabilityUnavailable } from '@clave/contract/errors'
import { type ClaveApiClient, createApiClient } from './api'

/** The typed client's records and agent-tools calls (wave 4, lane C). */
let server: EmbeddedServer
let source: FakeSource
let api: ClaveApiClient
const announced: string[] = []

beforeEach(async () => {
  source = new FakeSource(aSession('s1'), aSession('s2', 'w2'))
  source.tmuxBacked.add('s1')
  source.records.push({ ...aRecord('r1', 'w1'), tmuxName: 'clave-r1', live: true })
  server = await startEmbedded({
    ports: {
      sessions: source,
      agentTools: {
        announce: (url) => {
          announced.push(url)
        },
        resolve: (token) => (token === 'tok-1' ? { sessionId: 's1', windowKey: 'w1' } : undefined)
      }
    }
  })
  api = createApiClient({ url: server.url, token: server.token })
})
afterEach(async () => {
  await api.dispose()
  await server.stop()
})

describe('the records through the client', () => {
  it('lists the adoptable records, whole and by ids', async () => {
    expect((await api.sessions.listAdoptable()).map((r) => r.id)).toEqual(['r1'])
    const byId = await api.sessions.listAdoptable(['r1', 's2'])
    expect(byId.map((r) => r.id).sort()).toEqual(['r1', 's2'])
    expect(byId.find((r) => r.id === 's2')).toMatchObject({ running: true, windowKey: 'w2' })
    expect(byId.find((r) => r.id === 'r1')).toMatchObject({ tmuxName: 'clave-r1', live: true })
  })
  it('discards a record and releases sessions', async () => {
    await api.sessions.discardRecord('clave-r1')
    expect(source.discards).toEqual(['clave-r1'])
    expect(await api.sessions.release(['s1', 's2'], 'w1')).toEqual({
      released: ['s1'],
      refused: [{ sessionId: 's2', reason: 'not-tmux' }]
    })
    expect(source.releases).toEqual([{ ids: ['s1', 's2'], fallbackWindowKey: 'w1' }])
  })
  it('announces the agent tools and resolves a token, the unknown one as its tagged error', async () => {
    await api.agentTools.announce('http://127.0.0.1:4711/mcp')
    expect(announced).toContain('http://127.0.0.1:4711/mcp')
    expect(await api.agentTools.resolveToken('tok-1')).toEqual({ sessionId: 's1', windowKey: 'w1' })
    const error = await api.agentTools.resolveToken('nope').catch((e) => e)
    expect(error).toBeInstanceOf(AgentTokenUnknown)
  })
  it('throws the capability failure of a server with no records', async () => {
    await api.dispose()
    await server.stop()
    server = await startEmbedded({ ports: {} })
    api = createApiClient({ url: server.url, token: server.token })
    const error = await api.sessions.listAdoptable().catch((e) => e)
    expect(error).toBeInstanceOf(CapabilityUnavailable)
    const tools = await api.agentTools.announce('http://127.0.0.1:1/mcp').catch((e) => e)
    expect(tools).toBeInstanceOf(CapabilityUnavailable)
  })
})

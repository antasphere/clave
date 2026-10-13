import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentTokenOwner } from '@clave/contract/agent-tools'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource } from '../test-support'
import type { AgentTokensService } from './port'

/**
 * The agent tools domain (wave 4, lane C): the shell announces its MCP
 * address, main resolves a token it does not know, and a token nobody
 * minted is the declared failure, never an empty answer. The token travels
 * in a request body: the test posts it and never puts it in a URL.
 */
let server: EmbeddedServer
let announced: string[]
let owners: Map<string, AgentTokenOwner>
const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json'
})
const post = (path: string, body: unknown, token = server.token): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body)
  })

const fake = (): AgentTokensService => ({
  announce: (url) => {
    announced.push(url)
  },
  resolve: (token) => owners.get(token)
})

beforeEach(async () => {
  announced = []
  owners = new Map([['tok-1', { sessionId: 's1', windowKey: 'w1' }]])
  server = await startEmbedded({ ports: { sessions: new FakeSource(), agentTools: fake() } })
})
afterEach(async () => {
  await server.stop()
})

describe('the agent tools', () => {
  it('takes the announced address', async () => {
    const response = await post('/agent-tools/announce', { url: 'http://127.0.0.1:4711/mcp' })
    expect(response.status).toBe(204)
    expect(announced).toEqual(['http://127.0.0.1:4711/mcp'])
    expect((await post('/agent-tools/announce', { url: '' })).status).toBe(400)
  })
  it('resolves a token to its session and window', async () => {
    const response = await post('/agent-tools/resolve-token', { token: 'tok-1' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessionId: 's1', windowKey: 'w1' })
  })
  it('answers the declared failure for a token nobody minted', async () => {
    const response = await post('/agent-tools/resolve-token', { token: 'nope' })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ _tag: 'AgentTokenUnknown' })
  })
  it('refuses a resolve without the server token', async () => {
    expect((await post('/agent-tools/resolve-token', { token: 'tok-1' }, 'wrong')).status).toBe(401)
  })
  it('says what it cannot do on a server with no writer behind it', async () => {
    await server.stop()
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    for (const response of [
      await post('/agent-tools/announce', { url: 'http://127.0.0.1:1/mcp' }),
      await post('/agent-tools/resolve-token', { token: 'tok-1' })
    ]) {
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({
        _tag: 'CapabilityUnavailable',
        capability: 'agent-tools'
      })
    }
  })
})

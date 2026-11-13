import { describe, it, expect, vi } from 'vitest'

// The spawn module reaches pty-backend (the login shell's environment), which
// pulls node-pty and electron at import; neither is needed here.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./mcp/mcp-runtime', () => ({
  getMcpRuntime: () => null,
  writeSessionMcpConfig: () => null,
  deleteSessionMcpConfig: () => undefined
}))

import {
  providerConnectionsForListing,
  providerInjectionForSpawn,
  setConnectionListingSource
} from './provider-injection-spawn'
import type { ConnectionForSpawn } from './provider-injection'
import type { syncPiConnectionDir } from './provider-injection-pi-dir'
import type { CatalogModel } from './models-catalog'

/**
 * The spawn's half of a connection (PRDCT-4496): opened for Pi and OpenCode
 * alone, refused when the named one is gone, and for Pi a directory of the
 * connection's own as `PI_CODING_AGENT_DIR`. Made-up values only.
 */

const VALUE = 'made-up-value-spawn'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the mocks' own types are what the tests read
function deps(connections: Record<string, ConnectionForSpawn>) {
  const sync = vi.fn<typeof syncPiConnectionDir>(() => '/made-up/pi-connections/conn-1')
  const catalog = vi.fn<(id: string) => Promise<CatalogModel[]>>(async () => [
    { id: 'qwen-a', name: 'Qwen A', reasoning: true, toolCall: true }
  ])
  const source = vi.fn(async (id: string) => connections[id] ?? null)
  return {
    sync,
    catalog,
    source,
    all: {
      source,
      sync,
      catalog,
      root: () => '/made-up/pi-connections',
      loginEnv: () => ({}),
      homedir: () => '/made-up/home'
    }
  }
}

const deepseek: ConnectionForSpawn = {
  id: 'conn-1',
  label: 'DeepSeek',
  company: 'deepseek',
  value: VALUE
}
const alibaba: ConnectionForSpawn = { ...deepseek, label: 'Alibaba', company: 'alibaba' }

describe('providerInjectionForSpawn', () => {
  it('gives nothing to a kind other than Pi or OpenCode, and never opens a connection', async () => {
    const d = deps({ 'conn-1': deepseek })
    for (const kind of ['claude', 'codex', 'antigravity', 'claude-agents', null] as const) {
      const out = await providerInjectionForSpawn(kind, { connectionId: 'conn-1' }, d.all)
      expect(out).toEqual({})
      // The process-only fields are named, so a client's own are overwritten.
      expect('providerEnv' in out).toBe(true)
    }
    expect(d.source).not.toHaveBeenCalled()
  })

  it('refuses a connection that is no longer there', async () => {
    const d = deps({})
    await expect(providerInjectionForSpawn('pi', { connectionId: 'gone' }, d.all)).rejects.toThrow(
      'The selected connection is no longer available.'
    )
    await expect(
      providerInjectionForSpawn('opencode', { connectionId: 'gone' }, { ...d.all, source: null })
    ).rejects.toThrow('The selected connection is no longer available.')
  })

  it('a Pi connection with a road: its variable, its provider, its own directory', async () => {
    const d = deps({ 'conn-1': deepseek })
    const out = await providerInjectionForSpawn('pi', { connectionId: 'conn-1' }, d.all)
    expect(out.providerEnv).toEqual({
      DEEPSEEK_API_KEY: VALUE,
      PI_CODING_AGENT_DIR: '/made-up/pi-connections/conn-1'
    })
    expect(out.piProvider).toBe('deepseek')
    expect(d.sync).toHaveBeenCalledWith({
      root: '/made-up/pi-connections',
      homeAgentDir: '/made-up/home/.pi/agent',
      connectionId: 'conn-1',
      providerId: 'deepseek',
      entry: { apiKey: '$DEEPSEEK_API_KEY' }
    })
    // A provider Pi ships is not declared in full: no catalogue.
    expect(d.catalog).not.toHaveBeenCalled()
  })

  it("reads the person's agent directory from their login shell", async () => {
    const d = deps({ 'conn-1': deepseek })
    await providerInjectionForSpawn(
      'pi',
      { connectionId: 'conn-1' },
      { ...d.all, loginEnv: () => ({ PI_CODING_AGENT_DIR: '/made-up/own-agent' }) }
    )
    expect(d.sync.mock.calls[0][0]).toMatchObject({ homeAgentDir: '/made-up/own-agent' })
  })

  it('a full entry asks the catalogue for the company models', async () => {
    const d = deps({ 'conn-1': alibaba })
    const out = await providerInjectionForSpawn('pi', { connectionId: 'conn-1' }, d.all)
    expect(d.catalog).toHaveBeenCalledWith('alibaba-coding-plan')
    expect(out.piProvider).toBe('clave-alibaba')
    expect(d.sync.mock.calls[0][0]).toMatchObject({
      providerId: 'clave-alibaba',
      entry: { models: [{ id: 'qwen-a', name: 'Qwen A' }] }
    })
  })

  it('OpenCode: no Pi directory, standalone, the model inline', async () => {
    const d = deps({ 'conn-1': deepseek })
    const out = await providerInjectionForSpawn(
      'opencode',
      { connectionId: 'conn-1', model: 'deepseek-chat' },
      d.all
    )
    expect(d.sync).not.toHaveBeenCalled()
    expect(out.opencodeStandalone).toBe(true)
    expect(out.providerEnv?.DEEPSEEK_API_KEY).toBe(VALUE)
    expect(out.providerEnv?.PI_CODING_AGENT_DIR).toBeUndefined()
    expect(JSON.parse(out.providerEnv!.OPENCODE_CONFIG_CONTENT).model).toBe(
      'deepseek/deepseek-chat'
    )
  })

  it("no connection: Pi keeps the caller's provider, OpenCode gets its model", async () => {
    const d = deps({})
    const pi = await providerInjectionForSpawn('pi', { model: 'm' }, d.all)
    expect('piProvider' in pi).toBe(false)
    expect(pi.providerEnv).toBeUndefined()
    const oc = await providerInjectionForSpawn('opencode', { model: 'deepseek/m' }, d.all)
    expect(oc.providerEnv).toEqual({ OPENCODE_CONFIG_CONTENT: '{"model":"deepseek/m"}' })
    expect(d.source).not.toHaveBeenCalled()
  })
})

describe('providerConnectionsForListing', () => {
  it('lists none until the store plugs in, then what it answers for the harness', () => {
    expect(providerConnectionsForListing('pi')).toEqual([])
    setConnectionListingSource((harness) =>
      harness === 'pi' ? [{ id: 'c-1', label: 'Made-up', company: 'deepseek' }] : []
    )
    try {
      expect(providerConnectionsForListing('pi')).toEqual([
        { id: 'c-1', label: 'Made-up', company: 'deepseek' }
      ])
      expect(providerConnectionsForListing('opencode')).toEqual([])
    } finally {
      setConnectionListingSource(null)
    }
  })
})

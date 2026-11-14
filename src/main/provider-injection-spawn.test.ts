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
  piSessionLookupEnv,
  providerInjectionForSpawn,
  setConnectionListingSource
} from './provider-injection-spawn'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ConnectionForSpawn } from './provider-injection'
import { syncPiConnectionDir } from './provider-injection-pi-dir'
import type { CatalogModel } from './models-catalog'
import type { ModelsCatalogView } from '@clave/contract/settings/models-catalog-view'
import { piStartModels } from './mcp/provider-launch-listing'

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
      homedir: () => '/made-up/home',
      ownDefault: () => null
    }
  }
}

const deepseek: ConnectionForSpawn = {
  id: 'conn-1',
  label: 'DeepSeek',
  company: 'deepseek',
  endpoint: { wireFormat: 'openai-chat', baseUrl: 'https://api.deepseek.com' },
  value: VALUE
}
const alibaba: ConnectionForSpawn = {
  ...deepseek,
  label: 'Alibaba',
  company: 'alibaba',
  endpoint: { wireFormat: 'openai-chat', baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1' }
}

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

  it('refuses a connection that takes a key and has none, on a road and on a generic one', async () => {
    const generic: ConnectionForSpawn = {
      ...alibaba,
      company: 'generic',
      endpoint: { wireFormat: 'openai-chat', baseUrl: 'https://made-up.invalid/v1' }
    }
    const d = deps({ road: { ...deepseek, value: null }, generic: { ...generic, value: null } })
    for (const kind of ['pi', 'opencode'] as const)
      for (const id of ['road', 'generic'])
        await expect(providerInjectionForSpawn(kind, { connectionId: id }, d.all)).rejects.toThrow(
          'The connection has no key yet.'
        )
    expect(d.sync).not.toHaveBeenCalled()
  })

  it('names the provider the tab’s harness puts in front of the connection’s models (PRDCT-4427)', async () => {
    const d = deps({ ds: deepseek, ali: alibaba })
    const of = async (kind: 'pi' | 'opencode', id: string): Promise<string | undefined> =>
      (await providerInjectionForSpawn(kind, { connectionId: id, model: 'm' }, d.all)).modelProvider
    expect(await of('pi', 'ds')).toBe('deepseek')
    expect(await of('opencode', 'ds')).toBe('deepseek')
    // No road of Pi's own for Alibaba: the one Clave declares.
    expect(await of('pi', 'ali')).toBe('clave-alibaba')
    expect(await of('opencode', 'ali')).toBe('alibaba-coding-plan')
    // On no connection: none.
    expect((await providerInjectionForSpawn('pi', {}, d.all)).modelProvider).toBeUndefined()
  })

  it('starts Ollama with no value: it takes none', async () => {
    const ollama: ConnectionForSpawn = {
      id: 'conn-1',
      label: 'Ollama',
      company: 'ollama',
      endpoint: { wireFormat: 'openai-chat', baseUrl: 'http://localhost:11434/v1' },
      value: null
    }
    const d = deps({ 'conn-1': ollama })
    const out = await providerInjectionForSpawn('opencode', { connectionId: 'conn-1' }, d.all)
    expect(out.providerEnv?.CLAVE_CONNECTION_API_KEY).toBe('ollama')
  })

  it('a Pi connection with a road: its variable, its provider, its own directory', async () => {
    const d = deps({ 'conn-1': deepseek })
    const out = await providerInjectionForSpawn(
      'pi',
      { connectionId: 'conn-1', model: 'deepseek-chat' },
      d.all
    )
    expect(out.providerEnv).toEqual({
      DEEPSEEK_API_KEY: VALUE,
      PI_CODING_AGENT_DIR: '/made-up/pi-connections/conn-1'
    })
    expect(out.piProvider).toBe('deepseek')
    // A picked model is the tab's own: none is chosen for it.
    expect('model' in out).toBe(false)
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

describe('a Pi tab on a connection with no model picked (PRDCT-4496)', () => {
  // Pi 1.5.2 refuses `--provider` without `--model` and exits before it
  // speaks, so the spawn always names one: the person's own Pi default when it
  // belongs to the connection's provider, else the first model listed for it.
  const kimi: ConnectionForSpawn = { ...deepseek, label: 'Kimi', company: 'moonshot' }
  const ollama: ConnectionForSpawn = {
    id: 'conn-1',
    label: 'Local Ollama',
    company: 'ollama',
    endpoint: { wireFormat: 'openai-chat', baseUrl: 'http://localhost:11434/v1' },
    value: null
  }
  const listing = vi.fn<(id: string) => Promise<CatalogModel[]>>(async (id) =>
    id === 'kimi-code-plan-global'
      ? [
          { id: 'k-first', name: 'K First', reasoning: false, toolCall: true },
          { id: 'k-second', name: 'K Second', reasoning: false, toolCall: true }
        ]
      : []
  )

  it("starts on the person's own default when it is the connection's provider's", async () => {
    const d = deps({ 'conn-1': kimi })
    const out = await providerInjectionForSpawn(
      'pi',
      { connectionId: 'conn-1' },
      {
        ...d.all,
        catalog: listing,
        ownDefault: () => ({ provider: 'kimi-coding', model: 'k-second' })
      }
    )
    expect(out.model).toBe('k-second')
    expect(out.piProvider).toBe('kimi-coding')
  })

  it('else on the first model the launcher lists for the connection', async () => {
    const d = deps({ 'conn-1': kimi })
    const out = await providerInjectionForSpawn(
      'pi',
      { connectionId: 'conn-1' },
      {
        ...d.all,
        catalog: listing,
        ownDefault: () => ({ provider: 'anthropic', model: 'made-up-claude' })
      }
    )
    expect(out.model).toBe('k-first')
  })

  it("reads the person's default from the agent directory their Pi uses", async () => {
    const d = deps({ 'conn-1': kimi })
    const ownDefault = vi.fn(() => null)
    await providerInjectionForSpawn(
      'pi',
      { connectionId: 'conn-1' },
      {
        ...d.all,
        catalog: listing,
        ownDefault,
        loginEnv: () => ({ PI_CODING_AGENT_DIR: '/made-up/own-agent' })
      }
    )
    expect(ownDefault).toHaveBeenCalledWith('/made-up/own-agent')
  })

  it('refuses in one sentence a connection with no model listed and no default of its own', async () => {
    const d = deps({ 'conn-1': ollama })
    await expect(
      providerInjectionForSpawn(
        'pi',
        { connectionId: 'conn-1' },
        {
          ...d.all,
          catalog: listing,
          ownDefault: () => ({ provider: 'kimi-coding', model: 'k-second' })
        }
      )
    ).rejects.toThrow(
      'No model is listed for the connection "Local Ollama": name one to open Pi on it.'
    )
    // Refused before any directory is written.
    expect(d.sync).not.toHaveBeenCalled()
  })

  it('never replaces a picked model, and never picks one for OpenCode', async () => {
    const d = deps({ 'conn-1': kimi })
    const all = {
      ...d.all,
      catalog: listing,
      ownDefault: () => ({ provider: 'kimi-coding', model: 'k-second' })
    }
    const picked = await providerInjectionForSpawn(
      'pi',
      { connectionId: 'conn-1', model: 'k-first' },
      all
    )
    expect('model' in picked).toBe(false)
    const oc = await providerInjectionForSpawn('opencode', { connectionId: 'conn-1' }, all)
    expect('model' in oc).toBe(false)
    // OpenCode stays on the connection's provider, with no model named.
    expect(JSON.parse(oc.providerEnv!.OPENCODE_CONFIG_CONTENT)).toEqual({
      providers: { 'kimi-code-plan-global': { settings: { apiKey: '{env:KIMI_API_KEY}' } } },
      enabled_providers: ['kimi-code-plan-global']
    })
  })

  it('a provider Clave declares lists the start model among its models', async () => {
    const d = deps({ 'conn-1': alibaba })
    const out = await providerInjectionForSpawn('pi', { connectionId: 'conn-1' }, d.all)
    expect(out.model).toBe('qwen-a')
    expect(d.sync.mock.calls[0][0].entry.models).toEqual([{ id: 'qwen-a', name: 'Qwen A' }])
  })
})

describe('clave_launch_options says what the open starts on (PRDCT-4496)', () => {
  // One catalogue, read by the open as `modelsCatalog.modelsOf` answers it and
  // by the listing as `modelsCatalog.view` does (the deprecated hidden by both).
  const providers = [
    {
      id: 'kimi-code-plan-global',
      name: 'Kimi',
      models: [
        {
          id: 'k-old',
          name: 'Old',
          reasoning: false,
          toolCall: true,
          status: 'deprecated' as const
        },
        { id: 'k-first', name: 'K First', reasoning: false, toolCall: true },
        { id: 'k-second', name: 'K Second', reasoning: false, toolCall: true }
      ]
    },
    {
      id: 'alibaba-coding-plan',
      name: 'Alibaba',
      models: [{ id: 'qwen-a', name: 'Qwen A', reasoning: false, toolCall: true }]
    }
  ]
  const catalog = async (id: string): Promise<CatalogModel[]> =>
    (providers.find((p) => p.id === id)?.models ?? []).filter((m) => m.status !== 'deprecated')
  const view = async (ids: readonly string[]): Promise<ModelsCatalogView> => ({
    fetchedAt: 1,
    stale: false,
    providers: providers.filter((p) => ids.includes(p.id))
  })
  const connections: ConnectionForSpawn[] = [
    { ...deepseek, id: 'kimi', label: 'Kimi', company: 'moonshot' },
    { ...alibaba, id: 'ali', label: 'Alibaba' },
    {
      id: 'ollama',
      label: 'Local Ollama',
      company: 'ollama',
      endpoint: { wireFormat: 'openai-chat', baseUrl: 'http://localhost:11434/v1' },
      value: null
    }
  ]

  for (const ownDefault of [
    null,
    { provider: 'kimi-coding', model: 'k-second' },
    { provider: 'clave-ollama', model: 'llama-made-up' }
  ])
    it(`names each connection's start model as the open picks it (own default ${JSON.stringify(ownDefault)})`, async () => {
      const listed = await piStartModels(connections, {
        catalog: view,
        piOwnDefault: () => ownDefault
      })
      for (const connection of connections) {
        const d = deps({ [connection.id]: connection })
        const opened = await providerInjectionForSpawn(
          'pi',
          { connectionId: connection.id },
          { ...d.all, catalog, ownDefault: () => ownDefault }
        ).then(
          (out) => ({ ok: true as const, model: out.model }),
          (error: Error) => ({ ok: false as const, reason: error.message })
        )
        const said = listed.get(connection.id)
        expect(said?.ok).toBe(opened.ok)
        if (said?.ok && opened.ok) expect(said.model).toBe(opened.model)
        if (said && !said.ok && !opened.ok) expect(said.reason).toBe(opened.reason)
      }
    })

  it('says nothing where the road cannot read the person’s default', async () => {
    expect((await piStartModels(connections, { catalog: view })).size).toBe(0)
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

describe('piSessionLookupEnv (PRDCT-4427)', () => {
  const lookupDeps = {
    root: () => '/made-up/pi-connections',
    loginEnv: () => ({ PATH: '/login/bin', PI_CODING_AGENT_DIR: '/made-up/home/.pi/agent' })
  }
  it("puts the connection's own directory over the login shell's, where its Pi runs", () => {
    expect(piSessionLookupEnv('conn-1', lookupDeps)).toEqual({
      PATH: '/login/bin',
      PI_CODING_AGENT_DIR: '/made-up/pi-connections/conn-1'
    })
  })
  it('is the same directory providerInjectionForSpawn hands the process (the real sync)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-pi-lookup-'))
    try {
      const root = path.join(tmp, 'pi-connections')
      const d = deps({ 'conn-1': { ...deepseek, company: 'moonshot' } })
      const out = await providerInjectionForSpawn(
        'pi',
        { connectionId: 'conn-1' },
        {
          ...d.all,
          sync: syncPiConnectionDir,
          root: () => root,
          loginEnv: () => ({ PI_CODING_AGENT_DIR: path.join(tmp, 'home-agent') })
        }
      )
      expect(out.providerEnv?.PI_CODING_AGENT_DIR).toBe(path.join(root, 'conn-1'))
      expect(
        piSessionLookupEnv('conn-1', { root: () => root, loginEnv: () => ({}) }).PI_CODING_AGENT_DIR
      ).toBe(out.providerEnv?.PI_CODING_AGENT_DIR)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
  it("keeps the login shell's for a tab on no connection, or an id that names no directory", () => {
    for (const id of [undefined, '', '.', '..', 'a/b', 'a\\b'])
      expect(piSessionLookupEnv(id, lookupDeps).PI_CODING_AGENT_DIR).toBe('/made-up/home/.pi/agent')
  })
})

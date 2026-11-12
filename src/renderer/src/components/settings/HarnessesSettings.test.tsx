/**
 * Settings → Harnesses (PRDCT-4424): one row per harness of the table. A
 * missing one offers Install when the table carries an installer and the
 * harness's own page when it does not (Codex); an installed one carries the
 * preferred model and the permission rung, written through the launch
 * settings store by harness id, null clearing. A ladder-less harness (Pi)
 * has no permission control at all.
 *
 * Rendered to static markup; the select is a recorder, so a test drives its
 * `onChange` as a pick in the menu would.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentUpdateStatus } from '../../../../shared/agent-updates'
import { CLAUDE_MODELS } from '../../../../shared/claude-models'
import { HARNESS_BY_ID } from '../../../../shared/harness'

const h = vi.hoisted(() => ({
  agents: [] as Partial<AgentUpdateStatus>[],
  harnesses: {} as Record<string, { preferredModel?: string; permissionDefault?: string }>,
  setHarness: vi.fn(async () => undefined),
  /** The connections a pool holds, as `connectionsForModel` answers: the
   *  models served (every model when `models` is null), none when empty. */
  connections: { claude: ['*'], codex: ['*'] } as Record<string, string[]>,
  openedSettings: [] as string[],
  selects: [] as {
    testId?: string
    value: string
    options: { value: string; label: string; hint?: string }[]
    onChange: (value: string) => void
  }[]
}))

vi.mock('../../store/agent-updates-store', () => {
  const state = (): Record<string, unknown> => ({
    supported: true,
    autoUpdate: true,
    busy: false,
    agents: h.agents,
    update: vi.fn(),
    check: vi.fn(),
    setAutoUpdate: vi.fn()
  })
  return {
    useAgentUpdatesStore: Object.assign(
      (select?: (s: Record<string, unknown>) => unknown) => (select ? select(state()) : state()),
      { getState: state }
    )
  }
})
vi.mock('../../store/launch-settings-store', () => {
  const state = (): Record<string, unknown> => ({
    harnesses: h.harnesses,
    setHarness: h.setHarness
  })
  return {
    useLaunchSettingsStore: Object.assign(
      (select: (s: Record<string, unknown>) => unknown) => select(state()),
      { getState: state }
    )
  }
})
vi.mock('../../lib/switch-account', () => ({
  connectionsForModel: (pool: string, model: string | undefined) => {
    const served = h.connections[pool] ?? []
    const usable = served.includes('*') || model === undefined || served.includes(model)
    return served.length === 0
      ? []
      : [{ id: 'c1', label: 'Work', headroom: null, summary: undefined, usable, suggested: usable }]
  }
}))
vi.mock('../../store/session-store', () => ({
  useSessionStore: {
    getState: () => ({
      openSettings: (section: string) => {
        h.openedSettings.push(section)
      }
    })
  }
}))
vi.mock('./connection-companies', () => ({
  CONNECTION_COMPANY_BY_POOL: {
    claude: { id: 'anthropic', name: 'Anthropic', pool: 'claude' },
    codex: { id: 'openai', name: 'OpenAI', pool: 'codex' }
  }
}))
vi.mock('../../store/workspace-store', () => ({
  useWorkspaceStore: { getState: () => ({ workspaces: [], activeWorkspaceId: null }) }
}))
vi.mock('./AgentsSettings', () => ({ LaunchProfilesFamily: () => null }))
vi.mock('./primitives', async (original) => {
  const real = await original<typeof import('./primitives')>()
  return {
    ...real,
    SettingsSelect: (props: (typeof h.selects)[number]) => {
      h.selects.push(props)
      return <div data-select={props.testId} />
    }
  }
})

Object.assign(globalThis, {
  window: {
    electronAPI: {
      onboardingInstall: vi.fn(),
      openExternal: vi.fn(),
      adaptersModels: vi.fn(async () => [])
    }
  }
})

import { HarnessesSettings } from './HarnessesSettings'

function agent(id: string, installed: boolean): Partial<AgentUpdateStatus> {
  return {
    id: id as AgentUpdateStatus['id'],
    name: id,
    command: id,
    installed,
    install: null,
    currentVersion: installed ? '1.0.0' : null,
    latestVersion: installed ? '1.0.0' : null,
    updateAvailable: false,
    phase: 'idle',
    lastCheckedAt: 1,
    note: null,
    error: null
  }
}

function render(): string {
  h.selects = []
  return renderToStaticMarkup(<HarnessesSettings />)
}

/** The opening tag of the element carrying `attr`. */
function tagWith(html: string, attr: string): string | null {
  const at = html.indexOf(attr)
  if (at < 0) return null
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1)
}

const select = (testId: string): (typeof h.selects)[number] | undefined =>
  h.selects.find((s) => s.testId === testId)

beforeEach(() => {
  h.agents = []
  h.harnesses = {}
  h.setHarness.mockClear()
})

describe('a missing harness', () => {
  it('offers Install when the table has an installer, the page otherwise', () => {
    h.agents = ['claude', 'codex', 'antigravity', 'pi'].map((id) => agent(id, false))
    const html = render()
    for (const id of ['claude', 'antigravity', 'pi']) {
      const button = tagWith(html, `data-harness-install="${id}"`)
      expect(button, id).not.toBeNull()
      expect(button, id).not.toContain('disabled')
      expect(button, id).toContain(`title="${HARNESS_BY_ID[id as 'pi'].install}"`)
    }
    expect(tagWith(html, 'data-harness-install="codex"')).toBeNull()
    expect(tagWith(html, 'data-harness-docs="codex"')).not.toBeNull()
    expect(html).toContain('Install it from its own page')
  })

  it('shows neither the model nor the permissions until it is there', () => {
    h.agents = ['claude', 'codex', 'antigravity', 'pi'].map((id) => agent(id, false))
    render()
    expect(h.selects).toEqual([])
  })

  it('reads a harness not checked yet as present: no Install, its settings shown (verifier, F4)', () => {
    h.agents = ['claude', 'codex', 'antigravity', 'pi'].map((id) => ({
      ...agent(id, false),
      lastCheckedAt: null
    }))
    const html = render()
    expect(html).not.toContain('data-harness-install=')
    expect(h.selects.length).toBeGreaterThan(0)
  })

  it('offers no Install for a harness that is installed', () => {
    h.agents = ['claude', 'codex', 'antigravity', 'pi'].map((id) => agent(id, true))
    const html = render()
    expect(html).not.toContain('data-harness-install=')
    expect(html).not.toContain('Install it from its own page')
  })
})

describe('the preferred model', () => {
  it("writes Claude's pick through setHarness by id, and Default clears it with null", () => {
    h.agents = [agent('claude', true)]
    render()
    const model = select('harness-model-claude')!
    expect(model.value).toBe('__default__')
    expect(model.options.map((o) => o.value)).toEqual([
      '__default__',
      ...CLAUDE_MODELS.map((m) => m.id)
    ])
    model.onChange(CLAUDE_MODELS[0].id)
    expect(h.setHarness).toHaveBeenLastCalledWith('claude', { preferredModel: CLAUDE_MODELS[0].id })
    model.onChange('__default__')
    expect(h.setHarness).toHaveBeenLastCalledWith('claude', { preferredModel: null })
  })

  it('shows the stored model as the selected one', () => {
    h.agents = [agent('claude', true)]
    h.harnesses = { claude: { preferredModel: CLAUDE_MODELS[1].id } }
    render()
    expect(select('harness-model-claude')!.value).toBe(CLAUDE_MODELS[1].id)
  })

  it("loads Codex's list lazily, a sentence for Pi, nothing for Antigravity, never a text field", () => {
    h.agents = ['codex', 'antigravity', 'pi'].map((id) => agent(id, true))
    const html = render()
    expect(html).toContain('data-harness-models-loading')
    expect(html).toContain('runs the model its own configuration names')
    expect(select('harness-model-pi')).toBeUndefined()
    expect(select('harness-model-antigravity')).toBeUndefined()
    expect(html).not.toContain('data-harness-model-input')
  })
})

describe('the permissions', () => {
  it("lists the harness's own ladder after Default, and writes the rung by id", () => {
    h.agents = ['claude', 'codex', 'antigravity'].map((id) => agent(id, true))
    render()
    for (const id of ['claude', 'codex', 'antigravity'] as const) {
      const permission = select(`harness-permission-${id}`)!
      expect(permission.options.map((o) => o.value)).toEqual([
        '__default__',
        ...HARNESS_BY_ID[id].permissionRungs.map((r) => r.id)
      ])
      expect(permission.options.slice(1).map((o) => o.hint)).toEqual(
        HARNESS_BY_ID[id].permissionRungs.map((r) => r.hint)
      )
    }
    const codex = select('harness-permission-codex')!
    codex.onChange('workspace-write')
    expect(h.setHarness).toHaveBeenLastCalledWith('codex', { permissionDefault: 'workspace-write' })
    codex.onChange('__default__')
    expect(h.setHarness).toHaveBeenLastCalledWith('codex', { permissionDefault: null })
  })

  it('is absent for Pi, whose ladder is empty', () => {
    h.agents = [agent('pi', true)]
    render()
    expect(select('harness-permission-pi')).toBeUndefined()
  })
})

describe('the default model comes from the connections', () => {
  it('says to connect the company, with the way to Connections, when the pool holds none', () => {
    h.connections = { claude: [], codex: [] }
    h.agents = ['claude'].map((id) => agent(id, true))
    const html = render()
    expect(html).toContain('Connect Anthropic to pick one')
    expect(tagWith(html, 'data-harness-connect="claude"')).not.toBeNull()
    expect(h.selects.find((s) => s.testId === 'harness-model-claude')).toBeUndefined()
    h.connections = { claude: ['*'], codex: ['*'] }
  })
  it('lists only the models a usable connection serves', () => {
    h.connections = { claude: ['claude-opus-5-5', 'claude-sonnet-5-5'], codex: [] }
    h.agents = ['claude'].map((id) => agent(id, true))
    render()
    const select = h.selects.find((s) => s.testId === 'harness-model-claude')!
    expect(select.options.map((o) => o.value)).toEqual([
      '__default__',
      'claude-opus-5-5',
      'claude-sonnet-5-5'
    ])
    h.connections = { claude: ['*'], codex: ['*'] }
  })
  it('has no control for Pi, whose model its own configuration names', () => {
    h.agents = ['pi'].map((id) => agent(id, true))
    const html = render()
    expect(html).toContain('runs the model its own configuration names')
    expect(html).not.toContain('data-harness-model-input')
  })
})

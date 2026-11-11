/**
 * The launcher's chevron menu (PRDCT-4423): which tool, which model, who
 * pays, one level each. The menu is rendered on the server with the menu
 * primitives replaced by plain elements that draw every level at once and
 * keep the handlers of each item, so a test reads the whole tree in one
 * markup string and "clicks" an item by calling its handler. The machine's
 * source, the stores and the launch path are fakes the test sets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

type Handlers = { onSelect?: () => void; onClick?: () => void; disabled?: boolean }

const { select } = vi.hoisted(() => ({
  select:
    <T,>(state: () => T) =>
    (selector: (s: T) => unknown): unknown =>
      selector(state())
}))

const g = vi.hoisted(() => ({
  items: [] as { attrs: Record<string, unknown>; handlers: Handlers }[],
  launches: [] as unknown[],
  pinned: [] as unknown[],
  openSettings: vi.fn(),
  installed: {} as Record<string, boolean>,
  interactionMode: 'chat' as string,
  harnesses: {} as Record<string, { preferredModel?: string }>,
  accounts: {
    claude: [
      { id: 'work', label: 'Work', title: 'Work', headroom: null },
      { id: 'home', label: 'Home', title: 'Home', headroom: null }
    ],
    codex: [{ id: 'default', label: 'Default', title: 'Default', headroom: null }]
  } as Record<string, { id: string; label: string; title: string; headroom: null }[]>,
  customProfiles: [] as { id: string; name: string; family: string; pi?: { model?: string } }[],
  /** Accounts out of credits for a model: `${account}:${model}`. */
  spent: new Set<string>()
}))

vi.mock('@clave/ui/components', () => {
  const dataOf = (props: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(props).filter(([key]) => key.startsWith('data-')))
  const Box = ({ children }: { children?: ReactNode }): ReactNode => <div>{children}</div>
  const Item = (
    props: Record<string, unknown> & Handlers & { children?: ReactNode }
  ): ReactNode => {
    g.items.push({
      attrs: dataOf(props),
      handlers: { onSelect: props.onSelect, onClick: props.onClick, disabled: props.disabled }
    })
    return (
      <div
        role="menuitem"
        {...dataOf(props)}
        data-disabled={props.disabled ? 'true' : undefined}
        title={props.title as string | undefined}
      >
        {props.children}
      </div>
    )
  }
  return {
    DropdownMenu: Box,
    DropdownMenuTrigger: Box,
    DropdownMenuContent: Box,
    DropdownMenuItem: Item,
    DropdownMenuLabel: Box,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuShortcut: ({ children }: { children?: ReactNode }) => (
      <kbd data-shortcut>{children}</kbd>
    ),
    DropdownMenuSub: ({ children }: { children?: ReactNode }) => <div data-sub="">{children}</div>,
    DropdownMenuSubTrigger: Item,
    DropdownMenuSubContent: Box
  }
})

vi.mock('../../store/agent-store', () => ({ useAgentStore: select(() => ({ agents: [] })) }))
vi.mock('../../store/location-store', () => ({
  useLocationStore: select(() => ({ locations: [] }))
}))
vi.mock('../../store/claude-profile-store', () => ({
  useClaudeProfileStore: select(() => ({ profiles: [], selectedProfileId: 'work' }))
}))
vi.mock('../../store/codex-account-store', () => ({
  useCodexAccountStore: select(() => ({ accounts: [], selectedAccountId: 'default' }))
}))
vi.mock('../../store/usage-store', () => ({
  useClaudeAccountsUsage: select(() => ({ byAccount: {} })),
  useCodexAccountsUsage: select(() => ({ byAccount: {} }))
}))
vi.mock('../../store/workspace-store', () => ({
  useWorkspaceStore: select(() => ({ activeWorkspaceId: 'ws' })),
  getWorkspaceById: () => ({ id: 'ws', rootDir: '/repo' }),
  workspaceServer: () => null
}))
vi.mock('../../store/launch-prefs', () => ({
  useLaunchPrefsStore: select(() => ({ byWorkspace: {} })),
  getLastAgentSetup: () => ({ kind: 'claude', dangerousMode: false, model: 'claude-opus-5-5' })
}))
vi.mock('../../lib/launch-session', () => ({
  launchSession: async (request: unknown) => {
    g.launches.push(request)
    return 'new'
  }
}))
vi.mock('../../store/launch-profile-store', () => ({
  useLaunchProfileStore: select(() => ({ preferences: {} })),
  setWorkspaceLaunchProfile: async (...args: unknown[]) => {
    g.pinned.push(args)
  }
}))
vi.mock('../../store/server-settings-store', () => ({
  loadServerSettings: async () => {},
  startServerSettingsEvents: () => {},
  useServerSettingsStore: select(() => ({ byServer: {} }))
}))
vi.mock('../agents/AgentPickerPopover', () => ({ AgentPickerPopover: () => null }))
vi.mock('../../store/keymap-store', () => ({
  useShortcutLabel: (id: string) => `⌘${id}`
}))
vi.mock('../../store/fleet-store', () => ({
  useFleetStore: select(() => ({ connections: [], statuses: {} }))
}))
vi.mock('../../store/pairing-store', () => ({
  usePairingStore: select(() => ({ servers: {} })),
  pairedServerWorkspaces: () => []
}))
vi.mock('../../store/session-store', () => ({
  useSessionStore: { getState: () => ({ openSettings: g.openSettings }) }
}))
vi.mock('../../store/launch-settings-store', () => ({
  useLaunchSettingsStore: select(() => ({
    interactionMode: g.interactionMode,
    harnesses: g.harnesses
  }))
}))
vi.mock('../../store/agent-updates-store', () => ({
  useAgentUpdatesStore: select(() => ({
    agents: Object.entries(g.installed).map(([id, installed]) => ({ id, installed }))
  }))
}))
vi.mock('../../lib/launch-source', () => {
  const builtIn = (family: string): { id: string; name: string; family: string } => ({
    id: `builtin-${family}`,
    name: family,
    family
  })
  const source = {
    serverId: 'local',
    name: 'This Mac',
    ready: true,
    profilesFor: (family: string) => [
      builtIn(family),
      ...g.customProfiles.filter((p) => p.family === family)
    ],
    selectedProfileId: (family: string) => `builtin-${family}`,
    accounts: (family: string) => g.accounts[family] ?? [],
    selectedAccountId: (family: string) => g.accounts[family]?.[0]?.id ?? null,
    chatProfileId: (family: string) =>
      family === 'claude' || family === 'codex' ? `${family}-chat` : undefined,
    connections: (family: string, model: string | undefined) => {
      const list = (g.accounts[family] ?? []).map((a) => ({
        id: a.id,
        label: a.label,
        headroom: `${a.label} headroom`,
        summary: undefined,
        usable: !g.spent.has(`${a.id}:${model}`),
        suggested: false
      }))
      const pick = list.find((c) => c.usable)
      if (pick) pick.suggested = true
      return list
    }
  }
  return { localLaunchSource: () => source, serverLaunchSource: () => source }
})

import { renderToStaticMarkup } from 'react-dom/server'
import { SessionLauncher } from './SessionLauncher'

const render = (): string => {
  g.items = []
  return renderToStaticMarkup(<SessionLauncher onRemoteLaunch={() => {}} />)
}
const item = (attr: string, value?: string): { handlers: Handlers } => {
  const found = g.items.find((i) =>
    value === undefined ? attr in i.attrs : i.attrs[attr] === value
  )
  if (!found) throw new Error(`no item ${attr}=${value}`)
  return found
}
const rows = (html: string): string[] =>
  [...html.matchAll(/data-harness-row="([^"]+)"/g)].map((m) => m[1])
const launched = (): { setup: Record<string, unknown> } =>
  g.launches.at(-1) as { setup: Record<string, unknown> }

beforeEach(() => {
  g.launches = []
  g.pinned = []
  g.openSettings.mockReset()
  g.installed = {}
  g.interactionMode = 'chat'
  g.harnesses = {}
  g.customProfiles = []
  g.spent = new Set()
  vi.stubGlobal('window', {})
})

describe('the rows are the installed harnesses', () => {
  it('lists the four harnesses by name in table order, none checked yet counting as installed', () => {
    const html = render()
    expect(rows(html)).toEqual(['claude', 'codex', 'antigravity', 'pi'])
    for (const name of ['Claude Code', 'Codex', 'Antigravity', 'Pi']) expect(html).toContain(name)
    // The old variant rows are gone; Agents lives inside the Claude Code row.
    expect(html).not.toContain('skip permissions)')
    expect(html).not.toContain('YOLO')
    expect(html).not.toContain('Claude Agents')
    expect(html).toContain('Agents…')
    expect(html).toContain('⌘newClaude')
    expect(html).toContain('⌘newPi')
  })

  it('drops a harness a check found missing', () => {
    g.installed = { codex: false, antigravity: true }
    expect(rows(render())).toEqual(['claude', 'antigravity', 'pi'])
  })

  it('says so when no harness is installed, and opens the harness settings', () => {
    g.installed = { claude: false, codex: false, antigravity: false, pi: false }
    const html = render()
    expect(rows(html)).toEqual([])
    expect(html).toContain('No harness installed')
    expect(item('data-no-harness').handlers.disabled).toBe(true)
    item('data-install-harness').handlers.onSelect!()
    expect(g.openSettings).toHaveBeenCalledWith('agents')
  })
})

describe('a click on a row launches at once', () => {
  // A row names no profile: the transport comes from the interaction mode on
  // the launch road (`transportProfileFor`, launch-session.ts), the same for
  // the agent button and the shortcuts (the verifier's round 1 found the
  // rows alone followed the mode).
  it('runs the preferred model, naming no profile, so the launch road derives the transport', async () => {
    g.harnesses = { claude: { preferredModel: 'claude-fable-5-1[1m]' } }
    render()
    item('data-harness-row', 'claude').handlers.onClick!()
    await Promise.resolve()
    expect(launched().setup).toEqual({
      kind: 'claude',
      dangerousMode: false,
      model: 'claude-fable-5-1[1m]'
    })
    // The transport is not a pick: it never becomes the workspace's profile.
    expect(g.pinned).toEqual([])
  })

  it('names no model when none is preferred, whatever the mode', async () => {
    g.interactionMode = 'terminal'
    render()
    item('data-harness-row', 'codex').handlers.onClick!()
    await Promise.resolve()
    expect(launched().setup).toEqual({ kind: 'codex', dangerousMode: false })
  })

  it('a harness with no chat adapter launches the same way, with no profile named', async () => {
    render()
    item('data-harness-row', 'antigravity').handlers.onSelect!()
    await Promise.resolve()
    expect(launched().setup).toEqual({ kind: 'antigravity', dangerousMode: false })
  })

  it('Agents… starts claude agents, with no profile named', async () => {
    render()
    item('data-harness-agents').handlers.onSelect!()
    await Promise.resolve()
    expect(launched().setup).toEqual({ kind: 'claude-agents', dangerousMode: false })
  })
})

describe('hover: the models, then who pays', () => {
  it('offers the Claude models, the preferred one checked', () => {
    g.harnesses = { claude: { preferredModel: 'claude-opus-5-5' } }
    const html = render()
    for (const name of ['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 4.5'])
      expect(html).toContain(name)
    expect(html).toMatch(/data-harness-model="claude-opus-5-5"[^]*?<svg/)
  })

  it('disables a model no connection has credits for, with the hint', () => {
    g.spent = new Set(['work:claude-fable-5-1[1m]', 'home:claude-fable-5-1[1m]'])
    const html = render()
    expect(item('data-harness-model', 'claude-fable-5-1[1m]').handlers.disabled).toBe(true)
    expect(html).toContain('No connection with Fable credits')
    expect(item('data-harness-model', 'claude-opus-5-5').handlers.disabled).toBeFalsy()
  })

  it('lists the connections for a model, the suggested one badged, and launches on the one picked', async () => {
    g.spent = new Set(['work:claude-opus-5-5'])
    const html = render()
    const opus = html.slice(html.indexOf('data-harness-model="claude-opus-5-5"'))
    const connections = opus.slice(0, opus.indexOf('data-harness-model="claude-fable-5-1[1m]"'))
    expect(connections).toMatch(/data-harness-connection="home" data-suggested="true"/)
    expect(connections).toContain('Suggested')
    expect(connections).toContain('Home headroom')
    const home = g.items.find(
      (i) =>
        i.attrs['data-harness-connection'] === 'home' && i.handlers.onSelect && !i.handlers.disabled
    )!
    home.handlers.onSelect!()
    await Promise.resolve()
    expect(launched().setup).toEqual({
      kind: 'claude',
      dangerousMode: false,
      model: 'claude-opus-5-5',
      claudeProfileId: 'home'
    })
  })

  it('a single connection makes the model a click item, with no connections level', () => {
    const html = render()
    // Codex has one account here: no codex connection rows.
    expect(html).not.toContain('data-harness-connection="default"')
    // Its models are read from its CLI when the menu opens.
    expect(item('data-harness-model', 'loading').handlers.disabled).toBe(true)
  })

  it('Pi offers its default and the models its saved profiles pin, with no connections', async () => {
    g.customProfiles = [{ id: 'pi-local', name: 'Local', family: 'pi', pi: { model: 'qwen3' } }]
    render()
    item('data-harness-model', 'qwen3').handlers.onSelect!()
    await Promise.resolve()
    expect(launched().setup).toMatchObject({ kind: 'pi', model: 'qwen3' })
    expect(launched().setup).not.toHaveProperty('claudeProfileId')
    item('data-harness-model', 'default').handlers.onSelect!()
    await Promise.resolve()
    expect(launched().setup).not.toHaveProperty('model')
  })
})

describe('Advanced: the saved launch profiles', () => {
  it('appears only beside a saved profile, never lists a chat twin, and pins the one picked', async () => {
    expect(render()).not.toContain('data-harness-advanced')
    g.customProfiles = [
      { id: 'work', name: 'Work CLI', family: 'claude' },
      { id: 'chat:claude:work', name: 'Work CLI (chat)', family: 'claude' },
      { id: 'claude-chat', name: 'Claude (chat)', family: 'claude' }
    ]
    const html = render()
    expect(html).toContain('data-harness-advanced="claude"')
    expect(html).toContain('data-launch-profile-entry="work"')
    expect(html).not.toContain('data-launch-profile-entry="chat:claude:work"')
    expect(html).not.toContain('data-launch-profile-entry="claude-chat"')
    item('data-launch-profile-entry', 'work').handlers.onSelect!()
    await Promise.resolve()
    expect(launched().setup).toMatchObject({ kind: 'claude', launchProfileId: 'work' })
    expect(g.pinned).toEqual([['ws', 'claude', 'work']])
  })
})

describe('the agent button says what a click does', () => {
  it('reads harness · model · connection', () => {
    const html = render()
    expect(html).toContain('New session — Claude Code · Opus 5.5 · Work')
  })
})

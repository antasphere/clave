import { describe, expect, it, vi } from 'vitest'
import type { ClaveApiClient } from '@clave/client'
import type { GroupTerminal, LayoutSnapshot, SidebarGroup } from '@clave/contract/sidebar'
import type { Session } from '@clave/contract/sessions'
import type { SessionRecord } from '../sessions/adapters/pty-backend'
import type { TabClosedCapturePayload } from '../exchange-capture/types'
import {
  NOT_SERVED,
  resolveGroupRef,
  serveCommand,
  type ServedContext,
  type ServedShell,
  type ToolWindow
} from './served-tools'

vi.mock('./roads', () => ({ noteRoad: vi.fn() }))
import { noteRoad } from './roads'

const group = (id: string, extra: Partial<SidebarGroup> = {}): SidebarGroup => ({
  ...{ id, name: id, sessionIds: [], collapsed: false, cwd: null, terminals: [] },
  ...extra
})
const layout = (windowKey: string, groups: SidebarGroup[]): LayoutSnapshot => ({
  ...{ windowKey, revision: 0, groups, displayOrder: groups.map((g) => g.id) }
})
const session = (id: string, extra: Partial<Session> = {}): Session => ({
  ...{ id, provider: '*', transport: 'pty', cwd: '/work', windowKey: 'wA', state: 'idle' },
  ...{ createdAt: 0, adapterId: 'pty', title: `title-${id}` },
  ...extra
})
const NO_MODE = { claudeMode: false, antigravityMode: false, codexMode: false, piMode: false }
const record = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  ...{ id, cwd: '/work', folderName: 'work', ...NO_MODE },
  ...{ claudeAgentsMode: false, dangerousMode: false },
  ...extra
})
const terminal = (id: string, serverUrl: string): GroupTerminal => ({
  ...{ id, command: 'dev', commandMode: 'auto', color: 'green', serverUrl, sessionId: null }
})

interface World {
  layouts: LayoutSnapshot[]
  sessions: Session[]
  records: Record<string, SessionRecord>
}
type Impl = (input: never) => unknown
/** `calls`: every client and shell call in order, `[name, first argument]`. */
interface Harness {
  calls: [string, unknown][]
  argsOf: (name: string) => unknown[]
  impl: Record<string, Impl>
  captured: TabClosedCapturePayload[]
  windows: Record<string, ToolWindow>
  requestView: ReturnType<typeof vi.fn>
  ctx: (over?: Partial<ServedContext>) => ServedContext
}

function setup(partial: Partial<World> = {}): Harness {
  const w: World = { layouts: [], sessions: [], records: {}, ...partial }
  const windows: Record<string, ToolWindow> = { wA: { id: 1 }, wB: { id: 2 } }
  const calls: [string, unknown][] = []
  const captured: TabClosedCapturePayload[] = []
  const snap = (key: string): LayoutSnapshot =>
    w.layouts.find((l) => l.windowKey === key) ?? layout(key, [])
  const get = (id: string): Session => {
    const s = w.sessions.find((x) => x.id === id)
    if (!s) throw Object.assign(new Error('nf'), { _tag: 'SessionNotFound', id })
    return s
  }
  let polls = 0
  const impl: Record<string, Impl> = {
    'sidebar.getLayout': (key: string) => snap(key),
    'sidebar.listLayouts': () => w.layouts,
    'sidebar.createGroup': (i: { group: Partial<SidebarGroup> }) => ({
      group: group('g-new', i.group)
    }),
    'sidebar.addTerminal': (i: { terminal: unknown }) => ({ terminal: i.terminal }),
    'sidebar.moveSessions': (i: { sessionIds: string[] }) => ({ moved: i.sessionIds, refused: [] }),
    'sessions.list': () => w.sessions,
    'sessions.get': get,
    'sessions.stop': (id: string) => void get(id),
    'sessions.start': () => ({ id: 'new-s' })
  }
  const recorder = (ns: string): unknown =>
    new Proxy(
      {},
      {
        get:
          (_t, method: string) =>
          async (...args: unknown[]): Promise<unknown> => {
            // One argument is recorded as itself, several as the list.
            calls.push([`${ns}.${method}`, args.length === 1 ? args[0] : args])
            return impl[`${ns}.${method}`]?.(...(args as [never]))
          }
      }
    )
  const api = { sidebar: recorder('sidebar'), sessions: recorder('sessions') } as ClaveApiClient
  const note = (name: string, arg?: unknown): void => void calls.push([name, arg])
  const shell: ServedShell = {
    keyOf: (win) => Object.keys(windows).find((k) => windows[k].id === win.id) ?? null,
    windowByKey: (key) => windows[key] ?? null,
    liveWindows: () => Object.values(windows),
    workspaceOfWindow: (id) => (id === 1 ? 'ws1' : 'ws2'),
    workspaces: () => [
      { id: 'ws1', name: 'One', rootDir: '/one' },
      { id: 'ws2', name: 'Two', rootDir: '/two' }
    ],
    resolveWorkspaceId: (ref) => ({ ws1: 'ws1', One: 'ws1', ws2: 'ws2', Two: 'ws2' })[ref] ?? null,
    record: (id) => w.records[id],
    servingSessionsOf: (owner) => (owner === 's1' ? ['srv'] : []),
    accountOf: () => null,
    statKind: async (p) => (p === '/ok/page.html' ? 'file' : null),
    startPty: (id, cols, rows) => note('startPty', [id, cols, rows]),
    awaitRehomed: async (ids) => note('awaitRehomed', ids),
    captureTabClosed: (payload) => void captured.push(payload),
    windowsListing: () => [{ id: 1 }],
    mintTerminalId: () => 'term-1',
    sleep: async () => {
      note('sleep')
      if (++polls === 2) w.sessions = w.sessions.map((s) => ({ ...s, state: 'ended' as const }))
    },
    // Wave 4's facts: nothing here reads them, the session tools' own test does.
    accounts: () => [],
    selectedAccountId: () => undefined,
    switchMode: () => 'propose',
    launchProfiles: () => [],
    pins: () => [],
    parentOf: () => null,
    setParent: (child, parent) => note('setParent', [child, parent]),
    captureMessage: (payload) => note('captureMessage', payload),
    captureTabSpawn: (payload) => note('captureTabSpawn', payload),
    publish: (event, windowKey) => note('publish', [event, windowKey]),
    notify: (title, body) => note('notify', [title, body])
  }
  const requestView = vi.fn(async () => ({ pinnedGroups: [{ id: 'p1' }], focusedSessionId: 'f1' }))
  return {
    calls,
    argsOf: (name) => calls.filter(([n]) => n === name).map(([, a]) => a),
    impl,
    captured,
    windows,
    requestView,
    ctx: (over = {}) => ({
      api,
      shell,
      win: windows.wA,
      callerSessionId: 'caller',
      requestView: requestView as ServedContext['requestView'],
      ...over
    })
  }
}

describe('serveCommand', () => {
  it('createGroup stamps the caller workspace and answers the renderer shape', async () => {
    const h = setup({ records: { caller: record('caller', { workspaceId: 'ws2' }) } })
    const out = await serveCommand('createGroup', { name: 'Build', prompt: 'go' }, h.ctx())
    expect(h.argsOf('sidebar.createGroup')).toEqual([
      { windowKey: 'wA', group: { name: 'Build', prompt: 'go', workspaceId: 'ws2' } }
    ])
    expect(out).toEqual({ groupId: 'g-new', name: 'Build', workspaceId: 'ws2', prompt: 'go' })
    await expect(serveCommand('createGroup', {}, h.ctx({ win: null }))).rejects.toThrow(
      'Clave window not available'
    )
    await expect(
      serveCommand('createGroup', { name: 'x', workspace: 'No' }, h.ctx())
    ).rejects.toThrow('No workspace "No". Available: One, Two')
  })

  it('rename finds a group in another window; a session rename is served too (wave 4)', async () => {
    const h = setup({ layouts: [layout('wA', []), layout('wB', [group('g2')])] })
    const out = await serveCommand('rename', { target: 'group', id: 'g2', name: 'N' }, h.ctx())
    expect(out).toEqual({ renamed: 'g2', name: 'N' })
    expect(h.argsOf('sidebar.renameGroup')).toEqual([{ windowKey: 'wB', groupId: 'g2', name: 'N' }])
    await expect(
      serveCommand('rename', { target: 'group', id: 'zz', name: 'N' }, h.ctx())
    ).rejects.toThrow('No group with id "zz"')
    const asSession = await serveCommand(
      'rename',
      { target: 'session', id: 's', name: 'N' },
      h.ctx()
    )
    expect(asSession).toEqual({ renamed: 's', name: 'N' })
    expect(h.argsOf('sessions.rename')).toEqual([['s', 'N']])
  })

  it('setGroupView checks the url and marks only the terminal serving it', async () => {
    const terminals = [terminal('t1', 'http://x'), terminal('t2', 'http://y')]
    const h = setup({ layouts: [layout('wA', [group('g', { terminals })])] })
    const view = (p: Record<string, unknown>): Promise<unknown> =>
      serveCommand('setGroupView', { groupId: 'g', ...p }, h.ctx())
    await expect(view({ url: '/a/b.txt' })).rejects.toThrow(
      'A file view must be an .html/.htm file (or pass an http(s) URL)'
    )
    await expect(view({ url: '/no/page.html' })).rejects.toThrow('No file at "/no/page.html"')
    await expect(view({ url: 'ftp://x' })).rejects.toThrow(
      'url must be an http(s) URL or an absolute .html file path'
    )
    await expect(view({ url: 'http://x', terminalId: 'no' })).rejects.toThrow(
      'Group has no terminal "no"'
    )
    expect(await view({ url: ' /ok/page.html ' })).toEqual({
      groupId: 'g',
      view: { url: '/ok/page.html', title: undefined, terminalId: null }
    })
    await view({ url: 'http://x', terminalId: 't2' })
    expect(h.argsOf('sidebar.updateTerminal')).toEqual([])
    await view({ url: 'http://x', terminalId: 't1', title: 'T' })
    expect(h.argsOf('sidebar.setGroupView').at(-1)).toEqual({
      windowKey: 'wA',
      groupId: 'g',
      view: { url: 'http://x', title: 'T', terminalId: 't1' }
    })
    expect(h.argsOf('sidebar.updateTerminal')).toEqual([
      { windowKey: 'wA', groupId: 'g', terminalId: 't1', patch: { groupView: true } }
    ])
    expect(await view({ url: null })).toEqual({ groupId: 'g', view: null })
  })

  describe('moveSession', () => {
    const world = (): Partial<World> => ({
      layouts: [
        layout('wA', [
          group('g1', { name: 'Build', workspaceId: 'ws1' }),
          group('g2', { workspaceId: 'ws2' })
        ]),
        layout('wB', [group('g3', { name: 'Far', workspaceId: 'ws2' })])
      ],
      sessions: [session('s1')],
      records: { s1: record('s1', { workspaceId: 'ws1' }) }
    })
    const move = (h: Harness, p: Record<string, unknown>, over = {}): Promise<unknown> =>
      serveCommand('moveSession', p, h.ctx(over))

    it('moves to root and into a group by name', async () => {
      const h = setup(world())
      const s1 = { sessionId: 's1' }
      expect(await move(h, { ...s1, groupId: 'root' })).toEqual({ ...s1, groupId: null })
      expect(await move(h, { ...s1, groupId: 'Build' })).toEqual({ ...s1, groupId: 'g1' })
      expect(h.argsOf('sidebar.moveItems')).toEqual([
        { windowKey: 'wA', itemIds: ['s1'], targetId: null, position: 'after' },
        { windowKey: 'wA', itemIds: ['s1'], targetId: 'g1', position: 'inside' }
      ])
      await expect(move(h, { sessionId: 'zz', groupId: 'root' })).rejects.toThrow(
        'No session with id "zz"'
      )
    })

    it('leaves a cross-workspace placement to the window', async () => {
      const h = setup(world())
      expect(await move(h, { sessionId: 's1', groupId: 'g2' })).toBe(NOT_SERVED)
      expect(h.argsOf('sidebar.moveItems')).toEqual([])
    })

    it('a cross-window move registers the rehome wait first, then places in the target', async () => {
      const h = setup(world())
      const out = await move(h, { sessionId: 's1', groupId: 'Far' }, { targetWindow: h.windows.wB })
      // Placed even across workspaces: after a move the placement finishes here.
      expect(out).toEqual({ sessionId: 's1', groupId: 'g3' })
      const names = h.calls.map(([n]) => n)
      expect(h.argsOf('awaitRehomed')).toEqual([['s1']])
      expect(names.indexOf('awaitRehomed')).toBeLessThan(names.indexOf('sidebar.moveSessions'))
      expect(h.argsOf('sidebar.moveSessions')).toEqual([
        { sessionIds: ['s1'], targetWindowKey: 'wB', focus: true }
      ])
      expect(h.argsOf('sidebar.moveItems')).toEqual([
        { windowKey: 'wB', itemIds: ['s1'], targetId: 'g3', position: 'inside' }
      ])
    })

    it('a refused cross-window move says why', async () => {
      const h = setup(world())
      h.impl['sidebar.moveSessions'] = () => ({
        moved: [],
        refused: [{ sessionId: 's1', reason: 'not-tmux' }]
      })
      await expect(
        move(h, { sessionId: 's1', groupId: 'root' }, { targetWindow: h.windows.wB })
      ).rejects.toThrow('This session is not tmux-backed and cannot move between windows')
    })
  })

  describe('addGroupTerminal', () => {
    const world = (): Partial<World> => ({
      layouts: [layout('wA', [group('g', { sessionIds: ['m'], workspaceId: 'ws1' })])],
      records: { m: record('m', { cwd: '/member' }) }
    })

    it('with launch false starts nothing', async () => {
      const h = setup(world())
      const p = { groupId: 'g', command: 'npm run dev', launch: false }
      const out = await serveCommand('addGroupTerminal', p, h.ctx())
      expect(out).toEqual({ terminalId: 'term-1', groupId: 'g', sessionId: null })
      expect(h.argsOf('sidebar.addTerminal')).toEqual([
        {
          windowKey: 'wA',
          groupId: 'g',
          terminal: {
            ...{ id: 'term-1', command: 'npm run dev', commandMode: 'auto', color: 'green' },
            ...{ icon: 'terminal', cwd: null, sessionId: null }
          }
        }
      ])
      expect(h.argsOf('sessions.start')).toEqual([])
      await expect(
        serveCommand('addGroupTerminal', { groupId: 'g', command: 'x', groupView: true }, h.ctx())
      ).rejects.toThrow('groupView requires a serverUrl — the group view shows that URL')
    })

    it('with launch starts a linked session, sizes it, then records it on the terminal', async () => {
      const h = setup(world())
      const p = { groupId: 'g', command: 'dev', serverUrl: 'http://l', groupView: true, cwd: '/o' }
      const out = await serveCommand('addGroupTerminal', p, h.ctx())
      expect(out).toEqual({ terminalId: 'term-1', groupId: 'g', sessionId: 'new-s' })
      expect(h.argsOf('sidebar.setGroupView')).toEqual([
        {
          windowKey: 'wA',
          groupId: 'g',
          view: { url: 'http://l', title: 'dev', terminalId: 'term-1' }
        }
      ])
      expect(h.argsOf('sessions.start')).toEqual([
        {
          cwd: '/o',
          windowKey: 'wA',
          options: {
            ...{ claudeMode: false, initialCommand: 'dev', autoExecute: true, workspaceId: 'ws1' },
            link: { kind: 'group-terminal', groupId: 'g', terminalId: 'term-1' }
          }
        }
      ])
      const names = h.calls.map(([n]) => n)
      expect(names.slice(-2)).toEqual(['startPty', 'sidebar.updateTerminal'])
      expect(h.argsOf('startPty')).toEqual([['new-s', 120, 30]])
      expect(h.argsOf('sidebar.updateTerminal')).toEqual([
        { windowKey: 'wA', groupId: 'g', terminalId: 'term-1', patch: { sessionId: 'new-s' } }
      ])
    })
  })

  describe('closeSession', () => {
    const world = (mode: Partial<SessionRecord>): Partial<World> => ({
      layouts: [layout('wB', [group('g', { name: 'G', sessionIds: ['s1'] })])],
      sessions: [session('s1', { windowKey: 'wB' }), session('caller'), session('srv')],
      records: {
        s1: record('s1', { ...mode, displayName: 'Worker', claudeSessionId: 'cs', model: 'opus' }),
        caller: record('caller', { claudeMode: true })
      }
    })

    it('captures an agent tab with its closer, stops, waits, stops the serving one, removes', async () => {
      const h = setup(world({ claudeMode: true }))
      expect(await serveCommand('closeSession', { sessionId: 's1' }, h.ctx())).toEqual({
        closed: 's1'
      })
      expect(h.captured).toHaveLength(1)
      expect(h.captured[0]).toMatchObject({ by: 'agent', closer: { sessionId: 'caller' } })
      expect(h.captured[0].session).toEqual({
        ...{ sessionId: 's1', name: 'Worker', mode: 'claude', cwd: '/work', claudeSessionId: 'cs' },
        ...{ groupId: 'g', groupName: 'G', model: 'opus' }
      })
      const names = h.calls.map(([n]) => n)
      expect(h.argsOf('sessions.stop')).toEqual(['s1', 'srv'])
      expect(names.filter((n) => n === 'sleep')).toHaveLength(2)
      expect(names.lastIndexOf('sleep')).toBeLessThan(names.lastIndexOf('sessions.stop'))
      expect(h.argsOf('sidebar.removeSession')).toEqual([{ windowKey: 'wB', sessionId: 's1' }])
    })

    it('does not capture a plain terminal', async () => {
      const h = setup(world({}))
      await serveCommand('closeSession', { sessionId: 's1' }, h.ctx())
      expect(h.captured).toEqual([])
    })

    it('"mine" needs a caller', async () => {
      const h = setup(world({}))
      await expect(
        serveCommand('closeSession', { sessionId: 'mine' }, h.ctx({ callerSessionId: undefined }))
      ).rejects.toThrow('sessionId "mine" needs a calling tab — this request has no tab identity')
    })
  })

  it('list merges every window and scopes "active" to the window workspace', async () => {
    const h = setup({
      layouts: [
        layout('wA', [group('gA', { sessionIds: ['caller'], workspaceId: 'ws1' })]),
        layout('wB', [group('gB', { workspaceId: 'ws2' })])
      ],
      sessions: [session('caller'), session('s2', { windowKey: 'wB', state: 'ended' })],
      records: {
        caller: record('caller', { workspaceId: 'ws1' }),
        s2: record('s2', { workspaceId: 'ws2', codexMode: true })
      }
    })
    type Listing = Record<string, { id: string; windowId: number }[]>
    const all = (await serveCommand('list', {}, h.ctx())) as Listing
    expect(all.sessions.map((s) => [s.id, s.windowId])).toEqual([
      ['caller', 1],
      ['s2', 2]
    ])
    expect(all.sessions[1]).toMatchObject({
      ...{ mode: 'codex', alive: false, agentState: null, groupId: null },
      ...{ workspaceId: 'ws2', workspaceName: 'Two', account: null, view: null }
    })
    expect(all.groups.map((g) => [g.id, g.windowId])).toEqual([
      ['gA', 1],
      ['gB', 2]
    ])
    expect(all).toMatchObject({
      ...{ activeWorkspaceId: 'ws1', callerGroupId: 'gA', callerWindowId: 1 },
      ...{ pinnedGroups: [{ id: 'p1' }], focusedSessionId: 'f1', windows: [{ id: 1 }] }
    })
    expect(all.workspaces).toContainEqual({ id: 'ws1', name: 'One', rootDir: '/one', active: true })
    const active = (await serveCommand('list', { workspace: 'active' }, h.ctx())) as Listing
    expect(active.sessions.map((s) => s.id)).toEqual(['caller'])
    expect(active.groups.map((g) => g.id)).toEqual(['gA'])
    expect(h.requestView).toHaveBeenLastCalledWith('wA', 'windowState', {
      workspace: 'ws1',
      callerSessionId: 'caller'
    })
  })
})

describe('resolveGroupRef', () => {
  const opts = {
    callerSessionId: 'c' as string | undefined,
    callerWorkspaceId: undefined as string | undefined,
    windowWorkspaceId: undefined as string | undefined,
    workspaceNameOf: (id: string | null | undefined): string | null =>
      id === 'ws1' ? 'One' : id === 'ws2' ? 'Two' : null
  }
  const layouts = [
    layout('wA', [
      group('a1', { name: 'Dup', workspaceId: 'ws1' }),
      group('a2', { name: 'Dup', workspaceId: 'ws2' })
    ]),
    layout('wB', [group('b1', { name: 'Only', sessionIds: ['c'] }), group('b2', { name: 'Dup' })])
  ]

  it('prefers the caller workspace, then the window workspace, else refuses with candidates', () => {
    const resolve = (o: Partial<typeof opts>): string =>
      resolveGroupRef(layouts, 'wA', 'Dup', { ...opts, ...o }).group.id
    expect(resolve({ callerWorkspaceId: 'ws2', windowWorkspaceId: 'ws1' })).toBe('a2')
    expect(resolve({ windowWorkspaceId: 'ws1' })).toBe('a1')
    expect(() => resolve({})).toThrow(
      'Group name "Dup" is ambiguous across workspaces — use an id. Candidates: One/Dup (a1), Two/Dup (a2)'
    )
  })

  it('resolves mine, ids and names held in other windows', () => {
    expect(resolveGroupRef(layouts, 'wA', 'mine', opts)).toMatchObject({
      windowKey: 'wB',
      group: { id: 'b1' }
    })
    expect(resolveGroupRef(layouts, 'wA', 'Only', opts).windowKey).toBe('wB')
    expect(resolveGroupRef(layouts, 'wB', 'Dup', opts).group.id).toBe('b2')
    expect(() =>
      resolveGroupRef(layouts, 'wA', 'mine', { ...opts, callerSessionId: undefined })
    ).toThrow('groupId "mine" requires the call to come from inside a Clave session')
    expect(() => resolveGroupRef(layouts, 'wA', 'nope', opts)).toThrow(
      'No group with id or name "nope"'
    )
  })
  // ── Round 1 of the verifier: the gaps it found, pinned ──

  it('records the server road only for a command it served, never for one it left to the window', async () => {
    vi.mocked(noteRoad).mockClear()
    const h = setup({
      layouts: [layout('wA', [group('gA', { workspaceId: 'ws2' })])],
      sessions: [session('s1')],
      records: { s1: record('s1', { workspaceId: 'ws1' }) }
    })
    // A cross-workspace placement is the window's: NOT_SERVED, no road recorded.
    expect(await serveCommand('moveSession', { sessionId: 's1', groupId: 'gA' }, h.ctx())).toBe(
      NOT_SERVED
    )
    expect(noteRoad).not.toHaveBeenCalled()
    await serveCommand('createGroup', { name: 'x' }, h.ctx())
    expect(noteRoad).toHaveBeenCalledWith('createGroup', 'server')
    expect(noteRoad).toHaveBeenCalledTimes(1)
  })

  it('lists an item with no workspace under a scoped listing, as the window did', async () => {
    const h = setup({
      layouts: [layout('wA', [group('gNo'), group('gTwo', { workspaceId: 'ws2' })])],
      sessions: [session('sNo'), session('sTwo')],
      records: { sNo: record('sNo'), sTwo: record('sTwo', { workspaceId: 'ws2' }) }
    })
    type Listing = Record<string, { id: string }[]>
    const active = (await serveCommand('list', { workspace: 'active' }, h.ctx())) as Listing
    expect(active.sessions.map((s) => s.id)).toEqual(['sNo'])
    expect(active.groups.map((g) => g.id)).toEqual(['gNo'])
  })

  it('lists the groups of live windows only', async () => {
    const h = setup({
      layouts: [layout('wA', [group('gA')]), layout('wGone', [group('gOrphan')])]
    })
    type Listing = Record<string, { id: string }[]>
    const all = (await serveCommand('list', {}, h.ctx())) as Listing
    expect(all.groups.map((g) => g.id)).toEqual(['gA'])
  })

  it('a move whose window argument names the routed window itself stays in that window', async () => {
    const h = setup({
      layouts: [layout('wA', [group('gA', { workspaceId: 'ws1' })])],
      sessions: [session('s1')],
      records: { s1: record('s1', { workspaceId: 'ws1' }) }
    })
    const out = await serveCommand(
      'moveSession',
      { sessionId: 's1', groupId: 'gA', window: 1 },
      h.ctx({ targetWindow: h.windows.wA })
    )
    expect(out).toEqual({ sessionId: 's1', groupId: 'gA' })
    expect(h.argsOf('sidebar.moveSessions')).toEqual([])
    expect(h.argsOf('awaitRehomed')).toEqual([])
  })

  it('a move takes an id and nothing else, as the window does: "mine" is no session', async () => {
    const h = setup({ sessions: [session('caller')] })
    await expect(
      serveCommand('moveSession', { sessionId: 'mine', groupId: 'root' }, h.ctx())
    ).rejects.toThrow('No session with id "mine"')
  })
})

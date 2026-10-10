import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaveApiClient } from '@clave/client'
import type { LayoutSnapshot, SidebarGroup } from '@clave/contract/sidebar'
import type { Session } from '@clave/contract/sessions'
import type { SessionRecord } from '../sessions/adapters/pty-backend'
import type { PinnedBlueprint } from '../../shared/pinned-blueprint'
import {
  NOT_SERVED,
  type ServedContext,
  type ServedPoolAccount,
  type ServedShell,
  type ToolWindow
} from './served-core'
import { serveCommand } from './served-tools'
import { resetServedLaunchesForTests } from './served-session-tools'

vi.mock('./roads', () => ({ noteRoad: vi.fn() }))

/**
 * The last seven served tools on fakes (wave 4, PRDCT-3377): what each one
 * asks of the server, what it answers, what it refuses, and when it hands
 * the call back to the window. The texts are the renderer's handlers'.
 */
const group = (id: string, extra: Partial<SidebarGroup> = {}): SidebarGroup => ({
  ...{ id, name: id, sessionIds: [], collapsed: false, cwd: null, terminals: [] },
  ...extra
})
const layout = (windowKey: string, groups: SidebarGroup[]): LayoutSnapshot => ({
  ...{ windowKey, revision: 0, groups, displayOrder: groups.map((g) => g.id) }
})
const session = (id: string, extra: Partial<Session> = {}): Session => ({
  ...{ id, provider: 'claude', transport: 'pty', cwd: '/work', windowKey: 'wA', state: 'idle' },
  ...{ createdAt: 0, adapterId: 'pty', title: `title-${id}` },
  ...extra
})
const CLAUDE = { claudeMode: true, antigravityMode: false, codexMode: false, piMode: false }
const record = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  ...{ id, cwd: '/work', folderName: 'work', ...CLAUDE, claudeAgentsMode: false },
  ...{ dangerousMode: false, displayName: `name-${id}` },
  ...extra
})

interface World {
  layouts: LayoutSnapshot[]
  sessions: Session[]
  records: Record<string, SessionRecord>
  accounts: Record<'claude' | 'codex', ServedPoolAccount[]>
  selected: Record<'claude' | 'codex', string | undefined>
  switchMode: 'propose' | 'automatic'
  pins: PinnedBlueprint[]
  /** The windows that are live, by key. */
  windows: string[]
  parents: Record<string, string>
  screen: string[] | null
}

function setup(partial: Partial<World> = {}) {
  const w: World = {
    layouts: [layout('wA', [])],
    sessions: [],
    records: {},
    accounts: {
      claude: [
        { id: 'default', label: 'Default', usable: true },
        { id: 'acc-2', label: 'Second', usable: true }
      ],
      codex: [{ id: 'default', label: 'Default', usable: true }]
    },
    selected: { claude: undefined, codex: undefined },
    switchMode: 'propose',
    pins: [],
    windows: ['wA', 'wB'],
    parents: {},
    screen: ['$ ls', 'a  b'],
    ...partial
  }
  const calls: [string, unknown][] = []
  const note = (name: string, arg?: unknown): void => void calls.push([name, arg])
  const notFound = (id: string): never => {
    throw Object.assign(new Error('nf'), { _tag: 'SessionNotFound', id })
  }
  const get = (id: string): Session => w.sessions.find((x) => x.id === id) ?? notFound(id)
  let started = 0
  const impl: Record<string, (...args: never[]) => unknown> = {
    'sidebar.getLayout': (key: string) =>
      w.layouts.find((l) => l.windowKey === key) ?? layout(key, []),
    'sidebar.listLayouts': () => w.layouts,
    'sidebar.placeSession': () => undefined,
    'sidebar.createGroup': (i: { group: Partial<SidebarGroup> }) => ({
      group: group('g-new', i.group as Partial<SidebarGroup>)
    }),
    'sessions.get': get,
    'sessions.list': () => w.sessions,
    'sessions.rename': (id: string) => get(id),
    'sessions.setPage': (id: string) => void get(id),
    'sessions.stop': () => undefined,
    'sessions.resize': () => undefined,
    'sessions.screen': (id: string) => {
      get(id)
      if (!w.screen) throw Object.assign(new Error('x'), { _tag: 'SessionScreenUnavailable', id })
      return { lines: w.screen, cols: 80, rows: 24 }
    },
    'sessions.type': (id: string) => {
      get(id)
      return { submitted: true, draftHandling: 'none' }
    },
    'sessions.restart': (id: string) => {
      get(id)
      return { id, resumed: true }
    },
    'sessions.start': (i: { cwd: string; windowKey?: string }) => {
      const id = `new-${++started}`
      w.sessions.push(session(id, { cwd: i.cwd, windowKey: i.windowKey ?? '' }))
      w.records[id] = record(id, { cwd: i.cwd, folderName: 'folder' })
      return { id, cwd: i.cwd, folderName: 'folder', alive: true }
    }
  }
  const recorder = (ns: string): unknown =>
    new Proxy(
      {},
      {
        get:
          (_t, method: string) =>
          async (...args: unknown[]): Promise<unknown> => {
            calls.push([`${ns}.${method}`, args.length === 1 ? args[0] : args])
            return impl[`${ns}.${method}`]?.(...(args as never[]))
          }
      }
    )
  const api = { sidebar: recorder('sidebar'), sessions: recorder('sessions') } as ClaveApiClient
  const windowOf: Record<string, ToolWindow> = { wA: { id: 1 }, wB: { id: 2 } }
  const shell: ServedShell = {
    keyOf: (win) => Object.keys(windowOf).find((k) => windowOf[k].id === win.id) ?? null,
    windowByKey: (key) => (w.windows.includes(key) ? (windowOf[key] ?? null) : null),
    liveWindows: () => w.windows.map((k) => windowOf[k]),
    workspaceOfWindow: (id) => (id === 1 ? 'ws1' : 'ws2'),
    workspaces: () => [
      { id: 'ws1', name: 'One', rootDir: '/one' },
      { id: 'ws2', name: 'Two', rootDir: '/two' }
    ],
    resolveWorkspaceId: (ref) => ({ ws1: 'ws1', One: 'ws1', ws2: 'ws2', Two: 'ws2' })[ref] ?? null,
    record: (id) => w.records[id],
    servingSessionsOf: (owner) =>
      Object.values(w.records)
        .filter((r) => r.link?.kind === 'session-view' && r.link.ownerId === owner)
        .map((r) => r.id),
    accountOf: () => null,
    statKind: async (p) => (p === '/ok/page.html' ? 'file' : null),
    startPty: (id, cols, rows) => note('startPty', [id, cols, rows]),
    awaitRehomed: async () => undefined,
    captureTabClosed: () => undefined,
    windowsListing: () => [],
    mintTerminalId: () => 'term-1',
    sleep: async () => undefined,
    accounts: (provider) => w.accounts[provider],
    selectedAccountId: (provider) => w.selected[provider],
    switchMode: () => w.switchMode,
    launchProfiles: (family) =>
      family === 'claude' ? [{ id: 'claude-chat', name: 'Claude chat' }] : [],
    pins: () => w.pins,
    parentOf: (id) => w.parents[id] ?? null,
    setParent: (child, parent) => {
      w.parents[child] = parent
      note('setParent', [child, parent])
    },
    captureMessage: (payload) => note('captureMessage', payload),
    captureTabSpawn: (payload) => note('captureTabSpawn', payload),
    publish: (event) => note('publish', event),
    notify: (title, body) => note('notify', [title, body])
  }
  const requestView = vi.fn(async (): Promise<unknown> => ({}))
  return {
    w,
    calls,
    impl,
    requestView,
    argsOf: (name: string) => calls.filter(([n]) => n === name).map(([, a]) => a),
    names: () => calls.map(([n]) => n),
    ctx: (over: Partial<ServedContext> = {}): ServedContext => ({
      api,
      shell,
      win: windowOf.wA,
      callerSessionId: 'caller',
      requestView: requestView as unknown as ServedContext['requestView'],
      ...over
    })
  }
}
type Harness = ReturnType<typeof setup>
const run = (
  h: Harness,
  command: string,
  p: Record<string, unknown>,
  over = {}
): Promise<unknown> => serveCommand(command, p, h.ctx(over))

afterEach(() => resetServedLaunchesForTests())

describe('rename of a tab', () => {
  it('renames through the server and answers the renderer shape', async () => {
    const h = setup({ sessions: [session('s1')] })
    expect(await run(h, 'rename', { target: 'session', id: 's1', name: 'Lane D' })).toEqual({
      renamed: 's1',
      name: 'Lane D'
    })
    expect(h.argsOf('sessions.rename')).toEqual([['s1', 'Lane D']])
    await expect(run(h, 'rename', { target: 'session', id: 'zz', name: 'x' })).rejects.toThrow(
      'No session with id "zz"'
    )
  })
})

describe('the page on a tab', () => {
  const world = (): Partial<World> => ({
    sessions: [session('s1'), session('old-srv')],
    records: {
      s1: record('s1', { workspaceId: 'ws1' }),
      'old-srv': record('old-srv', { link: { kind: 'session-view', ownerId: 's1' } })
    }
  })
  it('checks the url and the command as the window did', async () => {
    const h = setup(world())
    const view = (p: Record<string, unknown>): Promise<unknown> =>
      run(h, 'setSessionView', { sessionId: 's1', ...p })
    await expect(view({ url: '/a/b.txt' })).rejects.toThrow(
      'A file view must be an .html/.htm file (or pass an http(s) URL)'
    )
    await expect(view({ url: '/no/page.html' })).rejects.toThrow('No file at "/no/page.html"')
    await expect(view({ url: '/ok/page.html', command: 'serve' })).rejects.toThrow(
      'A file view has no server — command only applies to http(s) URLs'
    )
    await expect(view({ url: 'ftp://x' })).rejects.toThrow(
      'url must be an http(s) URL or an absolute .html file path'
    )
    await expect(
      run(h, 'setSessionView', { sessionId: 'mine', url: null }, { callerSessionId: undefined })
    ).rejects.toThrow('sessionId "mine" needs a caller session — pass an explicit id')
    await expect(run(h, 'setSessionView', { sessionId: 'zz', url: null })).rejects.toThrow(
      'No session with id "zz"'
    )
    expect(h.argsOf('sessions.setPage')).toEqual([])
  })
  it('starts the serving session hidden and linked, sizes it, replaces the old one, and sets the page', async () => {
    const h = setup(world())
    const out = await run(h, 'setSessionView', {
      sessionId: 's1',
      url: ' http://127.0.0.1:4814 ',
      title: 'Lane D',
      command: 'exos workstream open',
      cwd: '/os'
    })
    expect(out).toEqual({
      sessionId: 's1',
      view: { url: 'http://127.0.0.1:4814', title: 'Lane D' }
    })
    expect(h.argsOf('sessions.stop')).toEqual(['old-srv'])
    expect(h.argsOf('sessions.start')).toEqual([
      {
        cwd: '/os',
        windowKey: 'wA',
        options: {
          claudeMode: false,
          initialCommand: 'exos workstream open',
          autoExecute: true,
          workspaceId: 'ws1',
          link: { kind: 'session-view', ownerId: 's1' }
        }
      }
    ])
    expect(h.argsOf('sessions.resize')).toEqual([['new-1', 120, 30]])
    expect(h.argsOf('sessions.setPage')).toEqual([
      [
        's1',
        {
          url: 'http://127.0.0.1:4814',
          title: 'Lane D',
          command: 'exos workstream open',
          cwd: '/os'
        },
        'new-1'
      ]
    ])
    const names = h.names()
    expect(names.indexOf('sessions.stop')).toBeLessThan(names.indexOf('sessions.start'))
  })
  it('a file page needs no serving session; a detach stops the serving one and clears the page', async () => {
    const h = setup(world())
    expect(await run(h, 'setSessionView', { sessionId: 's1', url: '/ok/page.html' })).toEqual({
      sessionId: 's1',
      view: { url: '/ok/page.html', title: undefined }
    })
    expect(h.argsOf('sessions.start')).toEqual([])
    expect(h.argsOf('sessions.setPage').at(-1)).toEqual(['s1', { url: '/ok/page.html' }, null])
    expect(
      await run(h, 'setSessionView', { sessionId: 'mine', url: null }, { callerSessionId: 's1' })
    ).toEqual({
      sessionId: 's1',
      view: null
    })
    expect(h.argsOf('sessions.stop')).toEqual(['old-srv', 'old-srv'])
    expect(h.argsOf('sessions.setPage').at(-1)).toEqual(['s1', null, null])
  })
})

describe('who may reach whom', () => {
  const world = (): Partial<World> => ({
    layouts: [layout('wA', [group('g', { sessionIds: ['caller', 'mate'] })])],
    sessions: [
      session('caller'),
      session('mate'),
      session('child'),
      session('parent'),
      session('stranger')
    ],
    records: {
      caller: record('caller'),
      mate: record('mate'),
      child: record('child'),
      parent: record('parent'),
      stranger: record('stranger', { displayName: 'Far away' })
    },
    parents: { child: 'caller', caller: 'parent' }
  })
  it('reads a tab it opened, the tab that opened it, and a group mate; refuses a stranger', async () => {
    const h = setup(world())
    for (const target of ['child', 'parent', 'mate', 'caller']) {
      const out = (await run(h, 'readSession', { sessionId: target })) as { sessionId: string }
      expect(out.sessionId).toBe(target)
    }
    await expect(run(h, 'readSession', { sessionId: 'stranger' })).rejects.toThrow(
      'Refusing to read tab "Far away": it is not related to yours. You can only reach the tab that opened yours ("parent"), tabs you opened, or tabs in the same group. Put both tabs in one group to allow this.'
    )
    await expect(
      run(h, 'readSession', { sessionId: 'child' }, { callerSessionId: undefined })
    ).rejects.toThrow(
      'clave_read_session must be called from inside a Clave agent tab — this request has no tab identity.'
    )
  })
  it('resolves "parent" from the lineage and a name from the records, the routed window first', async () => {
    const h = setup(world())
    h.w.sessions.push(session('far-twin', { windowKey: 'wB' }))
    h.w.records['far-twin'] = record('far-twin', { displayName: 'name-mate' })
    expect((await run(h, 'readSession', { sessionId: 'parent' })) as object).toMatchObject({
      sessionId: 'parent'
    })
    expect((await run(h, 'readSession', { sessionId: 'name-mate' })) as object).toMatchObject({
      sessionId: 'mate'
    })
    await expect(run(h, 'readSession', { sessionId: 'nobody' })).rejects.toThrow(
      'No session with id or name "nobody"'
    )
    h.w.parents = {}
    await expect(run(h, 'readSession', { sessionId: 'parent' })).rejects.toThrow(
      'This session has no live parent'
    )
  })
  it('answers the screen as the window did, and says when a tab has none', async () => {
    const h = setup(world())
    expect(await run(h, 'readSession', { sessionId: 'child', lines: 7 })).toEqual({
      sessionId: 'child',
      name: 'name-child',
      mode: 'claude',
      alive: true,
      agentState: 'idle',
      lines: 2,
      text: '$ ls\na  b'
    })
    expect(h.argsOf('sessions.screen').at(-1)).toEqual(['child', 7])
    await run(h, 'readSession', { sessionId: 'child', lines: 900 })
    expect(h.argsOf('sessions.screen').at(-1)).toEqual(['child', 500])
    h.w.screen = null
    await expect(run(h, 'readSession', { sessionId: 'child' })).rejects.toThrow(
      'Session "name-child" has no terminal buffer (tab not mounted yet)'
    )
  })
})

describe('a message typed into a tab', () => {
  const world = (): Partial<World> => ({
    layouts: [layout('wA', [group('g', { sessionIds: ['caller', 'mate'] })])],
    sessions: [session('caller'), session('mate'), session('term'), session('menu')],
    records: {
      caller: record('caller', { displayName: 'Lane D' }),
      mate: record('mate', { displayName: 'Mate' }),
      term: record('term', { claudeMode: false }),
      menu: record('menu', { claudeMode: false, claudeAgentsMode: true })
    },
    parents: { term: 'caller', menu: 'caller' }
  })
  it('types the message under its provenance header, filtered apart, and records it', async () => {
    const h = setup(world())
    const out = await run(h, 'sendToSession', { sessionId: 'mate', message: 'go\x1b[201~on\nnow' })
    expect(h.argsOf('sessions.type')).toEqual([
      [
        'mate',
        '[Message from Clave tab "Lane D" — reply with clave_send_to_session sessionId="caller"]\ngo[201~on\nnow',
        'Lane D'
      ]
    ])
    expect(out).toEqual({
      delivered: true,
      sessionId: 'mate',
      name: 'Mate',
      mode: 'claude',
      agentState: 'idle',
      draftHandling: 'none'
    })
    expect(h.argsOf('captureMessage')).toEqual([
      expect.objectContaining({
        text: 'go[201~on\nnow',
        provenance:
          '[Message from Clave tab "Lane D" — reply with clave_send_to_session sessionId="caller"]',
        delivered: true,
        sender: expect.objectContaining({ sessionId: 'caller', name: 'Lane D' }),
        target: expect.objectContaining({ sessionId: 'mate', name: 'Mate', groupId: 'g' })
      })
    ])
  })
  it('refuses a plain terminal, a menu tab, an ended tab and a stranger, typing nothing', async () => {
    const h = setup(world())
    await expect(run(h, 'sendToSession', { sessionId: 'term', message: 'x' })).rejects.toThrow(
      'Refusing to send to a plain terminal'
    )
    await expect(run(h, 'sendToSession', { sessionId: 'menu', message: 'x' })).rejects.toThrow(
      'Refusing to send to a `claude agents` tab'
    )
    h.w.sessions.push(session('gone', { state: 'ended' }))
    h.w.records.gone = record('gone', { displayName: 'Gone' })
    h.w.parents.gone = 'caller'
    await expect(run(h, 'sendToSession', { sessionId: 'gone', message: 'x' })).rejects.toThrow(
      'Session "Gone" has ended'
    )
    h.w.sessions.push(session('stranger'))
    h.w.records.stranger = record('stranger')
    await expect(run(h, 'sendToSession', { sessionId: 'stranger', message: 'x' })).rejects.toThrow(
      'Refusing to message tab "name-stranger"'
    )
    expect(h.argsOf('sessions.type')).toEqual([])
    expect(h.argsOf('captureMessage')).toEqual([])
  })
  it('a self-addressed send is a checkpoint: logged, typed nowhere', async () => {
    const h = setup(world())
    for (const ref of ['mine', 'caller', 'Lane D']) {
      const out = await run(h, 'sendToSession', { sessionId: ref, message: 'STATUS · ok' })
      expect(out).toEqual({
        checkpoint: true,
        logged: true,
        delivered: false,
        sessionId: 'caller',
        name: 'Lane D',
        note: 'Checkpoint logged to the transport record; nothing was typed into any tab.'
      })
    }
    expect(h.argsOf('sessions.type')).toEqual([])
    expect(h.argsOf('captureMessage')).toHaveLength(3)
    expect(h.argsOf('captureMessage')[0]).toMatchObject({
      text: 'STATUS · ok',
      provenance: '[Checkpoint by Clave tab "Lane D" — logged, not delivered]',
      delivered: false
    })
  })
  it('says not delivered when the tab ended under the message', async () => {
    const h = setup(world())
    h.impl['sessions.type'] = () => {
      h.w.sessions = h.w.sessions.map((s) => (s.id === 'mate' ? { ...s, state: 'ended' } : s))
      return { submitted: false, draftHandling: 'none' }
    }
    const out = (await run(h, 'sendToSession', { sessionId: 'mate', message: 'x' })) as {
      delivered: boolean
    }
    expect(out.delivered).toBe(false)
    expect(h.argsOf('captureMessage')).toEqual([])
  })
})

describe('an account switch', () => {
  const world = (): Partial<World> => ({
    sessions: [session('s1'), session('t1'), session('far', { windowKey: 'gone' })],
    records: {
      s1: record('s1', { claudeProfileId: 'default', workspaceId: 'ws1' }),
      t1: record('t1', { claudeMode: false }),
      far: record('far', { claudeProfileId: 'default' })
    },
    windows: ['wA']
  })
  it('refuses what is not an account tab, an unknown account, and a pool with no headroom', async () => {
    const h = setup(world())
    await expect(run(h, 'switchAccount', { sessionId: 't1', account: 'any' })).rejects.toThrow(
      'Only Claude and Codex tabs run on an account'
    )
    await expect(run(h, 'switchAccount', { sessionId: 'zz', account: 'any' })).rejects.toThrow(
      'Unknown session "zz"'
    )
    await expect(run(h, 'switchAccount', { sessionId: 's1', account: 'Third' })).rejects.toThrow(
      'Unknown Claude account "Third". Available: "Default" (default), "Second" (acc-2)'
    )
    h.w.accounts.claude[1] = { ...h.w.accounts.claude[1], usable: false }
    await expect(run(h, 'switchAccount', { sessionId: 's1', account: 'any' })).rejects.toThrow(
      'No other account of this provider has headroom'
    )
    expect(h.argsOf('sessions.restart')).toEqual([])
  })
  it('asks the live window for the tab’s pin and mode: pinned refuses, propose keeps the window', async () => {
    const h = setup(world())
    h.requestView.mockResolvedValueOnce({ pinned: true, mode: null })
    await expect(run(h, 'switchAccount', { sessionId: 's1', account: 'Second' })).rejects.toThrow(
      'This tab is pinned to its account; the user can unpin it from the tab menu'
    )
    expect(h.requestView).toHaveBeenCalledWith(
      'wA',
      'sessionSwitchState',
      { sessionId: 's1' },
      2000
    )
    h.requestView.mockResolvedValueOnce({ pinned: false, mode: 'propose' })
    expect(await run(h, 'switchAccount', { sessionId: 's1', account: 'Second' })).toBe(NOT_SERVED)
    // The preference says propose: the window's too.
    h.requestView.mockResolvedValueOnce({ pinned: false, mode: null })
    expect(await run(h, 'switchAccount', { sessionId: 's1', account: 'Second' })).toBe(NOT_SERVED)
    // A window that does not answer keeps the whole call.
    h.requestView.mockRejectedValueOnce(new Error('timeout'))
    expect(await run(h, 'switchAccount', { sessionId: 's1', account: 'Second' })).toBe(NOT_SERVED)
    expect(h.argsOf('sessions.restart')).toEqual([])
  })
  it('restarts the tab on the named account in automatic mode, the tab’s own or the preference’s', async () => {
    const h = setup(world())
    h.requestView.mockResolvedValueOnce({ pinned: false, mode: 'automatic' })
    expect(
      await run(
        h,
        'switchAccount',
        { sessionId: 'mine', account: 'second' },
        { callerSessionId: 's1' }
      )
    ).toEqual({
      sessionId: 's1',
      account: { id: 'acc-2', label: 'Second' },
      resumed: true,
      switched: true,
      proposed: false
    })
    expect(h.argsOf('sessions.restart')).toEqual([
      ['s1', { claudeProfileId: 'acc-2', claudeProfileLabel: 'Second' }]
    ])
    // No live window for the tab: the preference decides, and "any" is the pool's pick.
    h.w.switchMode = 'automatic'
    expect(await run(h, 'switchAccount', { sessionId: 'far', account: 'any' })).toMatchObject({
      account: { id: 'acc-2' },
      switched: true
    })
    expect(h.requestView).toHaveBeenCalledTimes(1)
    // The same account is no move.
    expect(await run(h, 'switchAccount', { sessionId: 'far', account: 'default' })).toMatchObject({
      resumed: true,
      switched: true
    })
    expect(h.argsOf('sessions.restart')).toHaveLength(2)
  })
  it('a restart the host refused is the error the window showed', async () => {
    const h = setup({ ...world(), switchMode: 'automatic', windows: [] })
    h.impl['sessions.restart'] = () => {
      throw Object.assign(new Error('This session cannot be restarted from here.'), {
        _tag: 'SessionStartFailed'
      })
    }
    await expect(run(h, 'switchAccount', { sessionId: 's1', account: 'Second' })).rejects.toThrow(
      'This session cannot be restarted from here.'
    )
  })
})

describe('opening a session', () => {
  const world = (): Partial<World> => ({
    layouts: [
      layout('wA', [group('g1', { name: 'Build', workspaceId: 'ws1', sessionIds: ['caller'] })]),
      layout('wB', [group('g2', { name: 'Far', workspaceId: 'ws2' })])
    ],
    sessions: [session('caller')],
    records: { caller: record('caller', { workspaceId: 'ws1', displayName: 'Lane D' }) },
    selected: { claude: 'acc-2', codex: undefined }
  })
  it('starts on the pool’s account with the caller’s workspace, names it, places it, links it, records it', async () => {
    const h = setup(world())
    const out = await run(h, 'openSession', {
      cwd: '/proj',
      name: 'Worker',
      prompt: 'do it',
      dangerous: true,
      model: 'opus',
      chat: true
    })
    expect(out).toEqual({ sessionId: 'new-1', groupId: null })
    expect(h.argsOf('sessions.start')).toEqual([
      {
        cwd: '/proj',
        windowKey: 'wA',
        options: {
          claudeMode: true,
          antigravityMode: false,
          codexMode: false,
          piMode: false,
          dangerousMode: true,
          model: 'opus',
          launchProfileId: 'claude-chat',
          claudeProfileId: 'acc-2',
          claudeProfileLabel: 'Second',
          autoExecute: false,
          initialPrompt: 'do it',
          workspaceId: 'ws1'
        }
      }
    ])
    expect(h.argsOf('sessions.rename')).toEqual([['new-1', 'Worker']])
    expect(h.argsOf('sidebar.placeSession')).toEqual([
      { windowKey: 'wA', sessionId: 'new-1', groupId: null }
    ])
    expect(h.argsOf('setParent')).toEqual([['new-1', 'caller']])
    expect(h.argsOf('captureTabSpawn')).toEqual([
      expect.objectContaining({
        prompt: 'do it',
        model: 'opus',
        spawner: expect.objectContaining({ sessionId: 'caller', name: 'Lane D' }),
        session: expect.objectContaining({ sessionId: 'new-1' })
      })
    ])
    // A window is live: the pane starts the process at its real size.
    expect(h.argsOf('sessions.resize')).toEqual([])
  })
  it('a group in another window: the tab opens there, in that group’s workspace', async () => {
    const h = setup(world())
    expect(
      await run(h, 'openSession', { cwd: '/p', mode: 'terminal', groupId: 'Far', command: 'ls' })
    ).toEqual({
      sessionId: 'new-1',
      groupId: 'g2'
    })
    expect(h.argsOf('sessions.start')[0]).toMatchObject({
      windowKey: 'wB',
      options: { claudeMode: false, initialCommand: 'ls', autoExecute: true, workspaceId: 'ws2' }
    })
    expect(h.argsOf('sidebar.placeSession')).toEqual([
      { windowKey: 'wB', sessionId: 'new-1', groupId: 'g2' }
    ])
    // A terminal is not a delegation.
    expect(h.argsOf('captureTabSpawn')).toEqual([])
  })
  it('refuses what the window refused: an unknown profile, an account on a terminal, an unknown group', async () => {
    const h = setup(world())
    await expect(run(h, 'openSession', { cwd: '/p', profile: 'nope' })).rejects.toThrow(
      'Unknown claude launch profile "nope"'
    )
    await expect(
      run(h, 'openSession', { cwd: '/p', mode: 'terminal', account: 'x' })
    ).rejects.toThrow(
      'The account argument applies to claude and codex modes only (got mode "terminal")'
    )
    await expect(run(h, 'openSession', { cwd: '/p', groupId: 'zz' })).rejects.toThrow(
      'No group with id or name "zz"'
    )
    await expect(run(h, 'openSession', { cwd: '/p', account: 'Third' })).rejects.toThrow(
      'Unknown Claude account "Third"'
    )
    expect(h.argsOf('sessions.start')).toEqual([])
  })
  it('with no window to mount a pane, kicks the process at a plain size', async () => {
    const h = setup({ ...world(), windows: [] })
    await run(h, 'openSession', { cwd: '/p', mode: 'terminal' })
    expect(h.argsOf('sessions.resize')).toEqual([['new-1', 120, 30]])
  })
  it('a start the host refused is the error with the host’s words', async () => {
    const h = setup(world())
    h.impl['sessions.start'] = () => {
      throw Object.assign(new Error('no such directory'), { _tag: 'SessionStartFailed' })
    }
    await expect(run(h, 'openSession', { cwd: '/p' })).rejects.toThrow('no such directory')
    expect(h.argsOf('sidebar.placeSession')).toEqual([])
  })
})

describe('launching a pinned group', () => {
  const pin = (id: string, extra: Partial<PinnedBlueprint> = {}): PinnedBlueprint => ({
    id,
    name: id,
    cwd: '/root/proj',
    workspaceId: 'ws1',
    workspaceRoot: '/root',
    sessions: [
      {
        cwd: '/root/proj',
        name: 'Agent',
        claudeMode: true,
        antigravityMode: false,
        codexMode: false,
        dangerousMode: true,
        prompt: 'The project at @project_path under @root_path',
        rootSession: true,
        account: 'Second'
      },
      {
        cwd: '/root/proj',
        name: 'Shell',
        claudeMode: false,
        antigravityMode: false,
        codexMode: false,
        dangerousMode: false
      }
    ],
    terminals: [
      {
        command: 'npm run dev',
        commandMode: 'auto',
        color: 'green',
        serverUrl: 'http://x',
        groupView: true
      }
    ],
    ...extra
  })
  const world = (): Partial<World> => ({
    pins: [
      pin('Clave'),
      pin('Twin', { name: 'Same', workspaceId: 'ws1' }),
      pin('Twin2', { name: 'Same', workspaceId: 'ws2' })
    ],
    records: { caller: record('caller', { workspaceId: 'ws2' }) },
    sessions: [session('caller')]
  })
  it('resolves by id, by name in the caller’s workspace, and refuses what is unknown or ambiguous', async () => {
    const h = setup({ ...world(), windows: [] })
    expect(await run(h, 'launchGroup', { group: 'same' })).toMatchObject({ pinnedId: 'Twin2' })
    expect(await run(h, 'launchGroup', { group: 'Same', workspace: 'One' })).toMatchObject({
      pinnedId: 'Twin'
    })
    await expect(run(h, 'launchGroup', { group: 'nope' })).rejects.toThrow(
      'No pinned group "nope". Available: Clave, Same, Same'
    )
    // Two pins of one name in the window's own workspace, no caller: nobody to pick.
    h.w.pins.push(pin('Twin3', { name: 'Same', workspaceId: 'ws2' }))
    await expect(
      run(h, 'launchGroup', { group: 'Same' }, { callerSessionId: undefined, win: { id: 2 } })
    ).rejects.toThrow(
      'Pinned group "Same" is ambiguous across workspaces — pass the workspace parameter or an id. Candidates: One/Same (Twin), Two/Same (Twin2), Two/Same (Twin3)'
    )
  })
  it('asks the live window: running answers as such, hidden keeps the window, idle launches', async () => {
    const h = setup(world())
    h.requestView.mockResolvedValueOnce({ state: 'active-visible', groupId: 'live-g' })
    expect(await run(h, 'launchGroup', { group: 'Clave' })).toEqual({
      pinnedId: 'Clave',
      groupId: 'live-g',
      status: 'already-running'
    })
    expect(h.requestView).toHaveBeenCalledWith('wA', 'pinnedState', { pinnedId: 'Clave' }, 2000)
    h.requestView.mockResolvedValueOnce({ state: 'active-hidden', groupId: 'live-g' })
    expect(await run(h, 'launchGroup', { group: 'Clave' })).toBe(NOT_SERVED)
    h.requestView.mockRejectedValueOnce(new Error('timeout'))
    expect(await run(h, 'launchGroup', { group: 'Clave' })).toBe(NOT_SERVED)
    expect(h.argsOf('sessions.start')).toEqual([])
    h.requestView.mockResolvedValueOnce({ state: 'idle', groupId: null })
    expect(await run(h, 'launchGroup', { group: 'Clave' })).toEqual({
      pinnedId: 'Clave',
      groupId: 'g-new',
      status: 'launched'
    })
  })
  it('starts every session as the file says (root, prompt tokens, account by label), names them, makes the group, tells the windows', async () => {
    const h = setup({ ...world(), windows: [] })
    const out = await run(h, 'launchGroup', { group: 'Clave' })
    expect(out).toEqual({ pinnedId: 'Clave', groupId: 'g-new', status: 'launched' })
    expect(h.argsOf('sessions.start')).toEqual([
      {
        cwd: '/root',
        windowKey: 'wA',
        options: {
          claudeMode: true,
          antigravityMode: false,
          codexMode: false,
          dangerousMode: true,
          initialPrompt: 'The project at proj under /root',
          claudeProfileId: 'acc-2',
          claudeProfileLabel: 'Second',
          workspaceId: 'ws1'
        }
      },
      {
        cwd: '/root/proj',
        windowKey: 'wA',
        options: {
          claudeMode: false,
          antigravityMode: false,
          codexMode: false,
          dangerousMode: false,
          workspaceId: 'ws1'
        }
      }
    ])
    expect(h.argsOf('sessions.rename')).toEqual([
      ['new-1', 'Agent'],
      ['new-2', 'Shell']
    ])
    const made = h.argsOf('sidebar.createGroup')[0] as {
      windowKey: string
      group: Record<string, unknown>
    }
    expect(made.windowKey).toBe('wA')
    expect(made.group).toMatchObject({
      name: 'Clave',
      sessionIds: ['new-1', 'new-2'],
      cwd: '/root/proj',
      prompt: 'The project at @project_path under @root_path',
      rootSession: true,
      workspaceId: 'ws1',
      view: { url: 'http://x', title: 'Clave' }
    })
    const terminals = made.group.terminals as { id: string; command: string; sessionId: null }[]
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ command: 'npm run dev', sessionId: null })
    expect((made.group.view as { terminalId: string }).terminalId).toBe(terminals[0].id)
    expect(h.argsOf('publish')).toEqual([
      { _tag: 'pinned_group.launched', pinnedId: 'Clave', groupId: 'g-new', windowKey: 'wA' }
    ])
    // No window: the processes are kicked at a plain size.
    expect(h.argsOf('sessions.resize')).toEqual([
      ['new-1', 120, 30],
      ['new-2', 120, 30]
    ])
    // With no window to ask, this process remembers the launch while the group lives.
    h.w.layouts = [layout('wA', [group('g-new')])]
    expect(await run(h, 'launchGroup', { group: 'Clave' })).toEqual({
      pinnedId: 'Clave',
      groupId: 'g-new',
      status: 'already-running'
    })
  })
  it('an account the Mac does not know falls back to the Default and says so; no session at all is an error', async () => {
    const h = setup({ ...world(), windows: [] })
    h.w.pins[0].sessions[0].account = 'Nobody'
    await run(h, 'launchGroup', { group: 'Clave' })
    expect(h.argsOf('sessions.start')[0]).toMatchObject({
      options: { claudeProfileId: 'default', claudeProfileLabel: 'Default' }
    })
    expect(h.argsOf('notify')).toEqual([
      [
        'Clave',
        'Account "Nobody" is not set up on this Mac: "Agent" starts on the Default account.'
      ]
    ])
    resetServedLaunchesForTests()
    h.impl['sessions.start'] = () => {
      throw new Error('no dir')
    }
    await expect(run(h, 'launchGroup', { group: 'Twin' })).rejects.toThrow(
      'Launching "Same" spawned no sessions — check that its directories exist'
    )
    expect(h.argsOf('sidebar.createGroup')).toHaveLength(1)
  })
})

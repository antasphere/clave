import { beforeAll, describe, expect, it } from 'vitest'
import { Effect, Layer, Schema } from 'effect'
import { Command, CommandHandler, HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, run } from '@structure-ai/fixtures'
import type { Session, SessionGroup } from '../store/session-types'
import { nestToShowFocus, subagentAttention, subagentPresentation } from './subagent-presentation'

const session = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  cwd: '/fixture',
  folderName: 'fixture',
  name: id,
  alive: true,
  activityStatus: 'idle',
  promptWaiting: null,
  claudeMode: false,
  antigravityMode: false,
  codexMode: true,
  dangerousMode: false,
  claudeSessionId: null,
  sessionType: 'local',
  detectedUrl: null,
  serverStatus: null,
  serverCommand: null,
  hasUnseenActivity: false,
  userRenamed: true,
  planFilePath: null,
  workspaceId: 'fixture-workspace',
  ...over
})
const graph = (
  sessions: Session[],
  reachable = sessions.map((s) => s.id),
  editableRootId?: string
): ReturnType<typeof subagentPresentation> =>
  subagentPresentation(sessions, new Set(reachable), editableRootId)

describe('subagent presentation', () => {
  it('presents an editable root at any depth with its descendants attached and real links unchanged', () => {
    const rows = [
      session('parent'),
      session('middle', { spawnedBy: 'parent' }),
      session('leaf', { spawnedBy: 'middle' }),
      session('deep', { spawnedBy: 'leaf' }),
      session('sibling', { spawnedBy: 'parent' })
    ]
    const links = rows.map((s) => s.spawnedBy)
    const ids = rows.map((s) => s.id)
    const middle = graph(rows, ids, 'middle')
    expect(middle.rootById.has('middle')).toBe(false)
    expect(middle.descendants.get('middle')).toEqual([rows[2], rows[3]])
    expect(middle.descendants.get('middle')?.[0]).toBe(rows[2])
    expect(middle.descendants.get('parent')).toEqual([rows[4]])
    const leaf = graph(rows, ids, 'leaf')
    expect(leaf.rootById.has('leaf')).toBe(false)
    expect(leaf.descendants.get('leaf')).toEqual([rows[3]])
    expect(leaf.descendants.get('parent')).toEqual([rows[1], rows[4]])
    const deepest = graph(rows, ids, 'deep')
    expect(deepest.rootById.has('deep')).toBe(false)
    expect(deepest.descendants.has('deep')).toBe(false)
    expect(graph(rows, ids, 'parent')).toEqual(graph(rows))
    expect(graph(rows, ids, 'absent')).toEqual(graph(rows))
    expect(graph(rows, ['leaf', 'deep'], 'middle').rootById.get('deep')).toBe('leaf')
    expect(rows.map((s) => s.spawnedBy)).toEqual(links)
  })

  it('keeps cycle and workspace fallback intact while a target is editable', () => {
    const cycle = [
      session('a', { spawnedBy: 'b' }),
      session('b', { spawnedBy: 'a' }),
      session('branch', { spawnedBy: 'a' })
    ]
    expect(
      graph(
        cycle,
        cycle.map((s) => s.id),
        'a'
      ).rootById.size
    ).toBe(0)
    const crossWorkspace = [
      session('parent'),
      session('child', { spawnedBy: 'parent', workspaceId: 'elsewhere' }),
      session('leaf', { spawnedBy: 'child', workspaceId: 'elsewhere' })
    ]
    expect(
      graph(
        crossWorkspace,
        crossWorkspace.map((s) => s.id),
        'child'
      ).rootById.get('leaf')
    ).toBe('child')
    expect(
      graph(
        crossWorkspace,
        crossWorkspace.map((s) => s.id),
        'parent'
      ).rootById.has('child')
    ).toBe(false)
  })
  it('summarizes child attention ahead of unread activity and ongoing work without changing sessions', () => {
    const working = session('working', { agentState: 'working' })
    const unread = session('unread', { hasUnseenActivity: true })
    const blocked = session('blocked', { agentState: 'blocked' })
    const ended = session('ended', { alive: false, agentState: 'blocked', hasUnseenActivity: true })
    expect(subagentAttention([working, unread, blocked, ended])).toEqual({
      status: 'needs-you',
      sessions: [blocked]
    })
    expect(subagentAttention([working, unread, ended])).toEqual({
      status: 'unread',
      sessions: [unread]
    })
    expect(subagentAttention([working, ended])).toEqual({ status: 'working', sessions: [working] })
    expect(subagentAttention([ended])).toEqual({ status: 'idle', sessions: [] })
    expect(working.agentState).toBe('working')
    expect(unread.hasUnseenActivity).toBe(true)
    expect(blocked.agentState).toBe('blocked')
  })
  it('folds nested agents and nested terminals alike while preserving live session objects', () => {
    const parent = session('parent')
    const child = session('child', { spawnedBy: parent.id })
    const nested = session('nested', { spawnedBy: child.id })
    const terminal = session('terminal', { spawnedBy: parent.id, codexMode: false })
    const rows = [nested, parent, child, terminal, session('unrelated')]
    const result = graph(rows)
    expect([...result.rootById]).toEqual([
      ['nested', 'parent'],
      ['child', 'parent'],
      ['terminal', 'parent']
    ])
    expect(result.descendants.get(parent.id)).toEqual([child, terminal, nested])
    expect(result.descendants.get(parent.id)?.[0]).toBe(child)
    expect(rows).toHaveLength(5)
  })

  it('counts a plain terminal nested under a tab among its descendants', () => {
    const parent = session('parent', { codexMode: false })
    const terminal = session('terminal', { spawnedBy: parent.id, codexMode: false })
    const result = graph([parent, terminal])
    expect(result.rootById.get(terminal.id)).toBe(parent.id)
    expect(result.descendants.get(parent.id)).toEqual([terminal])
  })

  it('keeps missing, filtered and cross-workspace parents from hiding children', () => {
    const parent = session('parent')
    const child = session('child', { spawnedBy: 'parent' })
    expect(graph([child]).rootById.size).toBe(0)
    expect(graph([parent, child], ['child']).rootById.size).toBe(0)
    expect(graph([parent, child], []).rootById.size).toBe(0)
    expect(graph([parent, { ...child, workspaceId: 'elsewhere' }]).rootById.size).toBe(0)
    expect(graph([{ ...parent, sessionType: 'agent' }, child]).rootById.size).toBe(0)
  })

  it('re-roots surviving nested children after an ancestor closes', () => {
    const child = session('child', { spawnedBy: 'removed' })
    const nested = session('nested', { spawnedBy: 'child' })
    expect([...graph([child, nested]).rootById]).toEqual([['nested', 'child']])
    expect(graph([nested]).rootById.size).toBe(0)
  })

  it('falls back to ordinary rows for self-links, cycles and branches into cycles', () => {
    expect(
      graph([
        session('a', { spawnedBy: 'b' }),
        session('b', { spawnedBy: 'a' }),
        session('branch', { spawnedBy: 'a' }),
        session('self', { spawnedBy: 'self' })
      ]).rootById.size
    ).toBe(0)
  })

  it('accepts every local provider agent and keeps remote agent sessions ordinary', () => {
    const parent = session('parent')
    for (const flag of [
      'claudeMode',
      'claudeAgentsMode',
      'codexMode',
      'antigravityMode',
      'piMode'
    ]) {
      expect(
        graph([
          parent,
          session('child', { codexMode: false, [flag]: true, spawnedBy: parent.id })
        ]).rootById.get('child')
      ).toBe('parent')
    }
    expect(
      graph([parent, session('remote', { sessionType: 'agent', spawnedBy: parent.id })]).rootById
        .size
    ).toBe(0)
  })
})

describe('the nest that keeps the focused tab in sight', () => {
  const lead = session('lead')
  const helper = session('helper', { spawnedBy: lead.id })
  const any = (): boolean => true
  // What the sidebar does at each change: ask with what it remembers, keep
  // the answer's memory.
  const ask = (
    seen: string | null,
    focused: string | null,
    rows: Session[],
    drawsNest: (root: string) => boolean = any
  ): ReturnType<typeof nestToShowFocus> =>
    nestToShowFocus(seen, focused, graph(rows).rootById, drawsNest)

  it('opens the nest of the tab the focus moves onto, once, so it can be folded again', () => {
    const first = ask(null, helper.id, [lead, helper])
    expect(first.open).toBe(lead.id)
    // The same tab under the same parent asks for nothing: the person folded
    // the nest and it stays folded.
    expect(ask(first.seen, helper.id, [lead, helper]).open).toBeNull()
  })

  it('opens nothing for a tab that is nested under no tab', () => {
    expect(ask(null, lead.id, [lead, helper])).toEqual({ seen: null, open: null })
    expect(ask(null, null, [lead, helper])).toEqual({ seen: null, open: null })
  })

  it('opens the nest when the parent comes back after the focused tab, as a restart places them', () => {
    // The focused tab is placed first: its parent is not there, it is a row.
    const alone = ask(null, helper.id, [helper])
    expect(alone).toEqual({ seen: null, open: null })
    // The parent arrives. The focus did not move, and the tab is now hidden
    // in a folded nest unless the nest opens.
    expect(ask(alone.seen, helper.id, [lead, helper]).open).toBe(lead.id)
  })

  it('opens the nest when the tab on screen is nested while it has the focus', () => {
    const loose = session('helper')
    const before = ask(null, loose.id, [lead, loose])
    expect(before.open).toBeNull()
    expect(ask(before.seen, helper.id, [lead, helper]).open).toBe(lead.id)
  })

  it('opens the nest again each time the focus comes back to the nested tab', () => {
    const first = ask(null, helper.id, [lead, helper])
    const away = ask(first.seen, lead.id, [lead, helper])
    expect(away).toEqual({ seen: null, open: null })
    expect(ask(away.seen, helper.id, [lead, helper]).open).toBe(lead.id)
  })

  it('opens the nest again when the focus moves to another tab of the same nest', () => {
    const second = session('second', { spawnedBy: lead.id })
    const first = ask(null, helper.id, [lead, helper, second])
    // The person folds the nest, then goes to another tab that sits in it.
    expect(ask(first.seen, second.id, [lead, helper, second]).open).toBe(lead.id)
  })

  it('opens the other nest when the focused tab is moved under another tab', () => {
    const other = session('other')
    const first = ask(null, helper.id, [lead, other, helper])
    const moved = ask(first.seen, helper.id, [lead, other, { ...helper, spawnedBy: other.id }])
    expect(moved.open).toBe(other.id)
  })

  it('waits for a parent drawn by a wave or lane entry to draw a nest of its own', () => {
    const drawn = ask(null, helper.id, [lead, helper], () => false)
    expect(drawn).toEqual({ seen: null, open: null })
    expect(ask(drawn.seen, helper.id, [lead, helper]).open).toBe(lead.id)
  })
})

let store: typeof import('../store/session-store').useSessionStore
let shortcutOrder: typeof import('../store/session-store').getVisibleFlatOrder
let cycleOrder: typeof import('../store/session-store').getSessionCycleOrder
beforeAll(async () => {
  const mem = new Map<string, string>()
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => mem.set(k, v),
      removeItem: (k: string) => mem.delete(k)
    },
    window: { electronAPI: { captureTabClosed: () => {} } }
  })
  const module = await import('../store/session-store')
  store = module.useSessionStore
  shortcutOrder = module.getVisibleFlatOrder
  cycleOrder = module.getSessionCycleOrder
})

it('numbers represented rows while preserving cycle access and rendered search/filter order', () => {
  const parent = session('parent')
  const child = session('child', { spawnedBy: parent.id })
  const nested = session('nested', { spawnedBy: child.id })
  const terminal = session('terminal', { codexMode: false })
  const state = {
    sessions: [terminal, nested, child, parent],
    groups: [] as SessionGroup[],
    displayOrder: ['terminal', 'nested', 'child', 'parent']
  }
  expect(shortcutOrder(state, 'fixture-workspace')).toEqual(['terminal', 'parent'])
  expect(cycleOrder(state, 'fixture-workspace')).toEqual(['terminal', 'nested', 'child', 'parent'])
  expect(shortcutOrder(state, 'fixture-workspace', ['child'])).toEqual(['child'])
  expect(shortcutOrder(state, 'fixture-workspace', ['parent', 'child', 'nested'])).toEqual([
    'parent',
    'child',
    'nested'
  ])
  expect(shortcutOrder(state, 'fixture-workspace', [])).toEqual([])
  expect(shortcutOrder(state, 'different-workspace')).toEqual([])
  const collapsed = {
    ...state,
    groups: [
      {
        id: 'collapsed',
        name: 'Collapsed',
        cwd: '/fixture',
        sessionIds: [parent.id],
        collapsed: true,
        workspaceId: 'fixture-workspace',
        terminals: []
      }
    ],
    displayOrder: ['terminal', 'nested', 'child', 'collapsed']
  }
  expect(shortcutOrder(collapsed, 'fixture-workspace')).toEqual(['terminal', 'child'])
  const linked = session('linked')
  const linkedState = {
    ...state,
    sessions: [
      ...state.sessions,
      { ...linked, view: { url: 'http://localhost', serverSessionId: terminal.id } }
    ]
  }
  expect(shortcutOrder(linkedState, 'fixture-workspace')).toEqual(['parent'])
})

it('loads and verifies the sidebar/subagent-dropdown fixture scenario through session commands', async () => {
  const Add = Command.define('sidebar-fixtures/AddSession', {
    payload: Schema.Struct({ id: Schema.String, parent: Schema.optional(Schema.String) }),
    success: Schema.String,
    failure: Schema.Never
  })
  const handlers = HandlerRegistry.layer(
    CommandHandler.make(Add, ({ id, parent }) =>
      Effect.sync(() => {
        store.getState().addSession(session(id, { spawnedBy: parent }))
        return id
      })
    )
  )
  const parent = defineFixture({
    key: 'sidebar/parent',
    create: ({ dispatch, id }) => dispatch(Add, { id: id('parent') })
  })
  const child = defineFixture({
    key: 'sidebar/child',
    dependencies: { parent },
    create: ({ dispatch, id, dependencies }) =>
      dispatch(Add, { id: id('child'), parent: dependencies.parent })
  })
  const nested = defineFixture({
    key: 'sidebar/nested',
    dependencies: { child },
    create: ({ dispatch, id, dependencies }) =>
      dispatch(Add, { id: id('nested'), parent: dependencies.child })
  })
  const scenario = defineScenario({
    name: 'sidebar/subagent-dropdown',
    description: 'Live nested agents remain addressable while the sidebar compacts them',
    input: Schema.Struct({}),
    fixtures: () => ({ parent, child, nested })
  })
  store.setState({
    sessions: [],
    groups: [],
    displayOrder: [],
    selectedSessionIds: [],
    focusedSessionId: null
  })
  const report = await Effect.runPromise(
    Effect.gen(function* () {
      const fixtures = yield* scenario.prepare({})
      return yield* run({
        fixtures,
        enabled: true,
        ready: () =>
          Effect.sync(() => {
            const sessions = store.getState().sessions
            const result = graph(sessions)
            expect(sessions).toHaveLength(3)
            expect(result.descendants.size).toBe(1)
            const [parentId, children] = [...result.descendants][0]
            expect(children).toHaveLength(2)
            const links = sessions.map((s) => s.spawnedBy)
            const editing = graph(
              sessions,
              sessions.map((s) => s.id),
              children[0].id
            )
            expect(editing.rootById.has(children[0].id)).toBe(false)
            expect(editing.descendants.get(children[0].id)?.map((s) => s.id)).toEqual([
              children[1].id
            ])
            expect(store.getState().sessions).toBe(sessions)
            expect(store.getState().sessions.map((s) => s.spawnedBy)).toEqual(links)
            expect(shortcutOrder(store.getState(), 'fixture-workspace')).toEqual([parentId])
            expect(new Set(cycleOrder(store.getState(), 'fixture-workspace'))).toEqual(
              new Set(sessions.map((s) => s.id))
            )
            store.getState().selectSession(parentId, false)
            store.getState().setAgentState(children[0].id, 'blocked')
            store.getState().setAgentState(children[1].id, 'working')
            const attention = (): ReturnType<typeof subagentAttention> =>
              subagentAttention(store.getState().sessions.filter((s) => s.id !== parentId))
            expect(attention().status).toBe('needs-you')
            store.getState().setAgentState(children[0].id, 'idle')
            expect(attention().status).toBe('unread')
            store.getState().selectSession(children[0].id, false)
            expect(attention().status).toBe('working')
            store.getState().setAgentState(children[1].id, 'idle')
            expect(attention().status).toBe('unread')
            store.getState().selectSession(children[1].id, false)
            expect(attention().status).toBe('idle')
            expect(store.getState().focusedSessionId).toBe(children[1].id)
            expect(result.rootById.get(store.getState().focusedSessionId!)).toBe(parentId)
            store.getState().selectSession(parentId, false)
            expect(store.getState().focusedSessionId).toBe(parentId)
            store.getState().removeSession(parentId)
            expect(
              graph(store.getState().sessions)
                .descendants.get(children[0].id)
                ?.map((s) => s.id)
            ).toEqual([children[1].id])
          })
      })
    }).pipe(Effect.provide(busesLayer.pipe(Layer.provide(handlers))))
  )
  console.log(
    JSON.stringify({
      scenario: scenario.name,
      target: 'isolated in-memory renderer store with recording preload',
      runId: report.runId,
      ids: report.ids
    })
  )
  // Explicit cleanup through the same session command, limited to this run.
  for (const id of Object.values(report.values)) store.getState().removeSession(id)
  expect(store.getState().sessions).toEqual([])
})

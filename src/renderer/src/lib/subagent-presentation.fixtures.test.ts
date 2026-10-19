import { beforeAll, describe, expect, it } from 'vitest'
import { Effect, Layer, Schema } from 'effect'
import { Command, CommandHandler, HandlerRegistry, layer as busesLayer } from '@structure-ai/cqrs'
import { defineFixture, defineScenario, run } from '@structure-ai/fixtures'
import type { Session, SessionGroup } from '../store/session-types'
import { subagentAttention, subagentPresentation } from './subagent-presentation'

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
  reachable = sessions.map((s) => s.id)
): ReturnType<typeof subagentPresentation> => subagentPresentation(sessions, new Set(reachable))

describe('subagent presentation', () => {
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
  it('compacts nested agents while preserving live session objects and terminals', () => {
    const parent = session('parent')
    const child = session('child', { spawnedBy: parent.id })
    const nested = session('nested', { spawnedBy: child.id })
    const terminal = session('terminal', { spawnedBy: parent.id, codexMode: false })
    const rows = [nested, parent, child, terminal, session('unrelated')]
    const result = graph(rows)
    expect([...result.rootById]).toEqual([
      ['nested', 'parent'],
      ['child', 'parent']
    ])
    expect(result.descendants.get(parent.id)).toEqual([child, nested])
    expect(result.descendants.get(parent.id)?.[0]).toBe(child)
    expect(rows).toHaveLength(5)
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

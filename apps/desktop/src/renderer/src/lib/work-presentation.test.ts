import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyWorkChange, type WorkChange } from '@clave/contract/work-rules'
import type { Session } from '../store/session-types'
import { subagentPresentation } from './subagent-presentation'
import { entryTarget, workPresentation } from './work-presentation'

/**
 * The sidebar's entries over the two large-wave shapes of PRDCT-4123
 * (tests/e2e/work-waves.json): the shape's changes applied through the rule,
 * the spawned agents linked to their openers, then the rows the sidebar would
 * draw. The rule's own scenario test proves who holds what; this one proves
 * what the sidebar makes of it.
 */
interface Shape {
  name: string
  sessions: { key: string; title: string; spawnedBy?: string }[]
  steps: { as: string; target?: string; change: Record<string, unknown> & { type: string } }[]
  expect: { ordinary: string[]; agents: Record<string, string>; units: { unit: string }[] }
  then: {
    name: string
    open?: { key: string; title: string }[]
    steps?: Shape['steps']
    close?: string[]
  }[]
}
const SHAPES = (
  JSON.parse(
    readFileSync(path.resolve(__dirname, '../../../../../../tests/e2e/work-waves.json'), 'utf-8')
  ) as { waves: Shape[] }
).waves

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const tab = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  cwd: '/fixture',
  folderName: 'fixture',
  name: id,
  alive: true,
  activityStatus: 'idle',
  promptWaiting: null,
  claudeMode: true,
  antigravityMode: false,
  codexMode: false,
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

/** The shape's sessions as the window holds them after its changes. */
function build(shape: Shape): { sessions: Map<string, Session>; ids: Record<string, string> } {
  const ids: Record<string, string> = {}
  shape.sessions.forEach((s, i) => (ids[s.key] = uuid(i + 1)))
  const sessions = new Map<string, Session>()
  for (const s of shape.sessions)
    sessions.set(
      ids[s.key],
      tab(ids[s.key], {
        name: s.title,
        ...(s.spawnedBy ? { spawnedBy: ids[s.spawnedBy] } : {})
      })
    )
  let now = 1_000
  const apply = (step: Shape['steps'][number]): void => {
    const c = step.change
    const change = (c.type === 'offer' ? { type: 'offer', to: ids[String(c.to)] } : c) as WorkChange
    const all = [...sessions.values()].map((s) => ({ id: s.id, work: s.work }))
    for (const u of applyWorkChange(all, ids[step.target ?? step.as], change, (now += 10))) {
      const s = sessions.get(u.id)
      if (s) sessions.set(u.id, { ...s, work: u.work ?? undefined })
    }
  }
  for (const step of shape.steps) apply(step)
  return Object.assign({ sessions, ids }, { apply })
}

/** The rows the sidebar draws for these sessions, all reachable: what is
 *  neither a folded agent nor a folded member. */
function rows(
  sessions: Session[],
  editable?: string | null
): {
  subagents: ReturnType<typeof subagentPresentation>
  work: ReturnType<typeof workPresentation>
  drawn: Session[]
} {
  const reachable = new Set(sessions.map((s) => s.id))
  const subagents = subagentPresentation(sessions, reachable, editable)
  const work = workPresentation(sessions, reachable, subagents.descendants, editable)
  const drawn = sessions.filter((s) => !subagents.rootById.has(s.id) && !work.folded.has(s.id))
  return { subagents, work, drawn }
}

describe.each(SHAPES)('the $name wave in the sidebar', (shape) => {
  it('draws one entry per unit and the ordinary sessions, nothing else', () => {
    const { sessions, ids } = build(shape)
    const keyOf = (id: string): string => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id
    const list = [...sessions.values()]
    const { work, drawn } = rows(list)
    expect(work.entryByAnchor.size).toBe(shape.expect.units.length)
    const entries = [...work.entryByAnchor.values()]
    expect(entries.map((e) => e.unit).sort()).toEqual(shape.expect.units.map((u) => u.unit).sort())
    // Every drawn row is an entry's anchor or an ordinary session.
    const anchors = new Set(work.entryByAnchor.keys())
    const ordinary = drawn.filter((s) => !anchors.has(s.id)).map((s) => keyOf(s.id))
    expect(ordinary.sort()).toEqual([...shape.expect.ordinary].sort())
    expect(drawn).toHaveLength(shape.expect.units.length + shape.expect.ordinary.length)
    // Each anchor is its unit's earliest-joined member.
    for (const entry of entries) expect(entry.anchor).toBe(entry.members[0])
    // The spawned agents fold into their opener's entry, a superseded opener
    // included, and stay current: never in the entry's history.
    for (const [agentKey, unit] of Object.entries(shape.expect.agents)) {
      const entry = entries.find((e) => e.unit === unit)
      expect(
        entry?.agents.map((a) => keyOf(a.id)),
        `${agentKey} in ${unit}`
      ).toContain(agentKey)
      expect(entry?.history.map((h) => keyOf(h.id))).not.toContain(agentKey)
    }
  })

  it('keeps every entry in place through the later phases', () => {
    const built = build(shape) as ReturnType<typeof build> & {
      apply: (step: Shape['steps'][number]) => void
    }
    const anchorsBefore = new Map(
      [...rows([...built.sessions.values()]).work.entryByAnchor.values()].map((e) => [
        e.unit,
        e.anchor
      ])
    )
    let n = 900
    for (const phase of shape.then) {
      for (const s of phase.open ?? []) {
        built.ids[s.key] = uuid(++n)
        built.sessions.set(built.ids[s.key], tab(built.ids[s.key], { name: s.title }))
      }
      for (const step of phase.steps ?? []) built.apply(step)
      for (const key of phase.close ?? []) built.sessions.delete(built.ids[key])
      const after = rows([...built.sessions.values()]).work
      expect(after.entryByAnchor.size, phase.name).toBe(shape.expect.units.length)
      for (const entry of after.entryByAnchor.values()) {
        const before = anchorsBefore.get(entry.unit)
        // A closed anchor hands its place to the next earliest member.
        if (before && built.sessions.has(before)) expect(entry.anchor, phase.name).toBe(before)
      }
    }
  })
})

describe('work presentation', () => {
  const lead = (id: string, over: Partial<NonNullable<Session['work']>> = {}): Session =>
    tab(id, {
      work: {
        unit: 'lane-a',
        kind: 'lane',
        label: 'Pair the phone',
        role: 'lead',
        standing: 'current',
        joinedAt: 10,
        since: 10,
        ...over
      }
    })

  it('goes to the holder on a click, and opens the summary when nobody holds the lane', () => {
    const held = rows([lead(uuid(1)), lead(uuid(2), { role: 'verifier', joinedAt: 5 })]).work
    const entry = [...held.entryByAnchor.values()][0]
    expect(entry.anchor).toBe(uuid(2))
    expect(entry.target).toBe(uuid(1))
    expect(entryTarget(entry)).toBe(uuid(1))
    const unresolved = rows([lead(uuid(1)), lead(uuid(2), { joinedAt: 5 })]).work
    const open = [...unresolved.entryByAnchor.values()][0]
    expect(open.target).toBeNull()
    expect(entryTarget(open)).toBe(open.anchor)
  })

  it('gives a member being renamed its own row until the edit ends', () => {
    const sessions = [lead(uuid(1)), lead(uuid(2), { role: 'verifier', joinedAt: 20 })]
    const { drawn, work } = rows(sessions, uuid(2))
    expect(drawn.map((s) => s.id).sort()).toEqual([uuid(1), uuid(2)])
    expect(work.folded.size).toBe(0)
  })

  it('never folds a member under the tab that spawned it, and leaves ordinary spawns as they were', () => {
    const parent = tab(uuid(1))
    const member = lead(uuid(2), { role: 'verifier' })
    const assigned = { ...member, spawnedBy: uuid(1) }
    const plainChild = tab(uuid(3), { spawnedBy: uuid(1) })
    const { subagents, work, drawn } = rows([parent, assigned, plainChild])
    expect(subagents.rootById.get(uuid(2))).toBeUndefined()
    expect(subagents.rootById.get(uuid(3))).toBe(uuid(1))
    expect(work.entryByAnchor.get(uuid(2))?.unit).toBe('lane-a')
    expect(drawn.map((s) => s.id).sort()).toEqual([uuid(1), uuid(2)])
  })

  it('leaves out a member whose row is not reachable, and draws no entry with no reachable member', () => {
    const sessions = [lead(uuid(1)), lead(uuid(2), { role: 'verifier', joinedAt: 5 })]
    const subagents = subagentPresentation(sessions, new Set([uuid(1)]))
    const one = workPresentation(sessions, new Set([uuid(1)]), subagents.descendants)
    expect([...one.entryByAnchor.keys()]).toEqual([uuid(1)])
    expect(one.unitOf.get(uuid(2))).toBe('lane-a')
    const none = workPresentation(sessions, new Set(), new Map())
    expect(none.entryByAnchor.size).toBe(0)
  })
})

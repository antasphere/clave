/**
 * The two large-wave shapes of PRDCT-4123 (tests/e2e/work-waves.json), built
 * as the application builds them: every session opened and every change made
 * through a command on the bus, each change through the rule the server runs
 * (`applyWorkChange`), over an in-memory record store. Then every unit is read
 * back the way the sidebar reads it (`deriveWorkUnits`) and compared with what
 * the shape says, after the shape is built and after each later phase: one
 * more handoff, a predecessor closing on a handover nobody accepted, and the
 * person completing it. The same store is written out and read back as a
 * restart reads the record files, and must read the same.
 *
 * The titles are in the shape to mislead (a PRIMARY on a superseded lead, a
 * handed over on the current coordinator); nothing here reads them, which is
 * the point: an owner comes from the standings alone.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Effect, Layer, Schema } from 'effect'
import {
  Command,
  CommandBus,
  CommandHandler,
  HandlerRegistry,
  layer as busesLayer
} from '@structure-ai/cqrs'
import { defineFixture, defineScenario, run } from '@structure-ai/fixtures'
import { describe, expect, it } from 'vitest'
import {
  applyWorkChange,
  deriveWorkUnits,
  sanitizeWork,
  type WorkAssignment,
  type WorkChange,
  type WorkHolding,
  type WorkRecord
} from './work-rules'

interface ShapeSession {
  key: string
  title: string
  spawnedBy?: string
}
interface ShapeStep {
  as: string
  target?: string
  change: Record<string, unknown> & { type: WorkChange['type'] }
  replace?: boolean
}
interface ExpectedUnit {
  unit: string
  kind?: string
  label?: string
  owner?: Record<string, unknown>
  reviewer?: Record<string, unknown>
  workers?: string[]
  pending?: string[]
  history?: string[]
}
interface Shape {
  name: string
  group: string
  sessions: ShapeSession[]
  steps: ShapeStep[]
  expect: { ordinary: string[]; agents: Record<string, string>; units: ExpectedUnit[] }
  then: Array<{
    name: string
    open?: ShapeSession[]
    steps?: ShapeStep[]
    close?: string[]
    expect: Record<string, Omit<ExpectedUnit, 'unit'>>
  }>
}

const SHAPES = (
  JSON.parse(
    readFileSync(path.resolve(__dirname, '../../../tests/e2e/work-waves.json'), 'utf-8')
  ) as { waves: Shape[] }
).waves

/** The record store the commands write: the session's title (never read by
 *  the rule) and its assignment, keyed by session id. */
interface StoredSession {
  id: string
  title: string
  work?: WorkAssignment
}

const OpenSession = Command.define('work-fixtures/OpenSession', {
  payload: Schema.Struct({ id: Schema.String, title: Schema.String }),
  success: Schema.String,
  failure: Schema.Never
})
const CloseSession = Command.define('work-fixtures/CloseSession', {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Void,
  failure: Schema.Never
})
const ChangeWork = Command.define('work-fixtures/ChangeWork', {
  payload: Schema.Struct({ id: Schema.String, change: Schema.Unknown }),
  success: Schema.Number,
  failure: Schema.Never
})

/** A step's change with the shape's keys turned into the run's session ids. */
function changeOf(step: ShapeStep, idOf: (key: string) => string): WorkChange {
  const c = step.change
  switch (c.type) {
    case 'assign':
      return {
        type: 'assign',
        work: c.work as Extract<WorkChange, { type: 'assign' }>['work'],
        ...(step.change.replace === true || step.replace === true ? { replace: true } : {})
      }
    case 'offer':
      return { type: 'offer', to: idOf(String(c.to)) }
    case 'accept':
      return { type: 'accept', ...(c.replace === true ? { replace: true } : {}) }
    default:
      return { type: c.type } as WorkChange
  }
}

/** A holding with the run's ids turned back into the shape's keys. */
function holdingKeys(h: WorkHolding, keyOf: (id: string) => string): Record<string, unknown> {
  if (h.state === 'held' || h.state === 'completed') return { state: h.state, id: keyOf(h.id) }
  if (h.state === 'unresolved')
    return { state: h.state, reason: h.reason, candidates: h.candidates.map(keyOf) }
  return { state: h.state }
}

function checkUnits(
  sessions: Map<string, StoredSession>,
  keyOf: (id: string) => string,
  expected: ReadonlyArray<ExpectedUnit>,
  label: string
): void {
  const units = new Map(
    deriveWorkUnits([...sessions.values()].map((s) => ({ id: s.id, work: s.work }))).map((u) => [
      u.unit,
      u
    ])
  )
  for (const want of expected) {
    const got = units.get(want.unit)
    expect(got, `${label}: unit ${want.unit} is read`).toBeDefined()
    if (!got) continue
    const where = `${label}: ${want.unit}`
    if (want.kind) expect(got.kind, `${where} kind`).toBe(want.kind)
    if (want.label) expect(got.label, `${where} label`).toBe(want.label)
    if (want.owner) expect(holdingKeys(got.owner, keyOf), `${where} owner`).toEqual(want.owner)
    if (want.reviewer)
      expect(holdingKeys(got.reviewer, keyOf), `${where} reviewer`).toEqual(want.reviewer)
    if (want.workers)
      expect(got.workers.map(keyOf).sort(), `${where} workers`).toEqual([...want.workers].sort())
    if (want.pending)
      expect(got.pending.map((p) => keyOf(p.id)).sort(), `${where} pending`).toEqual(
        [...want.pending].sort()
      )
    if (want.history)
      expect(got.history.map((h) => keyOf(h.id)).sort(), `${where} history`).toEqual(
        [...want.history].sort()
      )
  }
}

describe.each(SHAPES)('the $name wave, built through the commands', (shape) => {
  it('reads one entry per unit, from the standings alone, through every later phase and a restart', async () => {
    // The store the commands write, and the handlers that write it: each
    // change goes through the rule the server runs. A refusal is a defect of
    // the shape, not of the run, and dies with the rule's own words.
    const sessions = new Map<string, StoredSession>()
    let clock = 1_700_000_000_000
    const handlers = HandlerRegistry.layer(
      CommandHandler.make(OpenSession, ({ id, title }) =>
        Effect.sync(() => {
          sessions.set(id, { id, title })
          return id
        })
      ),
      CommandHandler.make(CloseSession, ({ id }) =>
        Effect.sync(() => {
          sessions.delete(id)
        })
      ),
      CommandHandler.make(ChangeWork, ({ id, change }) =>
        Effect.sync(() => {
          clock += 1_000
          const all: WorkRecord[] = [...sessions.values()].map((s) => ({ id: s.id, work: s.work }))
          const updates = applyWorkChange(all, id, change as WorkChange, clock)
          for (const u of updates) {
            const s = sessions.get(u.id)
            if (!s) continue
            if (u.work) s.work = u.work
            else delete s.work
          }
          return updates.length
        })
      )
    )
    const wave = defineFixture({
      key: `work/${shape.name}`,
      create: ({ dispatch, id }) =>
        Effect.gen(function* () {
          const ids: Record<string, string> = {}
          for (const s of shape.sessions)
            ids[s.key] = yield* dispatch(OpenSession, { id: id(s.key), title: s.title })
          for (const step of shape.steps) {
            const subject = ids[step.target ?? step.as]
            yield* dispatch(ChangeWork, { id: subject, change: changeOf(step, (k) => ids[k]) })
          }
          return ids
        })
    })
    const scenario = defineScenario({
      name: `work/${shape.name}`,
      description: `The ${shape.group}: ${shape.sessions.length} sessions, its lanes handed over, verified, completed and left unresolved through the rule's own changes`,
      input: Schema.Struct({}),
      fixtures: () => ({ wave })
    })
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const fixtures = yield* scenario.prepare({})
        return yield* run({
          fixtures,
          enabled: true,
          ready: (built) =>
            Effect.gen(function* () {
              const ids: Record<string, string> = {
                ...(built.values.wave as Record<string, string>)
              }
              const keyOf = (id: string): string =>
                Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id
              expect(sessions.size).toBe(shape.sessions.length)

              // The shape as built: one entry per unit, the ordinary
              // sessions and the spawned agents left with no assignment.
              checkUnits(sessions, keyOf, shape.expect.units, 'built')
              const units = deriveWorkUnits([...sessions.values()])
              expect(units.map((u) => u.unit).sort()).toEqual(
                shape.expect.units.map((u) => u.unit).sort()
              )
              const unassigned = [...sessions.values()]
                .filter((s) => !s.work)
                .map((s) => keyOf(s.id))
              expect(unassigned.sort()).toEqual(
                [...shape.expect.ordinary, ...Object.keys(shape.expect.agents)].sort()
              )

              // A restart reads the record files back: the same entries.
              const reread = [...sessions.values()].map((s) => ({
                id: s.id,
                work: sanitizeWork(JSON.parse(JSON.stringify(s.work ?? null)))
              }))
              expect(deriveWorkUnits(reread)).toEqual(units)

              // The later phases, through the same commands, each with what
              // must hold after it; the entries stay the same units.
              const bus = yield* CommandBus
              for (const phase of shape.then) {
                for (const s of phase.open ?? [])
                  ids[s.key] = yield* bus.dispatch(OpenSession, {
                    id: crypto.randomUUID(),
                    title: s.title
                  })
                for (const step of phase.steps ?? [])
                  yield* bus.dispatch(ChangeWork, {
                    id: ids[step.target ?? step.as],
                    change: changeOf(step, (k) => ids[k])
                  })
                for (const key of phase.close ?? [])
                  yield* bus.dispatch(CloseSession, { id: ids[key] })
                checkUnits(
                  sessions,
                  keyOf,
                  Object.entries(phase.expect).map(([unit, want]) => ({ unit, ...want })),
                  phase.name
                )
                expect(
                  deriveWorkUnits([...sessions.values()])
                    .map((u) => u.unit)
                    .sort()
                ).toEqual(shape.expect.units.map((u) => u.unit).sort())
              }
            })
        })
      }).pipe(Effect.provide(busesLayer.pipe(Layer.provide(handlers))))
    )
    // The handoff names the run, as the fixture rules ask.
    console.log(
      JSON.stringify({
        scenario: scenario.name,
        target: 'an in-memory record store driven by the rule the server runs',
        runId: report.runId,
        sessions: shape.sessions.length
      })
    )
  })
})

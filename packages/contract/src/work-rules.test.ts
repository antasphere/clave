import { describe, expect, it } from 'vitest'
import {
  applyWorkChange,
  deriveWorkUnits,
  sanitizeWork,
  takeoverRenames,
  WorkChangeRefusal,
  type WorkAssignment,
  type WorkChange,
  type WorkRecord
} from './work-rules'

// Session ids are UUIDs on the records; these read as their role in a test.
const ID = {
  lead: '00000000-0000-4000-8000-000000000001',
  next: '00000000-0000-4000-8000-000000000002',
  third: '00000000-0000-4000-8000-000000000003',
  verifier: '00000000-0000-4000-8000-000000000004',
  worker: '00000000-0000-4000-8000-000000000005',
  plain: '00000000-0000-4000-8000-000000000006',
  other: '00000000-0000-4000-8000-000000000007'
} as const

const lane = (over: Partial<WorkAssignment> = {}): WorkAssignment => ({
  unit: 'lane-a',
  kind: 'lane',
  label: 'Pair the phone',
  wave: 'wave-1',
  waveLabel: 'Mobile beta',
  role: 'lead',
  standing: 'current',
  joinedAt: 10,
  since: 10,
  ...over
})

/** A tiny record store driven only through the rule, as the host does. */
function store(initial: WorkRecord[] = []): {
  records: Map<string, WorkAssignment | undefined>
  change: (id: string, change: WorkChange) => ReturnType<typeof applyWorkChange>
  work: (id: string) => WorkAssignment | undefined
  all: () => WorkRecord[]
} {
  const records = new Map<string, WorkAssignment | undefined>(
    initial.map((r) => [r.id, r.work ?? undefined])
  )
  let now = 100
  const all = (): WorkRecord[] => [...records].map(([id, work]) => ({ id, work }))
  return {
    records,
    all,
    work: (id) => records.get(id),
    change: (id, change) => {
      const updates = applyWorkChange(all(), id, change, (now += 10))
      for (const u of updates) records.set(u.id, u.work ?? undefined)
      return updates
    }
  }
}

describe('sanitizeWork', () => {
  it('keeps a whole valid assignment and nothing it does not know', () => {
    const full = { ...lane({ task: 'Spec', from: ID.next }), extra: 'dropped' }
    expect(sanitizeWork(full)).toEqual(lane({ task: 'Spec', from: ID.next }))
  })

  it('drops the assignment when a required field is missing or wrong', () => {
    expect(sanitizeWork(null)).toBeUndefined()
    expect(sanitizeWork({ ...lane(), unit: '' })).toBeUndefined()
    expect(sanitizeWork({ ...lane(), label: 'x'.repeat(81) })).toBeUndefined()
    expect(sanitizeWork({ ...lane(), label: 'tab\u0007bell' })).toBeUndefined()
    expect(sanitizeWork({ ...lane(), standing: 'past' })).toBeUndefined()
    expect(sanitizeWork({ ...lane(), role: 'owner' })).toBeUndefined()
    expect(sanitizeWork({ ...lane(), joinedAt: Number.NaN })).toBeUndefined()
    expect(sanitizeWork({ ...lane(), since: -1 })).toBeUndefined()
  })

  it('refuses a role the kind does not take: a lane has no coordinator, a wave no lead', () => {
    expect(sanitizeWork(lane({ role: 'coordinator' }))).toBeUndefined()
    expect(sanitizeWork({ ...lane(), kind: 'wave', role: 'lead' })).toBeUndefined()
  })

  it('drops an invalid optional field alone, and a wave never belongs to a wave', () => {
    expect(sanitizeWork({ ...lane(), from: 'not-a-session-id' })).toEqual(lane())
    expect(sanitizeWork({ ...lane(), task: 'x'.repeat(81) })).toEqual(lane())
    const wave = sanitizeWork({ ...lane({ kind: 'wave', role: 'coordinator' }) })
    expect(wave).toBeDefined()
    expect(wave).not.toHaveProperty('wave')
    expect(wave).not.toHaveProperty('waveLabel')
  })
})

describe('applyWorkChange: assign', () => {
  it('needs a kind and a label for a new unit, and says so', () => {
    const s = store([{ id: ID.lead }])
    expect(() =>
      s.change(ID.lead, { type: 'assign', work: { unit: 'lane-a', role: 'lead' } })
    ).toThrow(/needs its kind/)
    expect(() =>
      s.change(ID.lead, { type: 'assign', work: { unit: 'lane-a', kind: 'lane', role: 'lead' } })
    ).toThrow(/needs its label/)
  })

  it('joins an existing unit from the unit key alone, taking its facts from a member', () => {
    const s = store([{ id: ID.lead, work: lane() }, { id: ID.verifier }])
    const [update] = s.change(ID.verifier, {
      type: 'assign',
      work: { unit: 'lane-a', role: 'verifier' }
    })
    expect(update.id).toBe(ID.verifier)
    expect(update.work).toMatchObject({
      unit: 'lane-a',
      kind: 'lane',
      label: 'Pair the phone',
      wave: 'wave-1',
      waveLabel: 'Mobile beta',
      role: 'verifier',
      standing: 'current'
    })
  })

  it('refuses a second current holder of an exclusive role unless told to replace', () => {
    const s = store([{ id: ID.lead, work: lane() }, { id: ID.next }])
    expect(() =>
      s.change(ID.next, { type: 'assign', work: { unit: 'lane-a', role: 'lead' } })
    ).toThrow(WorkChangeRefusal)
    expect(s.work(ID.next)).toBeUndefined()
    const updates = s.change(ID.next, {
      type: 'assign',
      work: { unit: 'lane-a', role: 'lead' },
      replace: true
    })
    expect(updates.map((u) => u.id)).toEqual([ID.next, ID.lead])
    expect(s.work(ID.next)).toMatchObject({ standing: 'current', from: ID.lead })
    expect(s.work(ID.lead)).toMatchObject({ standing: 'superseded' })
  })

  it('lets several workers hold the worker role at once', () => {
    const s = store([{ id: ID.lead, work: lane() }, { id: ID.worker }, { id: ID.other }])
    s.change(ID.worker, { type: 'assign', work: { unit: 'lane-a', role: 'worker', task: 'Spec' } })
    s.change(ID.other, { type: 'assign', work: { unit: 'lane-a', role: 'worker', task: 'Relay' } })
    expect([s.work(ID.worker)?.standing, s.work(ID.other)?.standing]).toEqual([
      'current',
      'current'
    ])
  })

  it('carries a new label to every member of the unit', () => {
    const s = store([
      { id: ID.lead, work: lane() },
      { id: ID.verifier, work: lane({ role: 'verifier', joinedAt: 20 }) }
    ])
    const updates = s.change(ID.lead, {
      type: 'assign',
      work: { unit: 'lane-a', role: 'lead', label: 'Pair a phone' }
    })
    expect(updates.map((u) => u.id).sort()).toEqual([ID.lead, ID.verifier].sort())
    expect(s.work(ID.verifier)?.label).toBe('Pair a phone')
    // The holder keeps its standing and its join time through an update.
    expect(s.work(ID.lead)).toMatchObject({ standing: 'current', joinedAt: 10, since: 10 })
  })

  it('refuses to move the current lead of one lane into another without a word', () => {
    const s = store([{ id: ID.lead, work: lane() }])
    expect(() =>
      s.change(ID.lead, {
        type: 'assign',
        work: { unit: 'lane-b', kind: 'lane', label: 'History', role: 'lead' }
      })
    ).toThrow(/hand that over or leave it/)
  })

  it('refuses a role the kind does not take, and a kind the unit is not', () => {
    const s = store([{ id: ID.lead, work: lane() }, { id: ID.next }])
    expect(() =>
      s.change(ID.next, { type: 'assign', work: { unit: 'lane-a', role: 'coordinator' } })
    ).toThrow(/held by a lead/)
    expect(() =>
      s.change(ID.next, { type: 'assign', work: { unit: 'lane-a', kind: 'wave', role: 'worker' } })
    ).toThrow(/cannot also be a wave/)
  })

  it('refuses an unknown session and text out of its limits', () => {
    const s = store([{ id: ID.lead }])
    expect(() =>
      s.change(ID.other, {
        type: 'assign',
        work: { unit: 'x', kind: 'lane', label: 'X', role: 'lead' }
      })
    ).toThrow(/No session/)
    expect(() =>
      s.change(ID.lead, {
        type: 'assign',
        work: { unit: 'x', kind: 'lane', label: 'x'.repeat(81), role: 'lead' }
      })
    ).toThrow(/label is 1 to 80/)
  })
})

describe('applyWorkChange: handover', () => {
  it('offers, then the successor accepts: one current lead at every step', () => {
    const s = store([{ id: ID.lead, work: lane() }, { id: ID.next }])
    const offered = s.change(ID.lead, { type: 'offer', to: ID.next })
    expect(offered).toEqual([
      {
        id: ID.next,
        work: expect.objectContaining({ standing: 'pending', from: ID.lead, role: 'lead' })
      }
    ])
    expect(s.work(ID.lead)?.standing).toBe('current')
    const accepted = s.change(ID.next, { type: 'accept' })
    expect(accepted.map((u) => u.id)).toEqual([ID.next, ID.lead])
    expect(s.work(ID.next)).toMatchObject({ standing: 'current', from: ID.lead })
    expect(s.work(ID.lead)?.standing).toBe('superseded')
  })

  it('keeps one successor at a time: a new offer withdraws the earlier one', () => {
    const s = store([{ id: ID.lead, work: lane() }, { id: ID.next }, { id: ID.third }])
    s.change(ID.lead, { type: 'offer', to: ID.next })
    const updates = s.change(ID.lead, { type: 'offer', to: ID.third })
    expect(updates).toEqual([
      { id: ID.third, work: expect.objectContaining({ standing: 'pending' }) },
      { id: ID.next, work: null }
    ])
  })

  it('cancels an offer, and refuses a cancel with nothing pending', () => {
    const s = store([{ id: ID.lead, work: lane() }, { id: ID.next }])
    s.change(ID.lead, { type: 'offer', to: ID.next })
    expect(s.change(ID.lead, { type: 'cancel' })).toEqual([{ id: ID.next, work: null }])
    expect(() => s.change(ID.lead, { type: 'cancel' })).toThrow(/No handover/)
  })

  it('refuses an offer from a tab that holds nothing now, to itself, or to an unknown tab', () => {
    const s = store([{ id: ID.lead, work: lane({ standing: 'superseded' }) }, { id: ID.next }])
    expect(() => s.change(ID.lead, { type: 'offer', to: ID.next })).toThrow(/holds a role now/)
    const t = store([{ id: ID.lead, work: lane() }])
    expect(() => t.change(ID.lead, { type: 'offer', to: ID.lead })).toThrow(/to itself/)
    expect(() => t.change(ID.lead, { type: 'offer', to: ID.other })).toThrow(/No session/)
    expect(() => t.change(ID.lead, { type: 'offer', to: 'parent' })).toThrow(/session id/)
  })

  it('refuses to hand a lane to the current lead of another lane', () => {
    const s = store([
      { id: ID.lead, work: lane() },
      { id: ID.next, work: lane({ unit: 'lane-b', label: 'History' }) }
    ])
    expect(() => s.change(ID.lead, { type: 'offer', to: ID.next })).toThrow(/cannot take/)
  })

  it('refuses an accept when someone else took the role meanwhile, unless told to replace', () => {
    const s = store([{ id: ID.lead, work: lane() }, { id: ID.next }, { id: ID.third }])
    s.change(ID.lead, { type: 'offer', to: ID.next })
    s.change(ID.third, { type: 'assign', work: { unit: 'lane-a', role: 'lead' }, replace: true })
    expect(() => s.change(ID.next, { type: 'accept' })).toThrow(/now held by/)
    s.change(ID.next, { type: 'accept', replace: true })
    expect(s.work(ID.next)?.standing).toBe('current')
    expect(s.work(ID.third)?.standing).toBe('superseded')
  })

  it('completes a pending handover whose holder is gone', () => {
    const s = store([{ id: ID.lead, work: lane() }, { id: ID.next }])
    s.change(ID.lead, { type: 'offer', to: ID.next })
    s.records.delete(ID.lead)
    expect(s.change(ID.next, { type: 'accept' })).toEqual([
      { id: ID.next, work: expect.objectContaining({ standing: 'current', from: ID.lead }) }
    ])
  })

  it('refuses an accept with nothing pending, a complete from a tab not current, a leave from none', () => {
    const s = store([{ id: ID.lead, work: lane() }, { id: ID.plain }])
    expect(() => s.change(ID.lead, { type: 'accept' })).toThrow(/no pending handover/)
    expect(() => s.change(ID.plain, { type: 'complete' })).toThrow(/no current assignment/)
    expect(() => s.change(ID.plain, { type: 'leave' })).toThrow(/no wave or lane/)
    expect(s.change(ID.lead, { type: 'complete' })).toEqual([
      { id: ID.lead, work: expect.objectContaining({ standing: 'completed' }) }
    ])
    expect(s.change(ID.lead, { type: 'leave' })).toEqual([{ id: ID.lead, work: null }])
  })
})

describe('deriveWorkUnits', () => {
  const view = (records: WorkRecord[]): ReturnType<typeof deriveWorkUnits>[number] => {
    const units = deriveWorkUnits(records)
    expect(units).toHaveLength(1)
    return units[0]
  }

  it('reads a held lane with its reviewer, workers, pending successor and history', () => {
    const v = view([
      { id: ID.lead, work: lane({ standing: 'superseded', since: 30 }) },
      { id: ID.next, work: lane({ joinedAt: 20, since: 30, from: ID.lead }) },
      { id: ID.third, work: lane({ joinedAt: 40, since: 40, standing: 'pending', from: ID.next }) },
      { id: ID.verifier, work: lane({ role: 'verifier', joinedAt: 15 }) },
      { id: ID.worker, work: lane({ role: 'worker', task: 'Spec', joinedAt: 16 }) },
      { id: ID.plain }
    ])
    expect(v.owner).toEqual({ state: 'held', id: ID.next })
    expect(v.reviewer).toEqual({ state: 'held', id: ID.verifier })
    expect(v.workers).toEqual([ID.worker])
    expect(v.pending).toEqual([{ id: ID.third, role: 'lead', from: ID.next }])
    expect(v.history).toEqual([
      { id: ID.lead, role: 'lead', standing: 'superseded', since: 30, successor: ID.next }
    ])
    expect(v.members).toEqual([ID.lead, ID.verifier, ID.worker, ID.next, ID.third])
    expect(v.wave).toEqual({ unit: 'wave-1', label: 'Mobile beta' })
  })

  it('says unresolved when two sessions hold the lead, and never picks the newest', () => {
    // Only a partial write leaves this behind; the rule refuses to make it.
    const v = view([
      { id: ID.lead, work: lane({ joinedAt: 10, since: 10, label: 'Old label' }) },
      { id: ID.next, work: lane({ joinedAt: 50, since: 99, label: 'Newest label' }) }
    ])
    expect(v.owner).toEqual({
      state: 'unresolved',
      reason: 'several',
      candidates: [ID.lead, ID.next]
    })
    expect(v.label).toBe('Old label')
  })

  it('says a handover was not accepted when only a pending successor is left', () => {
    const v = view([{ id: ID.next, work: lane({ standing: 'pending', from: ID.lead }) }])
    expect(v.owner).toEqual({ state: 'unresolved', reason: 'not-accepted', candidates: [ID.next] })
  })

  it('says nobody leads when only superseded leads are left, and a superseded verifier is a vacancy', () => {
    const v = view([
      { id: ID.lead, work: lane({ standing: 'superseded' }) },
      { id: ID.verifier, work: lane({ role: 'verifier', standing: 'superseded' }) }
    ])
    expect(v.owner).toEqual({ state: 'unresolved', reason: 'no-current', candidates: [ID.lead] })
    expect(v.reviewer).toEqual({ state: 'vacant' })
  })

  it('reads a completed lane as completed, not as unresolved', () => {
    const v = view([{ id: ID.lead, work: lane({ standing: 'completed', since: 70 }) }])
    expect(v.owner).toEqual({ state: 'completed', id: ID.lead })
  })

  it('reads a wave held by its coordinator, and leaves sessions without work out', () => {
    const units = deriveWorkUnits([
      { id: ID.lead, work: { ...lane({ kind: 'wave', role: 'coordinator' }), unit: 'wave-1' } },
      { id: ID.plain },
      { id: ID.other, work: { garbage: true } as unknown as WorkAssignment }
    ])
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({
      kind: 'wave',
      ownerRole: 'coordinator',
      owner: { state: 'held', id: ID.lead }
    })
    expect(units[0]).not.toHaveProperty('wave')
  })
})

describe('takeoverRenames', () => {
  const names: Record<string, string> = { [ID.lead]: 'Lane A · lead', [ID.next]: 'Successor' }
  const nameOf = (id: string): string | undefined => names[id]

  it('gives the successor its predecessor’s name and the predecessor its generation, predecessor first', () => {
    const s = store([{ id: ID.lead, work: lane() }, { id: ID.next }, { id: ID.third }])
    s.change(ID.lead, { type: 'offer', to: ID.next })
    const before = s.all()
    const updates = s.change(ID.next, { type: 'accept' })
    expect(takeoverRenames(before, updates, ID.next, { type: 'accept' }, nameOf)).toEqual([
      { id: ID.lead, name: 'Lane A · lead · gen 1' },
      { id: ID.next, name: 'Lane A · lead' }
    ])
    // The next handover is the second generation.
    s.change(ID.next, { type: 'offer', to: ID.third })
    const again = s.all()
    const second = s.change(ID.third, { type: 'accept' })
    expect(
      takeoverRenames(again, second, ID.third, { type: 'accept' }, (id) =>
        id === ID.next ? 'Lane A · lead' : undefined
      )
    ).toEqual([
      { id: ID.next, name: 'Lane A · lead · gen 2' },
      { id: ID.third, name: 'Lane A · lead' }
    ])
  })

  it('renames nothing for a replace, an accept whose holder is gone, or a name not known', () => {
    const s = store([{ id: ID.lead, work: lane() }, { id: ID.next }])
    const before = s.all()
    const replaced = s.change(ID.next, {
      type: 'assign',
      work: { unit: 'lane-a', role: 'lead' },
      replace: true
    })
    expect(
      takeoverRenames(
        before,
        replaced,
        ID.next,
        { type: 'assign', work: { unit: 'lane-a', role: 'lead' }, replace: true },
        nameOf
      )
    ).toEqual([])
    const t = store([{ id: ID.lead, work: lane() }, { id: ID.next }])
    t.change(ID.lead, { type: 'offer', to: ID.next })
    t.records.delete(ID.lead)
    const gone = t.all()
    const accepted = t.change(ID.next, { type: 'accept' })
    expect(takeoverRenames(gone, accepted, ID.next, { type: 'accept' }, nameOf)).toEqual([])
    const u = store([{ id: ID.lead, work: lane() }, { id: ID.next }])
    u.change(ID.lead, { type: 'offer', to: ID.next })
    const known = u.all()
    const done = u.change(ID.next, { type: 'accept' })
    expect(takeoverRenames(known, done, ID.next, { type: 'accept' }, () => undefined)).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import {
  applyNest,
  nestedUnder,
  nestRefusal,
  NestRefusal,
  NestSessionUnknown,
  type NestRecord
} from './nest-rules'

// Session ids are UUIDs on the records; these read as their part in a test.
const ID = {
  lead: '00000000-0000-4000-8000-000000000001',
  old: '00000000-0000-4000-8000-000000000002',
  older: '00000000-0000-4000-8000-000000000003',
  page: '00000000-0000-4000-8000-000000000004',
  other: '00000000-0000-4000-8000-000000000005',
  ghost: '00000000-0000-4000-8000-00000000000f'
} as const

const tab = (id: string, over: Partial<NestRecord> = {}): NestRecord => ({
  id,
  workspaceId: 'ws',
  windowKey: 'w1',
  ...over
})

const plain = (): NestRecord[] => [tab(ID.lead), tab(ID.old), tab(ID.older), tab(ID.page)]

describe('nesting a tab under another', () => {
  it('nests a tab that stood alone, and says the record changed', () => {
    expect(applyNest(plain(), ID.old, ID.lead)).toEqual({
      id: ID.old,
      under: ID.lead,
      changed: true
    })
  })

  it('says nothing changed when the record already names that tab', () => {
    const all = [tab(ID.lead), tab(ID.old, { under: ID.lead })]
    expect(applyNest(all, ID.old, ID.lead).changed).toBe(false)
  })

  it('moves a nested tab under another tab in one step', () => {
    const all = [tab(ID.lead), tab(ID.other), tab(ID.old, { under: ID.lead })]
    expect(applyNest(all, ID.old, ID.other)).toEqual({
      id: ID.old,
      under: ID.other,
      changed: true
    })
  })

  it('keeps the tab a nested tab is dropped under as it was named, however deep', () => {
    const all = [tab(ID.lead), tab(ID.old, { under: ID.lead }), tab(ID.older)]
    expect(applyNest(all, ID.older, ID.old).under).toBe(ID.old)
  })

  it('takes a tab out, and is a no-op on a tab that stood alone', () => {
    const all = [tab(ID.lead), tab(ID.old, { under: ID.lead }), tab(ID.older)]
    expect(applyNest(all, ID.old, null)).toEqual({ id: ID.old, under: null, changed: true })
    expect(applyNest(all, ID.older, null)).toEqual({ id: ID.older, under: null, changed: false })
  })

  it('takes out a tab whose record points at a tab that is gone', () => {
    const all = [tab(ID.old, { under: ID.ghost })]
    expect(applyNest(all, ID.old, null)).toEqual({ id: ID.old, under: null, changed: true })
  })

  it('answers not-found for a subject or a target nobody knows', () => {
    expect(() => applyNest(plain(), ID.ghost, ID.lead)).toThrow(NestSessionUnknown)
    expect(() => applyNest(plain(), ID.old, ID.ghost)).toThrow(NestSessionUnknown)
    expect(() => applyNest(plain(), ID.ghost, null)).toThrow(NestSessionUnknown)
  })
})

describe('what the rule refuses', () => {
  const refused = (all: NestRecord[], id: string, under: string): string => {
    expect(() => applyNest(all, id, under)).toThrow(NestRefusal)
    return nestRefusal(all, id, under) ?? ''
  }

  it('a tab under itself', () => {
    expect(refused(plain(), ID.lead, ID.lead)).toBe('A tab cannot be nested under itself')
  })

  it('a tab under one of the tabs nested under it, at any depth', () => {
    const all = [
      tab(ID.lead),
      tab(ID.old, { under: ID.lead }),
      tab(ID.older, { under: ID.old }),
      tab(ID.other)
    ]
    expect(refused(all, ID.lead, ID.old)).toMatch(/nested under this one/)
    expect(refused(all, ID.lead, ID.older)).toMatch(/nested under this one/)
    // A sibling branch is no loop.
    expect(nestRefusal(all, ID.older, ID.other)).toBeNull()
    expect(nestRefusal(all, ID.other, ID.older)).toBeNull()
  })

  it('a session that is no tab of the sidebar, on either side', () => {
    const all = [tab(ID.lead), tab(ID.page, { hidden: true })]
    expect(refused(all, ID.page, ID.lead)).toMatch(/only a tab can be nested/)
    expect(refused(all, ID.lead, ID.page)).toMatch(/nested under another tab/)
  })

  it('a tab that works on a wave or a lane, naming it and the way out', () => {
    const all = [tab(ID.lead), tab(ID.old, { work: { label: 'Pair the phone', kind: 'lane' } })]
    const words = refused(all, ID.old, ID.lead)
    expect(words).toContain('the lane "Pair the phone"')
    expect(words).toContain('clave_set_work')
    // A member of a unit takes tabs under it: its entry lists them.
    expect(nestRefusal(all, ID.lead, ID.old)).toBeNull()
  })

  it('two tabs of different workspaces, an absent workspace being one of its own', () => {
    const all = [
      tab(ID.lead),
      tab(ID.old, { workspaceId: 'elsewhere' }),
      tab(ID.older, { workspaceId: null })
    ]
    expect(refused(all, ID.old, ID.lead)).toMatch(/different workspaces/)
    expect(refused(all, ID.older, ID.lead)).toMatch(/different workspaces/)
    const none = [tab(ID.lead, { workspaceId: undefined }), tab(ID.old, { workspaceId: null })]
    expect(nestRefusal(none, ID.old, ID.lead)).toBeNull()
  })

  it('two tabs of different windows', () => {
    const all = [tab(ID.lead), tab(ID.old, { windowKey: 'w2' })]
    expect(refused(all, ID.old, ID.lead)).toMatch(/different windows/)
  })

  it('never a loop the records already hold: the walk ends without a verdict', () => {
    const all = [
      tab(ID.lead, { under: ID.old }),
      tab(ID.old, { under: ID.lead }),
      tab(ID.older),
      tab(ID.other)
    ]
    expect(nestRefusal(all, ID.older, ID.lead)).toBeNull()
    expect(nestRefusal(all, ID.other, ID.old)).toBeNull()
  })

  it('nothing when a tab is taken out, whatever it is', () => {
    const all = [
      tab(ID.page, { hidden: true, under: ID.ghost, work: { label: 'x', kind: 'wave' } })
    ]
    expect(nestRefusal(all, ID.page, null)).toBeNull()
  })
})

describe('the tabs shown under a tab', () => {
  it('lists every session whose links lead up to it, the nearest first', () => {
    const all = [
      tab(ID.older, { under: ID.old }),
      tab(ID.lead),
      tab(ID.old, { under: ID.lead }),
      tab(ID.page, { under: ID.lead }),
      tab(ID.other)
    ]
    expect(nestedUnder(all, ID.lead)).toEqual([ID.old, ID.page, ID.older])
    expect(nestedUnder(all, ID.old)).toEqual([ID.older])
    expect(nestedUnder(all, ID.other)).toEqual([])
  })

  it('reads a loop and a self-link as nothing more than once', () => {
    const all = [
      tab(ID.lead, { under: ID.old }),
      tab(ID.old, { under: ID.lead }),
      tab(ID.page, { under: ID.page })
    ]
    expect(nestedUnder(all, ID.lead)).toEqual([ID.old])
    expect(nestedUnder(all, ID.page)).toEqual([])
  })
})

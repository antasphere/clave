import { describe, it, expect } from 'vitest'
import {
  mergeLayoutForKeys,
  absorbLayout,
  placeAdopted,
  type LayoutGroupLike,
  type LayoutSessionLike
} from './sidebar-layout-partition'

const A = 'ws-a'
const B = 'ws-b'
const g = (
  id: string,
  sessionIds: string[],
  workspaceId?: string,
  terminals: { sessionId: string | null }[] = []
): LayoutGroupLike => ({
  id,
  sessionIds,
  terminals,
  ...(workspaceId ? { workspaceId } : {})
})
const s = (id: string, workspaceId?: string): LayoutSessionLike => ({
  id,
  ...(workspaceId ? { workspaceId } : {})
})

describe('mergeLayoutForKeys', () => {
  const store = {
    groups: [g('gA', ['sA'], A), g('gB-old', ['sB-old'], B)],
    displayOrder: ['gA', 'sA2', 'gB-old', 'sB-free'],
    sessions: [s('sA', A), s('sA2', A), s('sB-free', B)]
  }

  it('replaces only the merged workspace and leaves the others untouched', () => {
    const out = mergeLayoutForKeys(
      store,
      [B],
      { groups: [g('gB-new', ['sB1', 'sB2'], B)], displayOrder: ['gB-new', 'sB-free'] },
      ['sB1', 'sB-free']
    )
    expect(out.groups.map((x) => x.id)).toEqual(['gA', 'gB-new'])
    expect(out.groups[1].sessionIds).toEqual(['sB1'])
    expect(out.displayOrder).toEqual(['gA', 'sA2', 'gB-new', 'sB-free'])
  })

  it('keeps a group whose members survive ELSEWHERE as a shell (no truncation)', () => {
    const out = mergeLayoutForKeys(
      { groups: [], displayOrder: [], sessions: [] },
      [B],
      { groups: [g('gB', ['hosted-elsewhere'], B)], displayOrder: ['gB'] },
      ['hosted-elsewhere']
    )
    expect(out.groups.map((x) => x.id)).toEqual(['gB'])
    expect(out.displayOrder).toEqual(['gB'])
  })

  // A group whose members are all gone comes back EMPTY, in its place. It used
  // to be pruned, which is how closing a group's last tab made the group
  // vanish after the next launch; an empty group is a normal state now (the
  // sidebar draws it as a "No sessions" row) and only Delete / Ungroup remove it.
  it('keeps a group whose members are gone everywhere as an empty group, and detaches its dead terminal', () => {
    const out = mergeLayoutForKeys(
      { groups: [], displayOrder: [], sessions: [] },
      [B],
      {
        groups: [g('emptied', ['gone'], B), g('live', ['ok'], B, [{ sessionId: 'gone-term' }])],
        displayOrder: ['emptied', 'live']
      },
      ['ok']
    )
    expect(out.groups.map((x) => x.id)).toEqual(['emptied', 'live'])
    expect(out.groups[0].sessionIds).toEqual([])
    expect(out.groups[1].terminals).toEqual([{ sessionId: null }])
    expect(out.displayOrder).toEqual(['emptied', 'live'])
  })

  // ── PRDCT-1756: the group-drop that orphaned a running dev server. A group
  //    whose members did not come back was pruned outright, which un-nested
  //    its quick-launch terminal and dropped it at the top level as a tab
  //    nobody recognised. A live terminal now keeps its group. ──
  it('keeps a group whose only survivor is a RUNNING quick-launch terminal', () => {
    const out = mergeLayoutForKeys(
      { groups: [], displayOrder: [], sessions: [s('devserver', B)] },
      [B],
      {
        groups: [g('gB', ['agent-gone'], B, [{ sessionId: 'devserver' }])],
        displayOrder: ['gB']
      },
      ['devserver']
    )
    expect(out.groups.map((x) => x.id)).toEqual(['gB'])
    expect(out.groups[0].sessionIds).toEqual([])
    expect(out.groups[0].terminals).toEqual([{ sessionId: 'devserver' }])
    // and the terminal's session is NOT a top-level row
    expect(out.displayOrder).toEqual(['gB'])
  })

  it('keeps a group with no members and no running terminal, its dead terminal detached', () => {
    const out = mergeLayoutForKeys(
      { groups: [], displayOrder: [], sessions: [] },
      [B],
      {
        groups: [g('gB', ['agent-gone'], B, [{ sessionId: 'term-gone' }])],
        displayOrder: ['gB']
      },
      []
    )
    expect(out.groups).toEqual([g('gB', [], B, [{ sessionId: null }])])
    expect(out.displayOrder).toEqual(['gB'])
  })

  it('never surfaces a nested session at the top level, appends missed standalone sessions', () => {
    const out = mergeLayoutForKeys(
      { groups: [], displayOrder: [], sessions: [s('in-group', B), s('standalone', B)] },
      [B],
      { groups: [g('gB', ['in-group'], B)], displayOrder: ['in-group', 'gB'] },
      ['in-group', 'standalone']
    )
    expect(out.displayOrder).toEqual(['gB', 'standalone'])
  })

  it('drops stale ids of the merged workspace from the old order', () => {
    const out = mergeLayoutForKeys(
      { groups: [], displayOrder: ['ghost'], sessions: [] },
      [B],
      { groups: [], displayOrder: [] },
      []
    )
    expect(out.displayOrder).toEqual([])
  })

  // ── The F1 seam: taking a string workspace must NEVER claim, and then drop
  //    from an empty file, an UNSTAMPED store group. Registering the first
  //    workspace fired takeLayouts([W]) while the groups were still unstamped;
  //    ownership by `?? fallback`(=W) then rebuilt W from its empty file and
  //    dropped them. Ownership is by explicit stamp: an unstamped group is the
  //    null partition's, never a string key's. ──
  it('taking a string workspace keeps unstamped store groups untouched (F1)', () => {
    const out = mergeLayoutForKeys(
      {
        groups: [g('orphan-one', ['o1']), g('orphan-two', ['o2'])], // UNSTAMPED
        displayOrder: ['orphan-one', 'orphan-two'],
        sessions: [s('o1'), s('o2')] // unstamped sessions
      },
      [A], // taking workspace A, whose file is empty
      { groups: [], displayOrder: [] }, // empty file — the destructive input
      [] // nothing "surviving" for A
    )
    expect(out.groups.map((x) => x.id)).toEqual(['orphan-one', 'orphan-two'])
    expect(out.displayOrder).toEqual(['orphan-one', 'orphan-two'])
  })

  it('an unstamped live group already written to the file comes back ONCE (live copy wins)', () => {
    // F1 follow-up: the unstamped group was persisted into A's file by the
    // write fallback; re-taking A must not produce a second object with its id.
    const out = mergeLayoutForKeys(
      {
        groups: [g('shared', ['o1', 'o2'])], // UNSTAMPED, live, two rows
        displayOrder: ['shared'],
        sessions: [s('o1'), s('o2')]
      },
      [A],
      { groups: [g('shared', ['o1'])], displayOrder: ['shared'] }, // the file's older copy
      ['o1', 'o2']
    )
    expect(out.groups.map((x) => x.id)).toEqual(['shared'])
    expect(out.groups[0].sessionIds).toEqual(['o1', 'o2'])
    expect(out.displayOrder).toEqual(['shared'])
  })

  it('merging the NULL key does own unstamped groups (no-workspace boot)', () => {
    const out = mergeLayoutForKeys(
      { groups: [], displayOrder: [], sessions: [s('u1')] },
      [null], // the unscoped partition
      { groups: [g('gN', ['u1'])], displayOrder: ['gN'] }, // its file
      ['u1']
    )
    expect(out.groups.map((x) => x.id)).toEqual(['gN'])
  })
})

describe("absorbLayout — taking in another window's groups", () => {
  const store = {
    groups: [g('g1', ['s1'], A)],
    displayOrder: ['g1', 's-free']
  }

  it('appends unknown groups and unplaced order entries, in incoming order', () => {
    const out = absorbLayout(store, {
      groups: [g('g2', ['s2'], A), g('g3', ['s3'], B)],
      displayOrder: ['g3', 'g2', 's-other']
    })
    expect(out.groups.map((x) => x.id)).toEqual(['g1', 'g2', 'g3'])
    expect(out.displayOrder).toEqual(['g1', 's-free', 'g3', 'g2', 's-other'])
  })

  it('leaves a known group exactly as it is (the store wins over the handover)', () => {
    const out = absorbLayout(store, {
      groups: [g('g1', ['s1', 's9'], B)],
      displayOrder: ['g1']
    })
    expect(out.groups).toEqual(store.groups)
    expect(out.displayOrder).toEqual(store.displayOrder)
  })

  it('never surfaces at the top level an id nested in a group', () => {
    const out = absorbLayout(store, {
      groups: [g('g2', ['s2'], A, [{ sessionId: 't2' }])],
      displayOrder: ['s2', 't2', 'g2', 's1']
    })
    expect(out.displayOrder).toEqual(['g1', 's-free', 'g2'])
  })

  it('tolerates a malformed handover', () => {
    const out = absorbLayout(store, {
      groups: [{ id: 'g2' } as unknown as LayoutGroupLike, null as unknown as LayoutGroupLike],
      displayOrder: ['g2', 7 as unknown as string]
    })
    expect(out.groups.map((x) => x.id)).toEqual(['g1', 'g2'])
    expect(out.groups[1].sessionIds).toEqual([])
    expect(out.displayOrder).toEqual(['g1', 's-free', 'g2'])
  })

  it('is a no-op for an empty handover', () => {
    expect(absorbLayout(store, {})).toEqual(store)
  })
})

describe('placeAdopted — an adopted tab never lands twice, never in a foreign group', () => {
  const state = {
    groups: [g('g1', ['s1'], A, [{ sessionId: 't1' }])],
    displayOrder: ['g1', 's-free'],
    sessions: [s('s1'), s('s-free'), { id: 's-viewer', view: { serverSessionId: 'srv' } }]
  }

  it('appends a tab nothing holds to the top level', () => {
    expect(placeAdopted(state, 's-new')).toEqual(['g1', 's-free', 's-new'])
  })

  it("leaves a group's member where it is (no top-level duplicate)", () => {
    expect(placeAdopted(state, 's1')).toEqual(['g1', 's-free'])
  })

  it("leaves a group's quick-launch terminal hidden", () => {
    expect(placeAdopted(state, 't1')).toEqual(['g1', 's-free'])
  })

  it("leaves a session view's hidden server hidden", () => {
    expect(placeAdopted(state, 'srv')).toEqual(['g1', 's-free'])
  })

  it('is idempotent for a tab already at the top level', () => {
    expect(placeAdopted(state, 's-free')).toEqual(['g1', 's-free'])
  })
})

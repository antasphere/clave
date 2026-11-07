import { describe, it, expect } from 'vitest'
import {
  partitionLegacyLayout,
  mergeLayouts,
  concatLayouts,
  type PartitionContext
} from './sidebar-layout-migration'

const A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const B = 'bbbbbbbb-0000-4000-8000-00000000000b'

const ctx = (over: Partial<PartitionContext> = {}): PartitionContext => ({
  workspaceIds: [A, B],
  fallbackWorkspaceId: A,
  resolveWorkspaceForCwd: (cwd: string) =>
    cwd.startsWith('/roots/b') ? B : cwd.startsWith('/roots/a') ? A : null,
  resolveWorkspaceForSession: (id: string) => (id === 'sess-b' ? B : id === 'sess-a' ? A : null),
  ...over
})

const group = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: id,
  sessionIds: [],
  collapsed: false,
  cwd: null,
  terminals: [],
  ...extra
})

describe('partitionLegacyLayout — where each group lands', () => {
  it('a stamped group goes to its workspace', () => {
    const out = partitionLegacyLayout(
      { groups: [group('g1', { workspaceId: B })], displayOrder: ['g1'] },
      ctx()
    )
    expect([...out.keys()]).toEqual([B])
    expect(out.get(B)!.groups).toHaveLength(1)
    expect(out.get(B)!.displayOrder).toEqual(['g1'])
  })

  it('an unstamped group with a cwd goes to the workspace whose root contains it', () => {
    const out = partitionLegacyLayout(
      { groups: [group('g1', { cwd: '/roots/b/repo' })], displayOrder: ['g1'] },
      ctx()
    )
    expect(out.get(B)!.groups.map((g) => (g as { id: string }).id)).toEqual(['g1'])
    expect(out.has(A)).toBe(false)
  })

  it('an unstamped group whose cwd is under no root goes to the fallback', () => {
    const out = partitionLegacyLayout(
      { groups: [group('g1', { cwd: '/elsewhere' })], displayOrder: ['g1'] },
      ctx({ fallbackWorkspaceId: B })
    )
    expect(out.get(B)!.groups).toHaveLength(1)
  })

  it('an unstamped group with no cwd goes to the fallback', () => {
    const out = partitionLegacyLayout({ groups: [group('g1')], displayOrder: ['g1'] }, ctx())
    expect(out.get(A)!.groups).toHaveLength(1)
  })

  it('a group stamped with an UNREGISTERED workspace is re-placed by cwd, then fallback', () => {
    const out = partitionLegacyLayout(
      {
        groups: [
          group('g1', { workspaceId: 'gone', cwd: '/roots/b/x' }),
          group('g2', { workspaceId: 'gone' })
        ],
        displayOrder: ['g1', 'g2']
      },
      ctx()
    )
    expect(out.get(B)!.groups.map((g) => (g as { id: string }).id)).toEqual(['g1'])
    expect(out.get(A)!.groups.map((g) => (g as { id: string }).id)).toEqual(['g2'])
  })

  it('every group is stamped with the workspace it landed in', () => {
    const out = partitionLegacyLayout(
      { groups: [group('g1', { cwd: '/roots/b/x' }), group('g2')], displayOrder: [] },
      ctx()
    )
    expect((out.get(B)!.groups[0] as { workspaceId: string }).workspaceId).toBe(B)
    expect((out.get(A)!.groups[0] as { workspaceId: string }).workspaceId).toBe(A)
  })

  it('every group lands in exactly one partition — the sum equals the input', () => {
    const groups = [
      group('g1', { workspaceId: A }),
      group('g2', { workspaceId: B }),
      group('g3', { cwd: '/roots/b/y' }),
      group('g4')
    ]
    const out = partitionLegacyLayout({ groups, displayOrder: [] }, ctx())
    const landed = [...out.values()].flatMap((l) => l.groups.map((g) => (g as { id: string }).id))
    expect(landed.sort()).toEqual(['g1', 'g2', 'g3', 'g4'])
  })

  it('a duplicated group id is kept once', () => {
    const out = partitionLegacyLayout(
      {
        groups: [group('g1', { workspaceId: A }), group('g1', { workspaceId: B })],
        displayOrder: []
      },
      ctx()
    )
    expect(out.get(A)!.groups).toHaveLength(1)
    expect(out.has(B)).toBe(false)
  })

  it('malformed entries (no string id) are dropped, not crashed on', () => {
    const out = partitionLegacyLayout(
      { groups: [null, 42, { name: 'no id' }, group('ok', { workspaceId: B })], displayOrder: [] },
      ctx()
    )
    expect(out.get(B)!.groups).toHaveLength(1)
    expect(out.size).toBe(1)
  })
})

describe('partitionLegacyLayout — displayOrder follows its items', () => {
  it('a group id follows its group, a session id follows its record, order is preserved', () => {
    const out = partitionLegacyLayout(
      {
        groups: [group('gA', { workspaceId: A }), group('gB', { workspaceId: B })],
        displayOrder: ['sess-b', 'gA', 'sess-a', 'gB', 'sess-unknown']
      },
      ctx()
    )
    expect(out.get(A)!.displayOrder).toEqual(['gA', 'sess-a', 'sess-unknown'])
    expect(out.get(B)!.displayOrder).toEqual(['sess-b', 'gB'])
  })

  it('a session id whose record names an unregistered workspace goes to the fallback', () => {
    const out = partitionLegacyLayout(
      { groups: [], displayOrder: ['s1'] },
      ctx({ resolveWorkspaceForSession: () => 'gone', fallbackWorkspaceId: B })
    )
    expect(out.get(B)!.displayOrder).toEqual(['s1'])
  })

  it('duplicate and non-string order ids are dropped', () => {
    const out = partitionLegacyLayout(
      { groups: [], displayOrder: ['sess-a', 'sess-a', 7 as unknown as string] },
      ctx()
    )
    expect(out.get(A)!.displayOrder).toEqual(['sess-a'])
  })

  it('tolerates a legacy file with missing arrays', () => {
    const out = partitionLegacyLayout(
      { groups: undefined as unknown as unknown[], displayOrder: undefined as unknown as string[] },
      ctx()
    )
    expect(out.size).toBe(0)
  })
})

describe('mergeLayouts — an existing per-workspace file wins', () => {
  it('appends only unknown groups and order ids', () => {
    const merged = mergeLayouts(
      { groups: [group('g1', { name: 'kept' })], displayOrder: ['g1', 's1'] },
      { groups: [group('g1', { name: 'legacy' }), group('g2')], displayOrder: ['g2', 's1', 's2'] }
    )
    expect(merged.groups.map((g) => (g as { id: string; name: string }).name)).toEqual([
      'kept',
      'g2'
    ])
    expect(merged.displayOrder).toEqual(['g1', 's1', 'g2', 's2'])
  })

  it('an empty existing file takes the incoming layout whole', () => {
    const merged = mergeLayouts(
      { groups: [], displayOrder: [] },
      { groups: [group('g1')], displayOrder: ['g1', 's'] }
    )
    expect(merged.groups).toHaveLength(1)
    expect(merged.displayOrder).toEqual(['g1', 's'])
  })
})

describe('concatLayouts — the in-memory shape of several workspaces', () => {
  it('concatenates in input order and deduplicates ids', () => {
    const out = concatLayouts([
      { groups: [group('gA')], displayOrder: ['gA', 'x'] },
      { groups: [group('gB'), group('gA')], displayOrder: ['gB', 'x'] }
    ])
    expect(out.groups.map((g) => (g as { id: string }).id)).toEqual(['gA', 'gB'])
    expect(out.displayOrder).toEqual(['gA', 'x', 'gB'])
  })

  it('is empty for no inputs', () => {
    expect(concatLayouts([])).toEqual({ groups: [], displayOrder: [] })
  })
})

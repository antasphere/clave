import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

import {
  SidebarLayoutManager,
  LEGACY_LAYOUT_FILE,
  LAYOUTS_DIR,
  WINDOW_LAYOUTS_DIR,
  MIGRATED_BACKUP_SUFFIX
} from './sidebar-layout-manager'

/**
 * One layout file per window, and the one-shot migration of the two older
 * shapes into the first window's file. A migration that drops a group is the
 * classic silent defect — the user finds an empty sidebar and no error.
 */
let dir: string
let mgr: SidebarLayoutManager

const group = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  sessionIds: [`s-${id}`],
  terminals: [],
  ...extra
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-layouts-'))
  mgr = new SidebarLayoutManager(dir)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('per-window files', () => {
  it('round-trips a window layout and reads empty for an unknown window', () => {
    mgr.saveForWindow('w1', { groups: [group('g1')], displayOrder: ['g1'] })
    expect(mgr.loadForWindow('w1')).toEqual({ groups: [group('g1')], displayOrder: ['g1'] })
    expect(mgr.loadForWindow('w2')).toEqual({ groups: [], displayOrder: [] })
    expect(fs.existsSync(path.join(dir, LAYOUTS_DIR, WINDOW_LAYOUTS_DIR, 'w1.json'))).toBe(true)
  })

  it('refuses a key that could escape the directory', () => {
    expect(mgr.saveForWindow('../x', { groups: [], displayOrder: [] })).toBe(false)
    expect(mgr.fileForWindow('a/b')).toBeNull()
  })

  it('deleteForWindow removes the file and tolerates a missing one', () => {
    mgr.saveForWindow('w1', { groups: [group('g1')], displayOrder: ['g1'] })
    mgr.deleteForWindow('w1')
    mgr.deleteForWindow('w1')
    expect(mgr.loadForWindow('w1')).toEqual({ groups: [], displayOrder: [] })
  })

  it('orphans are the files of windows nobody knows; taking them removes them', () => {
    mgr.saveForWindow('live', { groups: [group('g1')], displayOrder: ['g1'] })
    mgr.saveForWindow('gone-a', { groups: [group('g2')], displayOrder: ['g2'] })
    mgr.saveForWindow('gone-b', { groups: [group('g3'), group('g2')], displayOrder: ['g3'] })
    expect(mgr.orphanKeys(new Set(['live'])).sort()).toEqual(['gone-a', 'gone-b'])
    const taken = mgr.takeOrphans(new Set(['live']))
    expect(taken.groups.map((g) => (g as { id: string }).id)).toEqual(['g2', 'g3'])
    expect(taken.displayOrder).toEqual(['g2', 'g3'])
    expect(mgr.orphanKeys(new Set(['live']))).toEqual([])
    expect(mgr.loadForWindow('live').groups.length).toBe(1)
  })

  it('takeOrphans with nothing to take returns empty and touches nothing', () => {
    mgr.saveForWindow('live', { groups: [group('g1')], displayOrder: ['g1'] })
    expect(mgr.takeOrphans(new Set(['live']))).toEqual({ groups: [], displayOrder: [] })
    expect(mgr.loadForWindow('live').groups.length).toBe(1)
  })
})

describe('migrateIntoWindow — the two older shapes into the first window', () => {
  const ctx = {
    workspaceIds: ['A', 'B'],
    fallbackWorkspaceId: 'A',
    resolveWorkspaceForCwd: (cwd: string): string | null => (cwd.startsWith('/b/') ? 'B' : null),
    resolveWorkspaceForSession: (): string | null => null
  }

  it('does nothing when there is nothing to migrate', () => {
    expect(mgr.migrateIntoWindow('w1', ctx)).toBe(0)
    expect(mgr.loadForWindow('w1')).toEqual({ groups: [], displayOrder: [] })
  })

  it('takes the legacy single file, stamping unstamped groups by cwd, and parks it', () => {
    fs.writeFileSync(
      path.join(dir, LEGACY_LAYOUT_FILE),
      JSON.stringify({
        groups: [group('g1', { workspaceId: 'A' }), group('g2', { cwd: '/b/x' }), group('g3')],
        displayOrder: ['g1', 'g2', 'g3']
      })
    )
    expect(mgr.migrateIntoWindow('w1', ctx)).toBe(1)
    const out = mgr.loadForWindow('w1')
    const byId = new Map(
      out.groups.map((g) => [(g as { id: string }).id, g as { workspaceId?: string }])
    )
    expect([...byId.keys()].sort()).toEqual(['g1', 'g2', 'g3'])
    expect(byId.get('g1')!.workspaceId).toBe('A')
    expect(byId.get('g2')!.workspaceId).toBe('B')
    expect(byId.get('g3')!.workspaceId).toBe('A')
    expect(new Set(out.displayOrder)).toEqual(new Set(['g1', 'g2', 'g3']))
    expect(fs.existsSync(path.join(dir, LEGACY_LAYOUT_FILE))).toBe(false)
    expect(fs.existsSync(path.join(dir, `${LEGACY_LAYOUT_FILE}${MIGRATED_BACKUP_SUFFIX}`))).toBe(
      true
    )
  })

  it('takes the legacy file as is when no workspace is registered', () => {
    fs.writeFileSync(
      path.join(dir, LEGACY_LAYOUT_FILE),
      JSON.stringify({ groups: [group('g1')], displayOrder: ['g1'] })
    )
    expect(mgr.migrateIntoWindow('w1', null)).toBe(1)
    expect(mgr.loadForWindow('w1')).toEqual({ groups: [group('g1')], displayOrder: ['g1'] })
  })

  it('folds the per-workspace files of the halted build in too, deduplicated, and parks them', () => {
    fs.mkdirSync(path.join(dir, LAYOUTS_DIR), { recursive: true })
    fs.writeFileSync(
      path.join(dir, LEGACY_LAYOUT_FILE),
      JSON.stringify({ groups: [group('g1', { workspaceId: 'A' })], displayOrder: ['g1'] })
    )
    fs.writeFileSync(
      path.join(dir, LAYOUTS_DIR, 'A.json'),
      JSON.stringify({
        groups: [group('g1', { workspaceId: 'A' }), group('g2', { workspaceId: 'A' })],
        displayOrder: ['g1', 'g2']
      })
    )
    fs.writeFileSync(
      path.join(dir, LAYOUTS_DIR, 'B.json'),
      JSON.stringify({
        groups: [group('g3', { workspaceId: 'B' })],
        displayOrder: ['g3', 's-free']
      })
    )
    expect(mgr.migrateIntoWindow('w1', ctx)).toBe(3)
    const out = mgr.loadForWindow('w1')
    expect(out.groups.map((g) => (g as { id: string }).id)).toEqual(['g1', 'g2', 'g3'])
    expect(out.displayOrder).toEqual(['g1', 'g2', 'g3', 's-free'])
    expect(fs.existsSync(path.join(dir, LAYOUTS_DIR, 'A.json'))).toBe(false)
    expect(fs.existsSync(path.join(dir, LAYOUTS_DIR, `A.json${MIGRATED_BACKUP_SUFFIX}`))).toBe(true)
    expect(fs.existsSync(path.join(dir, LAYOUTS_DIR, `B.json${MIGRATED_BACKUP_SUFFIX}`))).toBe(true)
    // Idempotent: nothing left to migrate, the window file untouched.
    expect(mgr.migrateIntoWindow('w1', ctx)).toBe(0)
    expect(mgr.loadForWindow('w1').groups.length).toBe(3)
  })

  it('an unreadable source is parked without losing the readable ones', () => {
    fs.mkdirSync(path.join(dir, LAYOUTS_DIR), { recursive: true })
    fs.writeFileSync(path.join(dir, LEGACY_LAYOUT_FILE), '{broken')
    fs.writeFileSync(
      path.join(dir, LAYOUTS_DIR, 'A.json'),
      JSON.stringify({ groups: [group('g2', { workspaceId: 'A' })], displayOrder: ['g2'] })
    )
    expect(mgr.migrateIntoWindow('w1', ctx)).toBe(2)
    expect(mgr.loadForWindow('w1').groups.map((g) => (g as { id: string }).id)).toEqual(['g2'])
    expect(fs.existsSync(path.join(dir, `${LEGACY_LAYOUT_FILE}${MIGRATED_BACKUP_SUFFIX}`))).toBe(
      true
    )
  })
})

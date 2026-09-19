import { describe, it, expect } from 'vitest'
import { planBootAdoption, survivingIds, type BootRecordLike } from './boot-adoption'

const tab = (id: string, live = true): BootRecordLike => ({ id, live })
const term = (id: string, live = true, groupId = 'g1', terminalId = 't1'): BootRecordLike => ({
  id,
  live,
  link: { kind: 'group-terminal', groupId, terminalId }
})
const server = (id: string, live = true, ownerId = 'owner'): BootRecordLike => ({
  id,
  live,
  link: { kind: 'session-view', ownerId }
})
const toolbar = (id: string, live = true, key = 'pin:0'): BootRecordLike => ({
  id,
  live,
  link: { kind: 'toolbar', key }
})

describe('planBootAdoption — a record only becomes a tab when it IS one', () => {
  it('restores dead supported agents as metadata without asking to relaunch', () => {
    const records = [
      { ...tab('claude', false), claudeMode: true },
      { ...tab('codex', false), codexMode: true },
      { ...tab('pi', false), piMode: true },
      { ...tab('antigravity', false), claudeMode: true, antigravityMode: true },
      { ...tab('agents', false), claudeMode: true, claudeAgentsMode: true },
      { ...term('hidden', false), claudeMode: true }
    ]
    const plan = planBootAdoption(records)
    expect(plan.liveTabs.map((record) => record.id)).toEqual(['claude', 'codex', 'pi'])
    expect(plan.deadTabs.map((record) => record.id)).toEqual(['antigravity', 'agents'])
    expect(plan.discard.map((record) => record.id)).toEqual(['hidden'])
  })

  it('an unlinked record is a tab, live or dead (every legacy record)', () => {
    const plan = planBootAdoption([tab('a'), tab('b', false)])
    expect(plan.liveTabs.map((r) => r.id)).toEqual(['a'])
    expect(plan.deadTabs.map((r) => r.id)).toEqual(['b'])
    expect(plan.hidden).toEqual([])
    expect(plan.toolbar).toEqual([])
    expect(plan.discard).toEqual([])
  })

  it('a live group terminal and a live view server are hidden halves, never tabs', () => {
    const plan = planBootAdoption([term('t'), server('s')])
    expect(plan.hidden.map((r) => r.id)).toEqual(['t', 's'])
    expect(plan.liveTabs).toEqual([])
    expect(plan.deadTabs).toEqual([])
  })

  it('a live toolbar terminal goes to the toolbar, not the sidebar', () => {
    const plan = planBootAdoption([toolbar('tb')])
    expect(plan.toolbar.map((r) => r.id)).toEqual(['tb'])
    expect(plan.liveTabs).toEqual([])
    expect(plan.hidden).toEqual([])
  })

  it('a DEAD hidden half is discarded — never offered by the restore prompt', () => {
    const plan = planBootAdoption([term('t', false), server('s', false), toolbar('tb', false)])
    expect(plan.discard.map((r) => r.id)).toEqual(['t', 's', 'tb'])
    expect(plan.deadTabs).toEqual([])
    expect(plan.hidden).toEqual([])
    expect(plan.toolbar).toEqual([])
  })

  it('sorts a real mixed launch', () => {
    const plan = planBootAdoption([
      tab('agent'),
      term('devserver'),
      tab('crashed', false),
      toolbar('docs'),
      server('board'),
      term('old-dev', false)
    ])
    expect(plan.liveTabs.map((r) => r.id)).toEqual(['agent'])
    expect(plan.deadTabs.map((r) => r.id)).toEqual(['crashed'])
    expect(plan.hidden.map((r) => r.id)).toEqual(['devserver', 'board'])
    expect(plan.toolbar.map((r) => r.id)).toEqual(['docs'])
    expect(plan.discard.map((r) => r.id)).toEqual(['old-dev'])
  })
})

describe('survivingIds — what the layout merge must treat as alive', () => {
  it('counts the hidden halves even though they are adopted after the merge', () => {
    const plan = planBootAdoption([tab('agent'), term('devserver'), toolbar('docs')])
    expect(survivingIds(plan, ['agent'])).toEqual(['agent', 'devserver'])
  })

  it('leaves out what will not come back (dead halves, toolbar terminals)', () => {
    const plan = planBootAdoption([term('gone', false), toolbar('docs')])
    expect(survivingIds(plan, [])).toEqual([])
  })
})

import { resolveHiddenOwner } from './boot-adoption'

describe('resolveHiddenOwner — an ownerless hidden half is discarded, never surfaced', () => {
  const state = {
    groups: [{ id: 'g1', terminals: [{ id: 't1' }] }],
    sessions: [{ id: 'owner', view: { url: 'http://127.0.0.1:4740' } }, { id: 'plain' }]
  }

  it('links a group terminal back to a group that still carries its terminal', () => {
    expect(
      resolveHiddenOwner({ kind: 'group-terminal', groupId: 'g1', terminalId: 't1' }, state)
    ).toBe('link')
  })

  it('discards a group terminal whose group was deleted (the seven mystery tabs of 2026-09-03)', () => {
    expect(
      resolveHiddenOwner(
        { kind: 'group-terminal', groupId: 'group-1788296388304-2', terminalId: 't1' },
        state
      )
    ).toBe('discard')
  })

  it('discards a group terminal whose group lost that terminal', () => {
    expect(
      resolveHiddenOwner({ kind: 'group-terminal', groupId: 'g1', terminalId: 'gone' }, state)
    ).toBe('discard')
  })

  it('links a view server to an owning tab that still carries a view', () => {
    expect(resolveHiddenOwner({ kind: 'session-view', ownerId: 'owner' }, state)).toBe('link')
  })

  it('discards a view server whose owner is gone or viewless (a declined restore leaves it no start action: stopped, never a tab)', () => {
    expect(resolveHiddenOwner({ kind: 'session-view', ownerId: 'nope' }, state)).toBe('discard')
    expect(resolveHiddenOwner({ kind: 'session-view', ownerId: 'plain' }, state)).toBe('discard')
  })

  it('a toolbar link is never a sidebar owner here', () => {
    expect(resolveHiddenOwner({ kind: 'toolbar', key: 'pin:0' }, state)).toBe('discard')
  })
})

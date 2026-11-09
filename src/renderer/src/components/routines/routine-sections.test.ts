import { describe, expect, it } from 'vitest'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import type { RoutineDeclaration, RoutineRun, RoutineView } from '@clave/contract/routines/model'
import type { RoutineSurface } from './routine-servers'
import { aggregateBadge, runsEverywhere, sectionsOf } from './routine-sections'

const decl = (over: Partial<RoutineDeclaration> = {}): RoutineDeclaration => ({
  key: `/r/.clave/workspaces/default.clave::${over.name ?? 'Digest'}`,
  name: 'Digest',
  file: '/r/.clave/workspaces/default.clave',
  rootDir: '/r',
  group: 'Ops',
  workspaceId: 'ws',
  workspaceName: 'Work',
  schedule: '0 8 * * *',
  prompt: 'go',
  skill: null,
  cwd: '/r',
  launch: {},
  icon: null,
  color: null,
  catchUp: true,
  timeoutMinutes: 30,
  scope: 'machine',
  runsOn: 'every',
  runsHere: true,
  origin: 'file',
  report: { template: '/t', schema: '/s', width: 400, height: 300, publish: false },
  invalid: null,
  ...over
})
const run = (state: RoutineRun['state'], seen = false): RoutineRun => ({
  id: `run-${state}`,
  routineKey: 'k',
  trigger: 'scheduled',
  startedAt: 1,
  endedAt: state === 'running' || state === 'waiting' ? null : 2,
  state,
  headline: null,
  summary: null,
  reason: null,
  sessionId: null,
  providerSessionId: null,
  discussionSessionId: null,
  agent: 'claude',
  form: 'chat',
  model: null,
  account: null,
  deck: null,
  seen
})
const view = (routine: RoutineDeclaration, runs: RoutineRun[] = []): RoutineView => ({
  routine,
  nextRunAt: null,
  runs
})
const surface = (over: Partial<RoutineSurface> & { view: RoutineView }): RoutineSurface => ({
  serverId: LOCAL_SERVER_ID,
  serverName: 'This Mac',
  runsOn: 'here',
  reachable: true,
  workspaceId: 'ws',
  placement: over.view.routine.runsOn ?? null,
  problem: null,
  ...over
})

describe('the sections of the Routines popover (PRDCT-4244)', () => {
  it('one section per machine, this Mac first, then the connected servers, then the ones away or unknown', () => {
    const here = surface({ view: view(decl()) })
    const studio = surface({
      view: view(decl({ runsOn: 'studio' })),
      serverId: 's1',
      serverName: 'MacStudio',
      runsOn: 'server'
    })
    const box = surface({
      view: view(decl({ name: 'Nightly', runsOn: 'box' })),
      serverId: 's2',
      serverName: 'Box',
      runsOn: 'server'
    })
    const away = surface({
      view: view(decl({ name: 'Backup', runsOn: 'vault' })),
      serverName: 'Vault',
      runsOn: 'server',
      reachable: false,
      problem: 'offline'
    })
    const ghost = surface({
      view: view(decl({ name: 'Pin test', runsOn: 'ghost-server' })),
      serverName: 'ghost-server',
      runsOn: 'server',
      reachable: false,
      problem: 'unknown'
    })
    const sections = sectionsOf([ghost, box, away, studio, here])
    expect(sections.map((s) => [s.kind, s.title, s.note, s.canCreate, s.surfaces.length])).toEqual([
      ['here', 'This Mac', null, true, 1],
      ['server', 'Box', null, true, 1],
      ['server', 'MacStudio', null, true, 1],
      ['away', 'Vault', 'Not connected', false, 1],
      ['unknown', 'ghost-server', 'No machine by that name', false, 1]
    ])
    expect(sections[1].serverId).toBe('s2')
    expect(sections[3].serverId).toBe(LOCAL_SERVER_ID)
    expect(sections[4].id).toBe('away:ghost-server')
  })

  it('a connected machine that does not read the file gets its own section, saying so', () => {
    const absent = surface({
      view: view(decl({ name: 'Elsewhere', runsOn: 'box' })),
      serverName: 'Box',
      runsOn: 'server',
      reachable: false,
      problem: 'absent'
    })
    expect(sectionsOf([absent])[0]).toMatchObject({
      kind: 'absent',
      title: 'Box',
      note: 'Does not read this file',
      canCreate: false
    })
  })

  it('a routine on every machine appears under each machine that lists it', () => {
    const mine = surface({ view: view(decl()) })
    const theirs = surface({
      view: view(decl()),
      serverId: 's1',
      serverName: 'MacStudio',
      runsOn: 'server'
    })
    const sections = sectionsOf([mine, theirs])
    expect(sections.map((s) => [s.title, s.surfaces.map((x) => x.view.routine.name)])).toEqual([
      ['This Mac', ['Digest']],
      ['MacStudio', ['Digest']]
    ])
    expect(runsEverywhere(mine)).toBe(true)
    expect(runsEverywhere({ placement: 'studio' })).toBe(false)
  })

  it('a routine that says nowhere it runs sits under this Mac, invalid', () => {
    const s = surface({
      view: view(decl({ runsOn: null, runsHere: false, invalid: 'say where it runs: runsOn' })),
      placement: null
    })
    expect(sectionsOf([s])[0]).toMatchObject({ kind: 'here', surfaces: [s] })
  })

  it('names this Mac as its server listing does', () => {
    expect(sectionsOf([surface({ view: view(decl()) })], 'romains-macbook')[0].title).toBe(
      'romains-macbook'
    )
  })
})

describe('the one button’s badge', () => {
  it('is the strongest signal: a run in flight over everything, then waiting, failed, invalid, away, attention, ok', () => {
    const ok = surface({ view: view(decl(), [run('ok')]) })
    const failed = surface({ view: view(decl({ name: 'F' }), [run('failed')]) })
    const running = surface({ view: view(decl({ name: 'R' }), [run('running')]) })
    const attention = surface({ view: view(decl({ name: 'A' }), [run('attention')]) })
    const seen = surface({ view: view(decl({ name: 'S' }), [run('ok', true)]) })
    expect(aggregateBadge([ok, failed, running])).toMatchObject({ state: 'running', working: true })
    expect(aggregateBadge([ok, failed, attention])).toMatchObject({
      state: 'failed',
      dot: 'failed'
    })
    expect(aggregateBadge([ok, attention])).toMatchObject({ state: 'attention', dot: 'attention' })
    expect(aggregateBadge([ok, seen])).toMatchObject({ state: 'ok', dot: 'ok' })
    expect(aggregateBadge([seen])).toMatchObject({ state: 'seen', dot: null })
    expect(aggregateBadge([])).toMatchObject({ state: 'never', dot: null })
    const away = surface({
      view: view(decl({ name: 'W', runsOn: 'vault' })),
      runsOn: 'server',
      reachable: false,
      problem: 'offline'
    })
    expect(aggregateBadge([ok, away])).toMatchObject({ state: 'unreachable', dot: 'invalid' })
    const invalid = surface({ view: view(decl({ name: 'I', invalid: 'nope' })) })
    expect(aggregateBadge([away, invalid])).toMatchObject({ state: 'invalid' })
    // The order, pair by pair: each state beats the one after it.
    const waiting = surface({ view: view(decl({ name: 'Q' }), [run('waiting')]) })
    expect(aggregateBadge([waiting, failed]).state).toBe('waiting')
    expect(aggregateBadge([failed, invalid]).state).toBe('failed')
    expect(aggregateBadge([invalid, away]).state).toBe('invalid')
    expect(aggregateBadge([away, attention]).state).toBe('unreachable')
    expect(aggregateBadge([attention, ok]).state).toBe('attention')
    expect(aggregateBadge([ok, seen]).state).toBe('ok')
  })
})

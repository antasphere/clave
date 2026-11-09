import { describe, expect, it } from 'vitest'
import { LOCAL_SERVER_ID, resourceKey } from '@clave/contract/fleet'
import type {
  RoutineDeclaration,
  RoutineView,
  RoutinesListing
} from '@clave/contract/routines/model'
import {
  dedupeByIdentity,
  mergeRoutineSurfaces,
  relId,
  type RoutineSurface,
  type RoutineSurfacesInput
} from './routine-servers'

const decl = (over: Partial<RoutineDeclaration> & { rootDir: string }): RoutineDeclaration => ({
  key: `${over.rootDir}/.clave/workspaces/default.clave::${over.name ?? 'Digest'}`,
  name: 'Digest',
  file: `${over.rootDir}/.clave/workspaces/default.clave`,
  group: 'Ops',
  workspaceId: 'ws',
  workspaceName: 'Workspace',
  schedule: '0 8 * * *',
  prompt: 'go',
  skill: null,
  cwd: over.rootDir,
  launch: {},
  icon: null,
  color: null,
  catchUp: false,
  timeoutMinutes: 30,
  scope: 'machine',
  runsOn: 'every',
  runsHere: true,
  origin: 'file',
  report: { template: '/t', schema: '/s', width: 400, height: 300, publish: false },
  invalid: null,
  ...over
})
const view = (routine: RoutineDeclaration): RoutineView => ({ routine, nextRunAt: null, runs: [] })
const listing = (id: string, name: string, routines: RoutineView[]): RoutinesListing => ({
  routines,
  viewer: { url: null, note: '' },
  server: { id, name }
})
const input = (over: Partial<RoutineSurfacesInput>): RoutineSurfacesInput => ({
  local: null,
  remote: {},
  connected: new Set(),
  connectionNames: {},
  pairings: {},
  ...over
})

const MAC = '/Users/me/repo'
const BOX = '/home/me/repo'

describe('relId', () => {
  it('is the file under its root and the name, whatever the root', () => {
    const a = decl({ rootDir: MAC })
    const b = decl({ rootDir: `${BOX}/`, file: `${BOX}/.clave/workspaces/default.clave` })
    expect(relId(a)).toBe('.clave/workspaces/default.clave::Digest')
    expect(relId(b)).toBe(relId(a))
    expect(relId(decl({ rootDir: MAC, name: 'Other' }))).not.toBe(relId(a))
  })
})

describe('mergeRoutineSurfaces', () => {
  it('a local routine this Mac runs surfaces here, in its workspace', () => {
    const d = decl({ rootDir: MAC, workspaceId: 'mac-ws' })
    const out = mergeRoutineSurfaces(input({ local: listing('local-id', 'Mac', [view(d)]) }))
    expect(out).toEqual([
      {
        view: view(d),
        serverId: LOCAL_SERVER_ID,
        serverName: 'Mac',
        runsOn: 'here',
        reachable: true,
        workspaceId: 'mac-ws',
        placement: 'every',
        problem: null
      }
    ])
  })

  it('a pinned local routine surfaces as the connected owner’s view, under the local workspace', () => {
    const mine = decl({ rootDir: MAC, workspaceId: 'mac-ws', runsOn: 'Box', runsHere: false })
    const theirs = view(decl({ rootDir: BOX, workspaceId: 'box-raw', runsOn: 'Box' }))
    const out = mergeRoutineSurfaces(
      input({
        local: listing('local-id', 'Mac', [view(mine)]),
        remote: { s1: listing('s1', 'box', [theirs]) },
        connected: new Set(['s1'])
      })
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      view: theirs,
      serverId: 's1',
      serverName: 'box',
      runsOn: 'server',
      reachable: true,
      workspaceId: 'mac-ws',
      placement: 'Box',
      problem: null
    })
  })

  it('a pin may name the server by its id', () => {
    const mine = decl({ rootDir: MAC, runsOn: ' s1 ', runsHere: false })
    const theirs = view(decl({ rootDir: BOX }))
    const out = mergeRoutineSurfaces(
      input({
        local: listing('l', 'Mac', [view(mine)]),
        remote: { s1: listing('s1', 'box', [theirs]) },
        connected: new Set(['s1'])
      })
    )
    expect(out[0]).toMatchObject({ serverId: 's1', reachable: true, view: theirs })
  })

  it('a pinned routine whose owner is known but disconnected keeps the local view, unreachable', () => {
    const mine = decl({ rootDir: MAC, workspaceId: 'mac-ws', runsOn: 'box', runsHere: false })
    const theirs = view(decl({ rootDir: BOX }))
    const out = mergeRoutineSurfaces(
      input({
        local: listing('l', 'Mac', [view(mine)]),
        remote: { s1: listing('s1', 'Box', [theirs]) },
        connected: new Set()
      })
    )
    expect(out).toEqual([
      {
        view: view(mine),
        serverId: LOCAL_SERVER_ID,
        serverName: 'Box',
        runsOn: 'server',
        reachable: false,
        workspaceId: 'mac-ws',
        placement: 'box',
        problem: 'offline'
      }
    ])
  })

  it('a pinned routine the connected owner does not list (no twin) stays the local view, unreachable', () => {
    const mine = decl({ rootDir: MAC, runsOn: 'Box', runsHere: false })
    const other = view(decl({ rootDir: BOX, name: 'Something else' }))
    const out = mergeRoutineSurfaces(
      input({
        local: listing('l', 'Mac', [view(mine)]),
        remote: { s1: listing('s1', 'Box', [other]) },
        connected: new Set(['s1'])
      })
    )
    expect(out[0]).toMatchObject({ serverId: LOCAL_SERVER_ID, reachable: false, runsOn: 'server' })
    // The owner's other routine still surfaces on its own.
    expect(out[1]).toMatchObject({ serverId: 's1', view: other })
  })

  it('a server whose listing is unknown but whose saved connection name matches the pin gives the surface that name', () => {
    const mine = decl({ rootDir: MAC, runsOn: 'build box', runsHere: false })
    const out = mergeRoutineSurfaces(
      input({
        local: listing('l', 'Mac', [view(mine)]),
        connectionNames: { s9: 'Build Box' }
      })
    )
    expect(out[0]).toMatchObject({
      serverName: 'Build Box',
      reachable: false,
      placement: 'build box',
      problem: 'offline'
    })
  })

  it('a placement nothing on this Mac knows is named as written, and marked unknown', () => {
    const mine = decl({ rootDir: MAC, runsOn: 'nowhere', runsHere: false })
    const out = mergeRoutineSurfaces(input({ local: listing('l', 'Mac', [view(mine)]) }))
    expect(out[0]).toMatchObject({
      serverName: 'nowhere',
      reachable: false,
      serverId: LOCAL_SERVER_ID,
      placement: 'nowhere',
      problem: 'unknown'
    })
  })

  it('a placement on a saved server that is away is marked offline, by its label or the name last heard', () => {
    const byLabel = decl({ rootDir: MAC, runsOn: 'Studio', runsHere: false })
    const out = mergeRoutineSurfaces(
      input({
        local: listing('l', 'Mac', [view(byLabel)]),
        connectionNames: { s1: 'Studio' }
      })
    )
    expect(out[0]).toMatchObject({ serverName: 'Studio', reachable: false, problem: 'offline' })
    const byOwnName = decl({ rootDir: MAC, runsOn: 'romains-mac-studio', runsHere: false })
    const heard = mergeRoutineSurfaces(
      input({
        local: listing('l', 'Mac', [view(byOwnName)]),
        connectionNames: { s1: 'MacStudio' },
        knownNames: { s1: 'romains-mac-studio' }
      })
    )
    expect(heard[0]).toMatchObject({
      serverName: 'MacStudio',
      reachable: false,
      problem: 'offline'
    })
  })

  it('a routine that says nowhere it runs stays a local, invalid surface', () => {
    const mine = decl({ rootDir: MAC, runsOn: null, runsHere: false, invalid: 'say where it runs' })
    const out = mergeRoutineSurfaces(input({ local: listing('l', 'Mac', [view(mine)]) }))
    expect(out[0]).toMatchObject({
      serverId: LOCAL_SERVER_ID,
      runsOn: 'here',
      reachable: true,
      placement: null,
      problem: null
    })
  })

  it('a routine on every machine surfaces once per machine that lists it', () => {
    const mine = decl({ rootDir: MAC, workspaceId: 'mac-ws', runsOn: 'every' })
    const theirs = view(decl({ rootDir: BOX, workspaceId: 'raw-ws', runsOn: 'every' }))
    const out = mergeRoutineSurfaces(
      input({
        local: listing('l', 'Mac', [view(mine)]),
        remote: { s1: listing('s1', 'Box', [theirs]) },
        connected: new Set(['s1']),
        pairings: {
          s1: { combine: true, color: '#f00', pairs: { 'raw-ws': 'mac-ws' }, declined: [] }
        }
      })
    )
    expect(out.map((o) => [o.serverId, o.workspaceId, o.placement])).toEqual([
      [LOCAL_SERVER_ID, 'mac-ws', 'every'],
      ['s1', 'mac-ws', 'every']
    ])
  })

  it('a server routine shows under the paired Mac workspace when the pairing combines', () => {
    const theirs = view(decl({ rootDir: BOX, workspaceId: 'raw-ws' }))
    const out = mergeRoutineSurfaces(
      input({
        remote: { s1: listing('s1', 'Box', [theirs]) },
        connected: new Set(['s1']),
        pairings: {
          s1: { combine: true, color: '#f00', pairs: { 'raw-ws': 'mac-ws' }, declined: [] }
        }
      })
    )
    expect(out).toEqual([
      {
        view: theirs,
        serverId: 's1',
        serverName: 'Box',
        runsOn: 'server',
        reachable: true,
        workspaceId: 'mac-ws',
        placement: 'every',
        problem: null
      }
    ])
  })

  it('without a combining pairing, a server routine shows under the server workspace’s remote key', () => {
    const theirs = view(decl({ rootDir: BOX, workspaceId: 'raw-ws' }))
    const off = mergeRoutineSurfaces(
      input({
        remote: { s1: listing('s1', 'Box', [theirs]) },
        connected: new Set(),
        pairings: {
          s1: { combine: false, color: '#f00', pairs: { 'raw-ws': 'mac-ws' }, declined: [] }
        }
      })
    )
    expect(off[0]).toMatchObject({
      workspaceId: resourceKey('workspace', 's1', 'raw-ws'),
      reachable: false
    })
  })

  it('a server routine that server does not run gives no surface', () => {
    const elsewhere = view(decl({ rootDir: BOX, runsOn: 'other', runsHere: false }))
    const out = mergeRoutineSurfaces(
      input({ remote: { s1: listing('s1', 'Box', [elsewhere]) }, connected: new Set(['s1']) })
    )
    expect(out).toEqual([])
  })

  it('a server older than the field, listing no runsHere, is read as running what it lists (round 2, Gap)', () => {
    // An older server ran every routine it read: a listing without the field
    // must surface its routines, not drop them.
    const { runsHere: _dropped, ...older } = decl({ rootDir: BOX, name: 'Old' })
    void _dropped
    const out = mergeRoutineSurfaces(
      input({ remote: { s1: listing('s1', 'Box', [view(older)]) }, connected: new Set(['s1']) })
    )
    expect(out.map((o) => [o.view.routine.name, o.serverId, o.runsOn])).toEqual([
      ['Old', 's1', 'server']
    ])
  })

  it('orders local first, then servers by id, and never shows a routine twice', () => {
    const here = decl({ rootDir: MAC, name: 'Here' })
    const pinned = decl({ rootDir: MAC, name: 'Pinned', runsOn: 'A', runsHere: false })
    const aPinned = view(decl({ rootDir: BOX, name: 'Pinned' }))
    const aOwn = view(decl({ rootDir: BOX, name: 'A own' }))
    const bOwn = view(decl({ rootDir: BOX, name: 'B own' }))
    const out = mergeRoutineSurfaces(
      input({
        local: listing('l', 'Mac', [view(here), view(pinned)]),
        remote: {
          zz: listing('zz', 'B', [bOwn, bOwn]),
          aa: listing('aa', 'A', [aPinned, aOwn])
        },
        connected: new Set(['aa', 'zz'])
      })
    )
    expect(out.map((s) => [s.serverId, s.view.routine.name])).toEqual([
      [LOCAL_SERVER_ID, 'Here'],
      ['aa', 'Pinned'],
      ['aa', 'A own'],
      ['zz', 'B own']
    ])
  })
})

describe('one server, two saved connections (round 1)', () => {
  it('two listings answering to one name: the connected one is the pinned routine’s surface (Gap 5)', () => {
    const mine = decl({ rootDir: MAC, workspaceId: 'mac-ws', runsOn: 'studio', runsHere: false })
    const twinA = view(decl({ rootDir: BOX, runsOn: 'studio' }))
    const twinB = view(decl({ rootDir: `${BOX}-b`, runsOn: 'studio' }))
    const remote = {
      a: listing('srv-a', 'studio', [twinA]),
      b: listing('srv-b', 'studio', [twinB])
    }
    // The pinned routine's surface is the one under the Mac workspace; the
    // other listing's own view may surface beside it, it is not the subject.
    const pinned = (connected: string[]): RoutineSurface[] =>
      mergeRoutineSurfaces(
        input({
          local: listing('l', 'Mac', [view(mine)]),
          remote,
          connected: new Set(connected)
        })
      ).filter((s) => s.workspaceId === 'mac-ws')

    const viaA = pinned(['a'])
    expect(viaA).toHaveLength(1)
    expect(viaA[0]).toMatchObject({ serverId: 'a', reachable: true, view: twinA })

    // Only the second connected: the surface follows it, though `a` sorts first.
    const viaB = pinned(['b'])
    expect(viaB).toHaveLength(1)
    expect(viaB[0]).toMatchObject({ serverId: 'b', reachable: true, view: twinB })
  })

  it('one server saved twice surfaces its routine once, through the connected connection (Note 1)', () => {
    const own = decl({ rootDir: BOX, name: 'Nightly' })
    const remote = {
      lan: listing('srv-1', 'Studio', [view(own)]),
      tailnet: listing('srv-1', 'Studio', [view(own)])
    }
    const surfaces = (connected: string[]): RoutineSurface[] =>
      mergeRoutineSurfaces(input({ remote, connected: new Set(connected) })).filter(
        (s) => s.view.routine.name === 'Nightly'
      )

    const up = surfaces(['tailnet'])
    expect(up).toHaveLength(1)
    expect(up[0]).toMatchObject({ serverId: 'tailnet', reachable: true })

    // Neither up: still once, through the first in sorted order.
    const down = surfaces([])
    expect(down).toHaveLength(1)
    expect(down[0]).toMatchObject({ serverId: 'lan', reachable: false })
  })

  it('dedupeByIdentity keeps a listing without an identity (an older server) beside the others', () => {
    const older: RoutinesListing = { routines: [], viewer: { url: null, note: '' } }
    const remote = {
      a: listing('srv-1', 'Studio', []),
      b: listing('srv-1', 'Studio', []),
      c: older,
      d: older
    }
    expect(dedupeByIdentity(remote, new Set(['b']))).toEqual(['b', 'c', 'd'])
    expect(dedupeByIdentity(remote, new Set())).toEqual(['a', 'c', 'd'])
  })
})

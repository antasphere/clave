import { describe, expect, it } from 'vitest'
import { LOCAL_SERVER_ID, resourceKey } from '@clave/contract/fleet'
import type {
  RoutineDeclaration,
  RoutineView,
  RoutinesListing
} from '@clave/contract/routines/model'
import { mergeRoutineSurfaces, relId, type RoutineSurfacesInput } from './routine-servers'

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
  server: null,
  runsHere: true,
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
        pinnedTo: null
      }
    ])
  })

  it('a pinned local routine surfaces as the connected owner’s view, under the local workspace', () => {
    const mine = decl({ rootDir: MAC, workspaceId: 'mac-ws', server: 'Box', runsHere: false })
    const theirs = view(decl({ rootDir: BOX, workspaceId: 'box-raw', server: 'Box' }))
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
      pinnedTo: 'Box'
    })
  })

  it('a pin may name the server by its id', () => {
    const mine = decl({ rootDir: MAC, server: ' s1 ', runsHere: false })
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
    const mine = decl({ rootDir: MAC, workspaceId: 'mac-ws', server: 'box', runsHere: false })
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
        pinnedTo: 'box'
      }
    ])
  })

  it('a pinned routine the connected owner does not list (no twin) stays the local view, unreachable', () => {
    const mine = decl({ rootDir: MAC, server: 'Box', runsHere: false })
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
    const mine = decl({ rootDir: MAC, server: 'build box', runsHere: false })
    const out = mergeRoutineSurfaces(
      input({
        local: listing('l', 'Mac', [view(mine)]),
        connectionNames: { s9: 'Build Box' }
      })
    )
    expect(out[0]).toMatchObject({
      serverName: 'Build Box',
      reachable: false,
      pinnedTo: 'build box'
    })
  })

  it('a pin nothing on this Mac knows is named as written', () => {
    const mine = decl({ rootDir: MAC, server: 'nowhere', runsHere: false })
    const out = mergeRoutineSurfaces(input({ local: listing('l', 'Mac', [view(mine)]) }))
    expect(out[0]).toMatchObject({
      serverName: 'nowhere',
      reachable: false,
      serverId: LOCAL_SERVER_ID
    })
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
        pinnedTo: null
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
    const elsewhere = view(decl({ rootDir: BOX, server: 'other', runsHere: false }))
    const out = mergeRoutineSurfaces(
      input({ remote: { s1: listing('s1', 'Box', [elsewhere]) }, connected: new Set(['s1']) })
    )
    expect(out).toEqual([])
  })

  it('orders local first, then servers by id, and never shows a routine twice', () => {
    const here = decl({ rootDir: MAC, name: 'Here' })
    const pinned = decl({ rootDir: MAC, name: 'Pinned', server: 'A', runsHere: false })
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

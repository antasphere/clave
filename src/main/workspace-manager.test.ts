import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import type { Workspace } from '../shared/workspace-types'
import { eachTestPorts, tempDataDir } from './ports/testing'
import { WorkspaceManager, mergePinsPartition } from './workspace-manager'

/**
 * The state file is written one pins partition (workspace id) at a time. The
 * silent defect this guards: a pin re-stamped from the null partition to a
 * workspace id was written into the new partition while its old copy stayed in
 * the file, and the two hydrated side by side at the next boot — one more copy
 * of the same group per boot (four "Curio" groups after four restarts).
 */
const pin = (id: string, workspaceId: string | null, name = id): Record<string, unknown> => ({
  id,
  name,
  workspaceId
})

describe('mergePinsPartition — a pin id lives in exactly one partition', () => {
  it('replaces the scoped partition and leaves other workspaces alone', () => {
    const existing = [pin('a', 'ws1'), pin('b', 'ws2'), pin('c', null)]
    const next = mergePinsPartition(existing, 'ws1', [pin('a2', 'ws1')])
    expect(next).toEqual([pin('b', 'ws2'), pin('c', null), pin('a2', 'ws1')])
  })

  it('a re-stamped pin leaves its old partition when its new one is written', () => {
    const existing = [pin('curio', null, 'Curio'), pin('exos', 'ws1', 'Exos')]
    const next = mergePinsPartition(existing, 'ws1', [
      pin('exos', 'ws1', 'Exos'),
      pin('curio', 'ws1', 'Curio')
    ])
    expect(next).toEqual([pin('exos', 'ws1', 'Exos'), pin('curio', 'ws1', 'Curio')])
    expect(next.filter((p) => (p as { id: string }).id === 'curio')).toHaveLength(1)
  })

  it('the null partition is a real partition: writing it empty clears it', () => {
    const existing = [pin('curio', null), pin('exos', 'ws1')]
    expect(mergePinsPartition(existing, null, [])).toEqual([pin('exos', 'ws1')])
  })

  it("'all' replaces the whole list", () => {
    expect(mergePinsPartition([pin('a', 'ws1'), pin('b', null)], 'all', [pin('z', 'ws9')])).toEqual(
      [pin('z', 'ws9')]
    )
  })

  it('a pin without a string id is kept as-is (never matched, never dropped)', () => {
    const odd = { name: 'no id', workspaceId: null }
    expect(mergePinsPartition([odd, pin('a', 'ws1')], 'ws1', [pin('a', 'ws1')])).toEqual([
      odd,
      pin('a', 'ws1')
    ])
  })
})

describe.each(eachTestPorts())('WorkspaceManager on %s', (_name, makePorts) => {
  const readFile = (dir: string, name: string): unknown =>
    JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'))

  it('starts empty without a file and writes the state file', () => {
    const ports = makePorts()
    expect(new WorkspaceManager(ports).load()).toEqual({
      version: 1,
      workspaces: [],
      pins: [],
      pinsMigrated: true,
      lastActiveWorkspaceId: null,
      activeWorkspaceId: null
    })
    expect(fs.existsSync(path.join(ports.dir, 'workspace-state.json'))).toBe(true)
  })

  it('persists the registry, the pins and the last-active, and a fresh manager reads them back', () => {
    const ports = makePorts()
    const ws: Workspace = {
      id: 'ws-1',
      name: 'Root',
      rootDir: tempDataDir('clave-ws-root-'),
      profileFile: null,
      createdAt: 1
    }
    const p = pin('p-1', 'ws-1')
    const manager = new WorkspaceManager(ports)
    manager.updateRegistry([ws])
    manager.updatePins('ws-1', [p])
    manager.setLastActive('ws-1')

    const fresh = new WorkspaceManager(ports)
    expect(fresh.getWorkspaces()).toEqual([ws])
    expect(fresh.load().pins).toEqual([p])
    expect(fresh.getLastActiveWorkspaceId()).toBe('ws-1')
    expect(fresh.resolveInitialWorkspaceId()).toBe('ws-1')
    expect(fresh.isRegistered('ws-1')).toBe(true)
    // A session's cwd exists: realpath applies to both sides (/var is /private/var on macOS).
    fs.mkdirSync(path.join(ws.rootDir, 'sub'))
    expect(fresh.resolveWorkspaceForCwd(path.join(ws.rootDir, 'sub'))).toBe('ws-1')
  })

  it('a file from the previous release carrying only the old key is written back with both', () => {
    const ports = makePorts()
    fs.writeFileSync(
      path.join(ports.dir, 'workspace-state.json'),
      JSON.stringify({ version: 1, workspaces: [], pins: [], activeWorkspaceId: 'old' })
    )
    expect(new WorkspaceManager(ports).load().lastActiveWorkspaceId).toBe('old')
    expect(readFile(ports.dir, 'workspace-state.json')).toMatchObject({
      lastActiveWorkspaceId: 'old',
      activeWorkspaceId: 'old'
    })
  })

  it('migrates the retired per-file registry into one workspace per root and trusts the roots', () => {
    const ports = makePorts()
    const root1 = path.join(tempDataDir('clave-ws-mig-'), '.antasphere')
    const root2 = path.join(tempDataDir('clave-ws-mig-'), 'projects')
    fs.mkdirSync(root1)
    fs.mkdirSync(root2)
    // The generated Init snapshot existed on disk, under the data directory.
    fs.mkdirSync(path.join(ports.dir, 'init'))
    fs.writeFileSync(
      path.join(ports.dir, 'clave-preferences.json'),
      JSON.stringify({
        workspaces: [
          {
            id: 'a',
            claveFilePath: path.join(root1, '.clave', 'workspaces', 'default.clave'),
            rootDir: root1
          },
          { id: 'b', path: root2 },
          { id: 'c', claveFilePath: path.join(ports.dir, 'init', 'workspace.clave') }
        ],
        activeWorkspaceId: 'b'
      })
    )

    const state = new WorkspaceManager(ports).load()
    const real1 = fs.realpathSync(root1)
    const real2 = fs.realpathSync(root2)
    expect(state.workspaces.map((w) => [w.name, w.rootDir])).toEqual([
      ['Antasphere', real1],
      ['Projects', real2]
    ])
    expect(state.pinsMigrated).toBe(false)
    const second = state.workspaces.find((w) => w.rootDir === real2)!
    expect(state.lastActiveWorkspaceId).toBe(second.id)
    expect(readFile(ports.dir, 'clave-trusted-roots.json')).toEqual([real1, real2])
  })
})

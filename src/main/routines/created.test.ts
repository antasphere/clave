import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CREATED_FILE,
  CREATED_GROUP,
  CreatedRoutinesStore,
  applyPatch,
  createdKey,
  createdProblem,
  declareCreated,
  isCreatedKey,
  type CreatedRoutine
} from './created'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'created-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function memory(): {
  docs: Map<string, string>
  read: (n: string) => string | null
  write: (n: string, t: string) => void
} {
  const docs = new Map<string, string>()
  return { docs, read: (n) => docs.get(n) ?? null, write: (n, t) => void docs.set(n, t) }
}

function template(dir: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'index.html'),
    '<html><script type="application/json" id="slideless-data">{}</script></html>'
  )
  writeFileSync(join(dir, 'schema.json'), '{"type":"object"}')
  return dir
}

const base = (
  over: Partial<CreatedRoutine> = {}
): Omit<CreatedRoutine, 'id' | 'paused' | 'createdAt' | 'updatedAt'> => ({
  workspaceId: 'ws',
  name: 'Digest',
  schedule: '0 8 * * *',
  prompt: 'Read @root_path and report.',
  launch: { model: 'm' },
  ...over
})

describe('the store of created routines (PRDCT-4242)', () => {
  it('starts empty, adds with an id and a clock, replaces, removes, and writes whole', () => {
    const storage = memory()
    let t = 1000
    const store = new CreatedRoutinesStore(storage, () => t)
    expect(store.all()).toEqual([])
    const a = store.add(base())
    expect(a).toMatchObject({ name: 'Digest', paused: false, createdAt: 1000, updatedAt: 1000 })
    expect(isCreatedKey(createdKey(a.id))).toBe(true)
    expect(store.byKey(createdKey(a.id))).toEqual(a)
    expect(store.byKey(`/some/file.clave::${a.name}`)).toBeUndefined()
    t = 2000
    const b = store.replace({ ...a, paused: true })
    expect(b).toMatchObject({ paused: true, createdAt: 1000, updatedAt: 2000 })
    const written = JSON.parse(storage.docs.get(CREATED_FILE)!)
    expect(written).toEqual({ version: 1, routines: [b] })
    expect(store.remove(a.id)).toBe(true)
    expect(store.remove(a.id)).toBe(false)
    expect(store.all()).toEqual([])
  })

  it('reads its file back and drops what is not a routine', () => {
    const storage = memory()
    storage.write(
      CREATED_FILE,
      JSON.stringify({ version: 1, routines: [{ ...base(), id: 'x' }, null, { name: 'no id' }] })
    )
    expect(new CreatedRoutinesStore(storage).all().map((r) => r.id)).toEqual(['x'])
    storage.write(CREATED_FILE, '{broken')
    expect(new CreatedRoutinesStore(storage).all()).toEqual([])
  })

  it('a patch changes the fields named and resolves a folder against the workspace root', () => {
    const current: CreatedRoutine = {
      ...base(),
      id: 'x',
      paused: false,
      createdAt: 1,
      updatedAt: 1
    }
    const next = applyPatch(current, { schedule: ' 30 8 * * 1-5 ', cwd: 'sub', skill: '' }, root)
    expect(next).toMatchObject({ schedule: '30 8 * * 1-5', cwd: join(root, 'sub'), name: 'Digest' })
    expect(next.skill).toBeUndefined()
    expect(applyPatch(current, {}, root)).toEqual(current)
  })

  it('names why a routine could never run: the schedule, the folder, the template, the timeout', () => {
    const dflt = template(join(root, 'default'))
    const ok = base({ cwd: root })
    expect(createdProblem(ok, root, dflt)).toBeNull()
    expect(createdProblem({ ...ok, name: '  ' }, root, dflt)).toBe('a routine needs a name')
    expect(createdProblem({ ...ok, schedule: 'now' }, root, dflt)).toMatch(/does not parse/)
    expect(createdProblem({ ...ok, cwd: join(root, 'gone') }, root, dflt)).toMatch(
      /is not on this machine/
    )
    expect(createdProblem({ ...ok, timeoutMinutes: 0 }, root, dflt)).toMatch(/above zero/)
    expect(createdProblem({ ...ok, report: { template: 'nowhere' } }, root, dflt)).toMatch(
      /does not exist/
    )
    template(join(root, '.clave', 'routines', 'mine'))
    expect(
      createdProblem({ ...ok, report: { template: '.clave/routines/mine' } }, root, dflt)
    ).toBeNull()
    expect(createdProblem({ ...ok, report: { template: '../outside' } }, root, dflt)).toMatch(
      /does not exist|outside/
    )
    expect(createdProblem(ok, root, join(root, 'no-default'))).toMatch(/built-in report page/)
  })

  it('declares a created routine as the scheduler sees it: this server’s own name, origin created, its own key', () => {
    const dflt = template(join(root, 'default'))
    const routine: CreatedRoutine = {
      ...base({ cwd: root, icon: 'bolt' }),
      id: 'r1',
      paused: true,
      createdAt: 1,
      updatedAt: 1
    }
    const d = declareCreated(routine, {
      file: '/data/routines-created.json',
      workspace: { id: 'ws', name: 'Work', rootDir: root, profileFile: null },
      identity: { id: 'srv', name: 'Studio' },
      defaultTemplate: dflt
    })
    expect(d).toMatchObject({
      key: 'created::r1',
      file: '/data/routines-created.json',
      rootDir: root,
      group: CREATED_GROUP,
      workspaceId: 'ws',
      workspaceName: 'Work',
      cwd: root,
      runsOn: 'Studio',
      runsHere: true,
      origin: 'created',
      paused: true,
      icon: 'bolt',
      scope: 'machine',
      catchUp: true,
      invalid: null
    })
    expect(d.prompt).toBe(`Read ${root} and report.`)
    expect(d.report).toEqual({
      template: dflt,
      schema: join(dflt, 'schema.json'),
      width: 560,
      height: 640,
      publish: false
    })
  })

  it('a created routine whose workspace left the registry is listed as unable to run, nowhere', () => {
    const d = declareCreated(
      { ...base(), id: 'r1', paused: false, createdAt: 1, updatedAt: 1 },
      {
        file: '/data/routines-created.json',
        workspace: undefined,
        identity: { id: 'srv', name: 'Studio' },
        defaultTemplate: template(join(root, 'default'))
      }
    )
    expect(d.runsHere).toBe(false)
    expect(d.invalid).toMatch(/workspace ws is no longer registered/)
    expect(d.workspaceName).toBe('ws')
  })
})

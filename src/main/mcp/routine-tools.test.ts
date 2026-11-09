import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  RoutineCreateInput,
  RoutineDeclaration,
  RoutinePatch,
  RoutineView,
  RoutinesListing
} from '@clave/contract/routines'
import type { ClaveFileReadResult, ClaveFileWriteData } from '@clave/contract/workspace-files'
import {
  type RoutineMachine,
  copyDirSync,
  createRoutineTool,
  deleteRoutineTool,
  listRoutinesTool,
  moveRoutineToFileTool,
  pauseRoutineTool,
  rowsOf,
  runRoutineTool,
  updateRoutineTool
} from './routine-tools'

const decl = (over: Partial<RoutineDeclaration> = {}): RoutineDeclaration => ({
  key: '/root/.clave/workspaces/default.clave::Health',
  name: 'Health',
  file: '/root/.clave/workspaces/default.clave',
  rootDir: '/root',
  group: 'Ops',
  workspaceId: 'ws',
  workspaceName: 'Work',
  schedule: '30 8 * * 1-5',
  prompt: 'check',
  skill: null,
  cwd: '/root',
  launch: {},
  icon: null,
  color: null,
  catchUp: true,
  timeoutMinutes: 30,
  scope: 'machine',
  runsOn: 'every',
  runsHere: true,
  origin: 'file',
  report: {
    template: '/root/.clave/routines/t',
    schema: '/root/.clave/routines/t/schema.json',
    width: 560,
    height: 640,
    publish: false
  },
  invalid: null,
  ...over
})
const view = (routine: RoutineDeclaration, runs: RoutineView['runs'] = []): RoutineView => ({
  routine,
  nextRunAt: 123,
  runs
})

/** A machine on fakes: its listing, what it was asked, and a file store. */
function machine(
  id: string,
  label: string,
  own: { id: string; name: string } | null,
  routines: RoutineView[],
  extra: Partial<RoutineMachine> & { fail?: string } = {}
): RoutineMachine & {
  calls: string[]
  files: NonNullable<RoutineMachine['files']>
  written: Record<string, ClaveFileWriteData>
} {
  const calls: string[] = []
  const written: Record<string, ClaveFileWriteData> = {}
  const listing = (): RoutinesListing => ({
    routines,
    viewer: { url: null, note: '' },
    ...(own ? { server: own } : {})
  })
  const created = (input: RoutineCreateInput | RoutinePatch, key = 'created::new'): RoutineView =>
    view(
      decl({
        key,
        name: input.name ?? 'Digest',
        schedule: input.schedule ?? '0 8 * * *',
        origin: 'created',
        runsOn: own?.name ?? null,
        file: '/data/routines-created.json',
        workspaceId: 'ws'
      })
    )
  return {
    id,
    label,
    calls,
    written,
    routines: {
      list: async () => {
        if (extra.fail) throw new Error(extra.fail)
        return listing()
      },
      create: async (input) => {
        calls.push(`create:${input.workspaceId}:${input.name}`)
        return created(input)
      },
      update: async (key, patch) => {
        calls.push(`update:${key}:${JSON.stringify(patch)}`)
        return created(patch, key)
      },
      delete: async (key) => {
        calls.push(`delete:${key}`)
      },
      pause: async (key, paused) => {
        calls.push(`pause:${key}:${paused}`)
        return created({ name: 'Digest' }, key)
      },
      runNow: async (key) => {
        calls.push(`run:${key}`)
        return {
          id: 'run-1',
          routineKey: key,
          trigger: 'manual',
          startedAt: 5,
          endedAt: null,
          state: 'running',
          headline: null,
          summary: null,
          reason: null,
          sessionId: 's',
          providerSessionId: null,
          discussionSessionId: null,
          agent: 'claude',
          form: 'chat',
          model: null,
          account: null,
          deck: null,
          seen: false
        }
      }
    },
    workspaces: async () => [
      {
        id: 'ws',
        name: 'Work',
        rootDir: '/root',
        profileFile: '/root/.clave/workspaces/default.clave'
      },
      { id: 'ws2', name: 'Other', rootDir: '/other', profileFile: null }
    ],
    files: {
      read: async (): Promise<ClaveFileReadResult | null> => null,
      write: async (file, data) => {
        written[file] = data
      },
      copyDir: () => {}
    },
    ...extra
  }
}

const deps = (...machines: RoutineMachine[]): Parameters<typeof createRoutineTool>[0] => ({
  machines: async () => machines,
  callerWorkspaceId: () => 'ws2'
})

describe('clave_routine_create', () => {
  it('creates on the local machine, in the caller’s workspace by default, with the launch fields folded', async () => {
    const local = machine('local', 'This Mac', { id: 'l', name: 'mac' }, [])
    const out = (await createRoutineTool(deps(local), {
      name: 'Digest',
      schedule: '0 8 * * *',
      prompt: 'go',
      model: 'm',
      dangerous: true
    })) as Record<string, unknown>
    expect(local.calls).toEqual(['create:ws2:Digest'])
    expect(out).toMatchObject({
      ok: true,
      key: 'created::new',
      machine: { id: 'local', ownName: 'mac' },
      runsOn: 'mac'
    })
  })

  it('resolves the machine by id, label or own name, and the workspace by name there', async () => {
    const local = machine('local', 'This Mac', { id: 'l', name: 'mac' }, [])
    const studio = machine(
      'srv-1',
      'MacStudio',
      { id: 'srv-1-own', name: 'romains-mac-studio' },
      []
    )
    for (const ref of ['srv-1', 'macstudio', 'ROMAINS-MAC-STUDIO', 'srv-1-own']) {
      studio.calls.length = 0
      await createRoutineTool(deps(local, studio), {
        machine: ref,
        workspace: 'work',
        name: 'Digest',
        schedule: '0 8 * * *',
        prompt: 'go'
      })
      expect(studio.calls, ref).toEqual(['create:ws:Digest'])
    }
    expect(local.calls).toEqual([])
  })

  it('refuses an unknown machine naming the reachable ones, an unreachable one, and asks for the workspace on a remote', async () => {
    const local = machine('local', 'This Mac', { id: 'l', name: 'mac' }, [])
    const studio = machine('srv-1', 'MacStudio', null, [], { fail: 'ECONNREFUSED' })
    const args = { name: 'Digest', schedule: '0 8 * * *', prompt: 'go' }
    await expect(
      createRoutineTool(deps(local, studio), { ...args, machine: 'ghost' })
    ).rejects.toThrow(/No machine "ghost". Reachable: This Mac \(own name mac\), MacStudio/)
    await expect(
      createRoutineTool(deps(local, studio), { ...args, machine: 'MacStudio' })
    ).rejects.toThrow(/not reachable right now: ECONNREFUSED/)
    const up = machine('srv-1', 'MacStudio', { id: 'x', name: 'studio' }, [])
    await expect(
      createRoutineTool(deps(local, up), { ...args, machine: 'studio' })
    ).rejects.toThrow(/Say which workspace, on MacStudio: "Work", "Other"/)
    await expect(
      createRoutineTool(deps(local, up), { ...args, machine: 'studio', workspace: 'nope' })
    ).rejects.toThrow(/No workspace "nope" on MacStudio/)
  })
})

describe('clave_routine_list', () => {
  it('lists every machine’s routines once: the owner keeps a placed routine, the twin is dropped, every runs on each', async () => {
    const shared = decl({ runsOn: 'studio', runsHere: false })
    const health = decl()
    const local = machine('local', 'This Mac', { id: 'l', name: 'mac' }, [
      view(shared),
      view(health)
    ])
    const studio = machine('srv-1', 'MacStudio', { id: 's', name: 'studio' }, [
      view(decl({ runsOn: 'studio', runsHere: true })),
      view(decl({ runsOn: 'every' }))
    ])
    const out = await listRoutinesTool(deps(local, studio), {})
    expect(out.routines.map((r) => [r.machine.id, r.name, r.runsOn, r.problems])).toEqual([
      ['local', 'Health', 'every', []],
      ['srv-1', 'Health', 'studio', []],
      ['srv-1', 'Health', 'every', []]
    ])
    expect(out.machines).toEqual([
      { id: 'local', label: 'This Mac', ownName: 'mac', reachable: true },
      { id: 'srv-1', label: 'MacStudio', ownName: 'studio', reachable: true }
    ])
  })

  it('keeps a routine placed on a machine nobody answers to, with the problem, and says which machine is down', async () => {
    const ghost = decl({ runsOn: 'ghost-server', runsHere: false })
    const broken = decl({
      name: 'Broken',
      runsOn: null,
      runsHere: false,
      invalid: 'say where it runs: runsOn'
    })
    const local = machine('local', 'This Mac', { id: 'l', name: 'mac' }, [
      view(ghost),
      view(broken)
    ])
    const down = machine('srv-1', 'MacStudio', null, [], { fail: 'timeout' })
    const out = await listRoutinesTool(deps(local, down), {})
    expect(out.routines.map((r) => [r.name, r.problems])).toEqual([
      ['Health', ['runs on "ghost-server", a machine none of the reachable servers answers to']],
      ['Broken', ['say where it runs: runsOn']]
    ])
    expect(out.machines[1]).toEqual({
      id: 'srv-1',
      label: 'MacStudio',
      ownName: null,
      reachable: false,
      error: 'timeout'
    })
  })

  it('a twin is matched by its file under the root, not by a name: a same-named routine in another file drops nothing', async () => {
    const pinned = decl({ runsOn: 'studio', runsHere: false })
    const local = machine('local', 'This Mac', { id: 'l', name: 'mac' }, [view(pinned)])
    const otherFile = decl({
      runsOn: 'studio',
      rootDir: '/box',
      file: '/box/.clave/workspaces/other.clave',
      key: '/box/.clave/workspaces/other.clave::Health'
    })
    const sameFileOtherRoot = decl({
      runsOn: 'studio',
      rootDir: '/box',
      file: '/box/.clave/workspaces/default.clave',
      key: '/box/.clave/workspaces/default.clave::Health'
    })
    const studioOther = machine('srv-1', 'MacStudio', { id: 's', name: 'studio' }, [
      view(otherFile)
    ])
    expect(
      (await listRoutinesTool(deps(local, studioOther), {})).routines.map((r) => [
        r.machine.id,
        r.name
      ])
    ).toEqual([
      ['local', 'Health'],
      ['srv-1', 'Health']
    ])
    const studioSame = machine('srv-1', 'MacStudio', { id: 's', name: 'studio' }, [
      view(sameFileOtherRoot)
    ])
    expect(
      (await listRoutinesTool(deps(local, studioSame), {})).routines.map((r) => [
        r.machine.id,
        r.name
      ])
    ).toEqual([['srv-1', 'Health']])
  })

  it('keeps a placed routine whose owner is reachable but does not list it, saying the file is not read there', async () => {
    const pinned = decl({ runsOn: 'studio', runsHere: false })
    const local = machine('local', 'This Mac', { id: 'l', name: 'mac' }, [view(pinned)])
    const studio = machine('srv-1', 'MacStudio', { id: 's', name: 'studio' }, [
      view(decl({ name: 'Other' }))
    ])
    const out = await listRoutinesTool(deps(local, studio), {})
    expect(out.routines.map((r) => [r.machine.id, r.name, r.problems])).toEqual([
      [
        'local',
        'Health',
        ['runs on "studio", which does not list it: that machine does not read this file']
      ],
      ['srv-1', 'Other', []]
    ])
  })

  it('filters by workspace and by machine', async () => {
    const local = machine('local', 'This Mac', { id: 'l', name: 'mac' }, [
      view(decl({ workspaceId: 'ws' })),
      view(decl({ name: 'Elsewhere', workspaceId: 'ws2', workspaceName: 'Other' }))
    ])
    const studio = machine('srv-1', 'MacStudio', { id: 's', name: 'studio' }, [
      view(decl({ name: 'Remote' }))
    ])
    expect(
      (await listRoutinesTool(deps(local, studio), { workspace: 'other' })).routines.map(
        (r) => r.name
      )
    ).toEqual(['Elsewhere'])
    expect(
      (await listRoutinesTool(deps(local, studio), { machine: 'studio' })).routines.map(
        (r) => r.name
      )
    ).toEqual(['Remote'])
  })

  it('a listing says a created routine’s origin, its pause and its last run', () => {
    const created = decl({
      key: 'created::a',
      origin: 'created',
      paused: true,
      runsOn: 'mac',
      file: '/data/routines-created.json'
    })
    const l = {
      machine: machine('local', 'This Mac', null, []),
      listing: {
        routines: [
          view(created, [
            {
              id: 'r',
              routineKey: 'created::a',
              trigger: 'scheduled',
              startedAt: 9,
              endedAt: 10,
              state: 'attention',
              headline: 'Look',
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
              seen: false
            }
          ])
        ],
        viewer: { url: null, note: '' },
        server: { id: 'l', name: 'mac' }
      },
      error: null
    }
    expect(rowsOf([l]).routines[0]).toMatchObject({
      origin: 'created',
      file: null,
      paused: true,
      lastRun: { state: 'attention', headline: 'Look', at: 9 }
    })
  })
})

describe('update, delete, pause and run find the routine by its key', () => {
  it('reach the one machine that lists the key, and ask for the machine when two run it', async () => {
    const local = machine('local', 'This Mac', { id: 'l', name: 'mac' }, [
      view(decl({ key: 'created::a', origin: 'created' }))
    ])
    const studio = machine('srv-1', 'MacStudio', { id: 's', name: 'studio' }, [
      view(decl({ key: 'created::b', origin: 'created' }))
    ])
    await updateRoutineTool(deps(local, studio), {
      key: 'created::b',
      schedule: '0 9 * * *',
      model: 'm'
    })
    expect(studio.calls).toEqual([
      'update:created::b:{"schedule":"0 9 * * *","launch":{"model":"m"}}'
    ])
    await pauseRoutineTool(deps(local, studio), { key: 'created::a', paused: true })
    await deleteRoutineTool(deps(local, studio), { key: 'created::a' })
    const ran = (await runRoutineTool(deps(local, studio), { key: 'created::b' })) as Record<
      string,
      unknown
    >
    expect(local.calls).toEqual(['pause:created::a:true', 'delete:created::a'])
    expect(ran).toMatchObject({ ok: true, run: { id: 'run-1', state: 'running' } })
    await expect(deleteRoutineTool(deps(local, studio), { key: 'created::zzz' })).rejects.toThrow(
      /No routine "created::zzz" on any reachable machine/
    )
    // The same file on both, placed on every: both run it, so the machine is asked for.
    const both1 = machine('local', 'This Mac', { id: 'l', name: 'mac' }, [view(decl())])
    const both2 = machine('srv-1', 'MacStudio', { id: 's', name: 'studio' }, [view(decl())])
    await expect(runRoutineTool(deps(both1, both2), { key: decl().key })).rejects.toThrow(
      /exists on This Mac and MacStudio: say which machine/
    )
    await runRoutineTool(deps(both1, both2), { key: decl().key, machine: 'studio' })
    expect(both2.calls).toEqual([`run:${decl().key}`])
    // A file routine placed on the studio: the Mac lists it too, the studio runs it, so the studio is meant.
    const pinnedMac = machine('local', 'This Mac', { id: 'l', name: 'mac' }, [
      view(decl({ runsOn: 'studio', runsHere: false }))
    ])
    const pinnedStudio = machine('srv-1', 'MacStudio', { id: 's', name: 'studio' }, [
      view(decl({ runsOn: 'studio' }))
    ])
    await runRoutineTool(deps(pinnedMac, pinnedStudio), { key: decl().key })
    expect(pinnedStudio.calls).toEqual([`run:${decl().key}`])
    expect(pinnedMac.calls).toEqual([])
  })
})

describe('clave_routine_move_to_file', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'move-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const createdOn = (own: string, template: string, root: string): RoutineDeclaration =>
    decl({
      key: 'created::a',
      origin: 'created',
      runsOn: own,
      file: '/data/routines-created.json',
      rootDir: root,
      cwd: root,
      name: 'Morning digest',
      launch: { model: 'm', dangerousMode: true },
      icon: 'bolt',
      report: {
        template,
        schema: join(template, 'schema.json'),
        width: 560,
        height: 640,
        publish: true
      }
    })

  it('writes the routine into the profile file’s first group with runsOn, copies the built-in page under the root, then deletes it from the store', async () => {
    const builtIn = join(root, 'app', 'default-report')
    mkdirSync(builtIn, { recursive: true })
    writeFileSync(join(builtIn, 'index.html'), '<html/>')
    writeFileSync(join(builtIn, 'schema.json'), '{}')
    const ws = join(root, 'ws')
    const profile = join(ws, '.clave', 'workspaces', 'default.clave')
    const local = machine(
      'local',
      'This Mac',
      { id: 'l', name: 'mac' },
      [view(createdOn('mac', builtIn, ws))],
      {
        workspaces: async () => [{ id: 'ws', name: 'Work', rootDir: ws, profileFile: profile }]
      }
    )
    local.files.read = async () => ({
      type: 'multi',
      groups: [
        { name: 'Ops', cwd: ws, color: 'teal', sessions: [], terminals: [] },
        { name: 'Other', cwd: ws, color: null, sessions: [], terminals: [] }
      ]
    })
    local.files.copyDir = copyDirSync
    const out = (await moveRoutineToFileTool(deps(local), { key: 'created::a' })) as Record<
      string,
      unknown
    >
    expect(out).toMatchObject({ ok: true, file: profile, group: 'Ops', runsOn: 'mac' })
    const data = local.written[profile]
    expect(data.groups).toHaveLength(2)
    const routine = data.groups![0].routines![0]
    expect(routine).toMatchObject({
      name: 'Morning digest',
      schedule: '30 8 * * 1-5',
      runsOn: 'mac',
      model: 'm',
      dangerousMode: true,
      icon: 'bolt',
      cwd: ws,
      report: { template: join(ws, '.clave', 'routines', 'morning-digest'), publish: true }
    })
    expect(routine).not.toHaveProperty('server')
    expect(
      readFileSync(join(ws, '.clave', 'routines', 'morning-digest', 'index.html'), 'utf8')
    ).toBe('<html/>')
    expect(local.calls).toEqual(['delete:created::a'])
  })

  it('deletes from the store before writing the file, keeps the prompt as written, and takes a free folder for the page', async () => {
    const builtIn = join(root, 'app', 'default-report')
    mkdirSync(builtIn, { recursive: true })
    writeFileSync(join(builtIn, 'index.html'), '<html/>')
    const ws = join(root, 'ws')
    mkdirSync(join(ws, '.clave', 'routines', 'morning-digest'), { recursive: true })
    writeFileSync(
      join(ws, '.clave', 'routines', 'morning-digest', 'index.html'),
      'someone else’s page'
    )
    const order: string[] = []
    const created = { ...createdOn('mac', builtIn, ws), promptTemplate: 'Read @root_path now' }
    const local = machine('local', 'This Mac', { id: 'l', name: 'mac' }, [view(created)], {
      workspaces: async () => [{ id: 'ws', name: 'Work', rootDir: ws, profileFile: null }]
    })
    const write = local.files.write
    local.files.write = async (file, data, rootDir) => {
      order.push('write')
      await write(file, data, rootDir)
    }
    const del = local.routines.delete
    local.routines.delete = async (key) => {
      order.push('delete')
      await del(key)
    }
    local.files.copyDir = copyDirSync
    const out = (await moveRoutineToFileTool(deps(local), { key: 'created::a' })) as Record<
      string,
      unknown
    >
    expect(order).toEqual(['delete', 'write'])
    const file = join(ws, '.clave', 'workspaces', 'default.clave')
    const routine = local.written[file].routines![0]
    expect(routine.prompt).toBe('Read @root_path now')
    expect(out.template).toBe(join(ws, '.clave', 'routines', 'morning-digest-2'))
    expect(
      readFileSync(join(ws, '.clave', 'routines', 'morning-digest-2', 'index.html'), 'utf8')
    ).toBe('<html/>')
    expect(
      readFileSync(join(ws, '.clave', 'routines', 'morning-digest', 'index.html'), 'utf8')
    ).toBe('someone else’s page')
  })

  it('a delete the machine refuses (a run in flight) leaves the file unwritten', async () => {
    const ws = join(root, 'ws')
    const tpl = join(ws, '.clave', 'routines', 'own')
    mkdirSync(tpl, { recursive: true })
    const local = machine(
      'local',
      'This Mac',
      { id: 'l', name: 'mac' },
      [view(createdOn('mac', tpl, ws))],
      {
        workspaces: async () => [{ id: 'ws', name: 'Work', rootDir: ws, profileFile: null }]
      }
    )
    local.routines.delete = async () => {
      throw new Error('"Morning digest" is running; wait for it to end')
    }
    await expect(moveRoutineToFileTool(deps(local), { key: 'created::a' })).rejects.toThrow(
      /is running/
    )
    expect(Object.keys(local.written)).toEqual([])
  })

  it('a write that fails after the delete puts the routine back in the store and says so', async () => {
    const ws = join(root, 'ws')
    const tpl = join(ws, '.clave', 'routines', 'own')
    mkdirSync(tpl, { recursive: true })
    const local = machine(
      'local',
      'This Mac',
      { id: 'l', name: 'mac' },
      [view(createdOn('mac', tpl, ws))],
      {
        workspaces: async () => [{ id: 'ws', name: 'Work', rootDir: ws, profileFile: null }]
      }
    )
    local.files.write = async () => {
      throw new Error('EACCES')
    }
    await expect(moveRoutineToFileTool(deps(local), { key: 'created::a' })).rejects.toThrow(
      /could not be written \(EACCES\); the routine stays in This Mac’s store/
    )
    expect(local.calls).toEqual(['delete:created::a', 'create:ws:Morning digest'])
  })

  it('an empty or single-group file gets the group named, or Routines', async () => {
    const ws = join(root, 'ws')
    const tpl = join(ws, '.clave', 'routines', 'own')
    mkdirSync(tpl, { recursive: true })
    const local = machine(
      'local',
      'This Mac',
      { id: 'l', name: 'mac' },
      [view(createdOn('mac', tpl, ws))],
      {
        workspaces: async () => [{ id: 'ws', name: 'Work', rootDir: ws, profileFile: null }]
      }
    )
    const out = (await moveRoutineToFileTool(deps(local), {
      key: 'created::a',
      group: 'Jobs'
    })) as Record<string, unknown>
    const file = join(ws, '.clave', 'workspaces', 'default.clave')
    expect(out).toMatchObject({ file, group: 'Jobs' })
    expect(local.written[file]).toMatchObject({
      name: 'Jobs',
      routines: [{ name: 'Morning digest', report: { template: tpl } }]
    })
    expect(local.written[file]).not.toHaveProperty('groups')
  })

  it('refuses a file routine, a machine with no files, a built-in page on a remote, and a twin name', async () => {
    const ws = join(root, 'ws')
    const fileRoutine = machine('local', 'This Mac', { id: 'l', name: 'mac' }, [view(decl())])
    await expect(moveRoutineToFileTool(deps(fileRoutine), { key: decl().key })).rejects.toThrow(
      /already comes from/
    )
    const remote = machine(
      'srv-1',
      'MacStudio',
      { id: 's', name: 'studio' },
      [view(createdOn('studio', '/app/default', ws))],
      {
        workspaces: async () => [{ id: 'ws', name: 'Work', rootDir: ws, profileFile: null }]
      }
    )
    remote.files.copyDir = undefined
    await expect(moveRoutineToFileTool(deps(remote), { key: 'created::a' })).rejects.toThrow(
      /built-in report page, which a file cannot name on MacStudio/
    )
    const tpl = join(ws, '.clave', 'routines', 'own')
    const twin = machine(
      'local',
      'This Mac',
      { id: 'l', name: 'mac' },
      [view(createdOn('mac', tpl, ws))],
      {
        workspaces: async () => [{ id: 'ws', name: 'Work', rootDir: ws, profileFile: null }]
      }
    )
    twin.files.read = async () => ({
      type: 'single',
      name: 'Ops',
      cwd: ws,
      color: null,
      sessions: [],
      terminals: [],
      routines: [{ name: 'morning digest', schedule: '0 0 * * *', prompt: 'x' }]
    })
    await expect(moveRoutineToFileTool(deps(twin), { key: 'created::a' })).rejects.toThrow(
      /already has a routine named/
    )
    const noFiles = {
      ...machine('local', 'This Mac', { id: 'l', name: 'mac' }, [view(createdOn('mac', tpl, ws))]),
      files: undefined
    }
    await expect(moveRoutineToFileTool(deps(noFiles), { key: 'created::a' })).rejects.toThrow(
      /offers no file writes/
    )
  })
})

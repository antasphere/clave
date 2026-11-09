import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceFiles, memoryWorkspaceFilesStorage } from '@clave/server/workspace-files'
import {
  MAX_TIMEOUT_MINUTES,
  type ServerIdentity,
  defaultServerName,
  placementOf,
  placementProblem,
  resolveRoutines,
  runsOn,
  substituteParams
} from './resolve'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clave-routines-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(join(root, '..', 'clave-routines-outside'), { recursive: true, force: true })
})

const INDEX = '<html><script type="application/json" id="slideless-data">{}</script></html>'

function template(dir: string, name: string): void {
  const folder = join(dir, '.clave', 'routines', name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'index.html'), INDEX)
  writeFileSync(join(folder, 'schema.json'), '{"type":"object"}')
}

function profile(dir: string, name: string, doc: unknown): string {
  mkdirSync(join(dir, '.clave', 'workspaces'), { recursive: true })
  const file = join(dir, '.clave', 'workspaces', `${name}.clave`)
  writeFileSync(file, JSON.stringify(doc))
  return file
}

const health = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Workspace health',
  schedule: '30 8 * * 1-5',
  prompt: 'Check @root_path and fix what is safe. {{extra}} {{unknown}}',
  params: { extra: 'Be brief.' },
  skill: 'steward:workspace-health',
  icon: 'shield',
  color: 'teal',
  dangerous: true,
  report: { template: '.clave/routines/workspace-health', width: 600 },
  runsOn: 'every',
  ...extra
})

describe('substituteParams', () => {
  it('fills the declared params and leaves an unknown placeholder as written', () => {
    expect(substituteParams('a {{x}} {{ y }} {{z}}', { x: '1', y: '2' })).toBe('a 1 2 {{z}}')
    expect(substituteParams('a {{x}}', undefined)).toBe('a {{x}}')
  })
})

describe('resolveRoutines', () => {
  it('reads the trusted profile file, resolves paths, substitutes the prompt, defaults the report', async () => {
    template(root, 'workspace-health')
    const file = profile(root, 'default', {
      groups: [
        {
          name: 'Antasphere',
          cwd: '.',
          toolbar: true,
          sessions: [],
          terminals: [],
          routines: [health()]
        }
      ]
    })
    const files = new WorkspaceFiles(memoryWorkspaceFilesStorage())
    files.trustRoot(root)
    const { declarations, files: read } = await resolveRoutines(files, [
      { id: 'ws', name: 'Antasphere', rootDir: root, profileFile: file }
    ])
    expect(read).toEqual([file])
    expect(declarations).toHaveLength(1)
    const d = declarations[0]
    expect(d).toMatchObject({
      key: `${file}::Workspace health`,
      name: 'Workspace health',
      file,
      rootDir: root,
      group: 'Antasphere',
      workspaceId: 'ws',
      schedule: '30 8 * * 1-5',
      skill: 'steward:workspace-health',
      cwd: root,
      launch: { dangerousMode: true },
      icon: 'shield',
      color: 'teal',
      catchUp: true,
      timeoutMinutes: 30,
      scope: 'machine',
      report: {
        template: join(root, '.clave', 'routines', 'workspace-health'),
        schema: join(root, '.clave', 'routines', 'workspace-health', 'schema.json'),
        width: 600,
        height: 640
      },
      invalid: null
    })
    expect(d.prompt).toBe(`Check ${root} and fix what is safe. Be brief. {{unknown}}`)
  })

  it('contributes nothing from an untrusted file: the scheduler never asks for a review', async () => {
    template(root, 'workspace-health')
    const file = profile(root, 'default', {
      name: 'G',
      cwd: '.',
      sessions: [],
      terminals: [],
      routines: [health()]
    })
    const files = new WorkspaceFiles(memoryWorkspaceFilesStorage())
    const { declarations } = await resolveRoutines(files, [
      { id: 'ws', name: 'A', rootDir: root, profileFile: file }
    ])
    expect(declarations).toEqual([])
  })

  it('marks what can never run: team scope, a bad schedule, a missing or escaping template, a twin name', async () => {
    template(root, 'ok')
    // A real template folder OUTSIDE the file's root: the escape is refused as such.
    template(join(root, '..', 'clave-routines-outside'), 'ok')
    const file = profile(root, 'default', {
      name: 'G',
      cwd: '.',
      sessions: [],
      terminals: [],
      routines: [
        health({ name: 'team', scope: 'team', report: { template: '.clave/routines/ok' } }),
        health({
          name: 'cron',
          schedule: '99 * * * *',
          report: { template: '.clave/routines/ok' }
        }),
        health({ name: 'missing', report: { template: '.clave/routines/nope' } }),
        health({
          name: 'escape',
          report: { template: '../clave-routines-outside/.clave/routines/ok' }
        }),
        health({ name: 'bare', report: undefined }),
        health({ name: 'twin', report: { template: '.clave/routines/ok' } }),
        health({ name: 'twin', report: { template: '.clave/routines/ok' } })
      ]
    })
    const files = new WorkspaceFiles(memoryWorkspaceFilesStorage())
    files.trustRoot(root)
    const { declarations } = await resolveRoutines(files, [
      { id: 'ws', name: 'A', rootDir: root, profileFile: file }
    ])
    const byName = Object.fromEntries(declarations.map((d) => [d.key.split('::')[1], d.invalid]))
    expect(byName.team).toBe('team scope is not built yet')
    expect(byName.cron).toContain('the schedule does not parse')
    expect(byName.missing).toContain('does not exist')
    expect(byName.escape).toContain('outside')
    expect(byName.bare).toContain('no report template')
    expect(byName.twin).toBeNull()
    expect(byName['twin#2']).toContain('also named "twin"')
  })

  it('finds the discovered default when the workspace names no profile, and the project files under auto-discovery', async () => {
    template(root, 'ok')
    profile(root, 'default', {
      name: 'Root',
      cwd: '.',
      sessions: [],
      terminals: [],
      routines: [health({ name: 'root', report: { template: '.clave/routines/ok' } })],
      autoDiscover: { enabled: true, maxDepth: 3 }
    })
    const project = join(root, 'labs', 'proj')
    template(project, 'ok')
    profile(project, 'default', {
      name: 'Proj',
      cwd: '.',
      sessions: [],
      terminals: [],
      routines: [health({ name: 'proj', report: { template: '.clave/routines/ok' } })]
    })
    // A same-named personal profile wins inside the project.
    profile(project, 'romain', {
      name: 'Proj',
      cwd: '.',
      sessions: [],
      terminals: [],
      routines: [health({ name: 'proj-romain', report: { template: '.clave/routines/ok' } })]
    })
    const files = new WorkspaceFiles(memoryWorkspaceFilesStorage())
    files.trustRoot(root)
    const fromDefault = await resolveRoutines(files, [
      { id: 'ws', name: 'A', rootDir: root, profileFile: null }
    ])
    expect(fromDefault.declarations.map((d) => d.name).sort()).toEqual(['proj', 'root'])
    const romain = join(root, '.clave', 'workspaces', 'romain.clave')
    writeFileSync(
      romain,
      JSON.stringify({ name: 'Root', cwd: '.', sessions: [], terminals: [], autoDiscover: true })
    )
    const fromRomain = await resolveRoutines(files, [
      { id: 'ws', name: 'A', rootDir: root, profileFile: romain }
    ])
    expect(fromRomain.declarations.map((d) => d.name)).toEqual(['proj-romain'])
    expect(fromRomain.declarations[0].workspaceId).toBe('ws')
    expect(fromRomain.declarations[0].cwd).toBe(project)
  })
})

describe('bounds and confinement (round 1, F5 and F11)', () => {
  it('clamps the timeout to a week and refuses a schema outside the file folder', async () => {
    template(root, 'ok')
    const file = profile(root, 'default', {
      name: 'G',
      cwd: '.',
      sessions: [],
      terminals: [],
      routines: [
        health({ name: 'long', timeoutMinutes: 40000, report: { template: '.clave/routines/ok' } }),
        health({
          name: 'schema-out',
          report: { template: '.clave/routines/ok', schema: '../elsewhere/schema.json' }
        })
      ]
    })
    const files = new WorkspaceFiles(memoryWorkspaceFilesStorage())
    files.trustRoot(root)
    const { declarations } = await resolveRoutines(files, [
      { id: 'ws', name: 'A', rootDir: root, profileFile: file }
    ])
    const byName = Object.fromEntries(declarations.map((d) => [d.name, d]))
    expect(byName.long.timeoutMinutes).toBe(MAX_TIMEOUT_MINUTES)
    expect(byName.long.invalid).toBeNull()
    expect(byName['schema-out'].invalid).toContain('schema')
    expect(byName['schema-out'].invalid).toContain('outside')
  })
})

describe('where a routine runs (PRDCT-4241)', () => {
  const studio: ServerIdentity = { id: 'srv-1', name: 'Studio' }
  const on = (where?: string, server?: string): boolean =>
    runsOn(
      placementOf({
        ...(where !== undefined ? { runsOn: where } : {}),
        ...(server !== undefined ? { server } : {})
      }),
      studio
    )

  it('runs on every machine only when the declaration says every, whatever the case', () => {
    expect(on('every')).toBe(true)
    expect(on(' Every ')).toBe(true)
    expect(placementOf({ runsOn: 'every' })).toEqual({ kind: 'every' })
  })

  it('runs on the one machine named, by its own name or its id, never elsewhere', () => {
    expect(on('srv-1')).toBe(true)
    expect(on('studio')).toBe(true)
    expect(on('  STUDIO ')).toBe(true)
    expect(on('MacBook')).toBe(false)
    expect(on('srv-2')).toBe(false)
    expect(placementOf({ runsOn: ' Studio ' })).toEqual({ kind: 'machine', name: 'Studio' })
  })

  it('runs nowhere when the declaration says nothing, and says so', () => {
    expect(on()).toBe(false)
    expect(on('')).toBe(false)
    expect(on('   ')).toBe(false)
    expect(placementOf({})).toEqual({ kind: 'missing' })
    expect(placementProblem({ kind: 'missing' })).toMatch(/runsOn/)
    expect(placementProblem({ kind: 'missing' })).toMatch(/every/)
  })

  it('runs nowhere on the field runsOn replaced, naming the value to move', () => {
    expect(on(undefined, 'Studio')).toBe(false)
    expect(placementOf({ server: ' Studio ' })).toEqual({ kind: 'legacy', server: 'Studio' })
    expect(placementProblem({ kind: 'legacy', server: 'Studio' })).toBe(
      '"server" is no longer read: write runsOn: "Studio"'
    )
    // runsOn wins when both are written: the file was migrated and kept the old line.
    expect(placementOf({ runsOn: 'every', server: 'Studio' })).toEqual({ kind: 'every' })
  })

  it('a placement that runs somewhere has no problem', () => {
    expect(placementProblem({ kind: 'every' })).toBeNull()
    expect(placementProblem({ kind: 'machine', name: 'x' })).toBeNull()
  })

  it('names a server after its hostname without .local, never with nothing', () => {
    expect(defaultServerName('MacStudio.local')).toBe('MacStudio')
    expect(defaultServerName('MacStudio.LOCAL')).toBe('MacStudio')
    expect(defaultServerName('  studio.Local  ')).toBe('studio')
    expect(defaultServerName('build-box')).toBe('build-box')
    expect(defaultServerName('romains-macbook-pro2.home')).toBe('romains-macbook-pro2')
    expect(defaultServerName('studio.lan')).toBe('studio')
    expect(defaultServerName('.odd')).toBe('clave-server')
    expect(defaultServerName('')).toBe('clave-server')
    expect(defaultServerName('   ')).toBe('clave-server')
  })

  async function read(identity?: ServerIdentity): Promise<Record<string, RoutineLike>> {
    template(root, 'ok')
    const file = profile(root, 'default', {
      name: 'G',
      cwd: '.',
      sessions: [],
      terminals: [],
      routines: [
        health({ name: 'pinned', runsOn: 'Studio', report: { template: '.clave/routines/ok' } }),
        health({ name: 'free', report: { template: '.clave/routines/ok' } }),
        health({ name: 'nowhere', runsOn: undefined, report: { template: '.clave/routines/ok' } }),
        health({
          name: 'legacy',
          runsOn: undefined,
          server: 'Studio',
          report: { template: '.clave/routines/ok' }
        }),
        health({
          name: 'published',
          report: { template: '.clave/routines/ok', publish: true }
        })
      ]
    })
    const files = new WorkspaceFiles(memoryWorkspaceFilesStorage())
    files.trustRoot(root)
    const { declarations } = await resolveRoutines(
      files,
      [{ id: 'ws', name: 'A', rootDir: root, profileFile: file }],
      undefined,
      identity
    )
    return Object.fromEntries(declarations.map((d) => [d.name, d]))
  }
  type RoutineLike = Awaited<ReturnType<typeof resolveRoutines>>['declarations'][number]

  it('runs a routine placed by name on the server of that name, whatever the case', async () => {
    const byName = await read({ id: 'x', name: 'studio' })
    expect(byName.pinned).toMatchObject({ runsOn: 'Studio', runsHere: true, origin: 'file' })
    expect(byName.free).toMatchObject({ runsOn: 'every', runsHere: true })
  })

  it('lists a routine that says nothing, or still says server, as unable to run anywhere', async () => {
    const byName = await read({ id: 'x', name: 'studio' })
    expect(byName.nowhere).toMatchObject({ runsOn: null, runsHere: false })
    expect(byName.nowhere.invalid).toMatch(/say where it runs: runsOn/)
    expect(byName.legacy).toMatchObject({ runsOn: null, runsHere: false })
    expect(byName.legacy.invalid).toBe('"server" is no longer read: write runsOn: "Studio"')
  })

  it('lists a routine pinned elsewhere without running it', async () => {
    const byName = await read({ id: 'y', name: 'MacBook' })
    expect(byName.pinned).toMatchObject({ runsOn: 'Studio', runsHere: false, invalid: null })
    expect(byName.free.runsHere).toBe(true)
  })

  it('runs only the routines placed on every machine for a reader with no identity', async () => {
    const byName = await read()
    expect(byName.pinned.runsHere).toBe(false)
    expect(byName.free.runsHere).toBe(true)
  })

  it('publishes nothing unless the report says so', async () => {
    const byName = await read({ id: 'x', name: 'studio' })
    expect(byName.free.report.publish).toBe(false)
    expect(byName.published.report.publish).toBe(true)
  })
})

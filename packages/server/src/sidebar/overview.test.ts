/**
 * The overview a phone reads (`overview.ts`): the projection keeps the
 * groups' order and the windows' order and drops every field that can drive
 * an agent or carry a path; the layouts source reads every window key the
 * server holds; the files source reads the app's own layout files, in the
 * app's window order with each window's workspace, never writes them, and
 * tells a change once the files settle.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import { SidebarOverview } from '@clave/contract/sidebar'
import { SidebarLayouts } from './layouts'
import { layoutsOverviewSource, projectSidebarOverview, shellFilesOverviewSource } from './overview'
import { memorySidebarStorage, noWindowsHost } from './ports'

/** A group as a layout file holds it, with every field that must not cross. */
const fullGroup = {
  id: 'g1',
  name: 'Api',
  sessionIds: ['s1', 's2'],
  collapsed: true,
  cwd: '/Users/someone/secret-repo',
  prompt: 'Deploy with the token in ~/.env',
  rootSession: true,
  color: 'purple',
  view: { url: 'http://localhost:4720', title: 'Board', terminalId: 't1' },
  workspaceId: 'ws-a',
  terminals: [
    {
      id: 't1',
      command: 'API_KEY=hunter2 npm run dev',
      commandMode: 'auto' as const,
      color: 'blue',
      icon: 'bolt',
      cwd: '/Users/someone/secret-repo/web',
      serverUrl: 'http://localhost:3000',
      groupView: true,
      sessionId: 'term-1'
    }
  ]
}

describe('the projection', () => {
  it('keeps the names, colours, folds, workspaces and members, and nothing else', () => {
    const overview = projectSidebarOverview([
      { windowKey: 'w1', workspaceId: 'ws-a', groups: [fullGroup], displayOrder: ['g1', 's9'] }
    ])
    expect(overview).toEqual({
      windows: [
        {
          windowKey: 'w1',
          workspaceId: 'ws-a',
          displayOrder: ['g1', 's9'],
          groups: [
            {
              id: 'g1',
              name: 'Api',
              color: 'purple',
              collapsed: true,
              workspaceId: 'ws-a',
              sessionIds: ['s1', 's2']
            }
          ]
        }
      ]
    })
    const text = JSON.stringify(overview)
    for (const leaked of ['secret-repo', 'token', 'hunter2', 'localhost', 'term-1', 'Board'])
      expect(text, leaked).not.toContain(leaked)
    // What the projection answers is what the contract encodes, unchanged.
    expect(Schema.encodeSync(SidebarOverview)(overview)).toEqual(overview)
  })
  it('leaves out a colour that is null and a workspace nobody knows', () => {
    const overview = projectSidebarOverview([
      {
        windowKey: 'w1',
        workspaceId: null,
        groups: [{ id: 'g1', name: 'Plain', sessionIds: [], collapsed: false, color: null }],
        displayOrder: []
      }
    ])
    expect(overview.windows[0]).toEqual({
      windowKey: 'w1',
      displayOrder: [],
      groups: [{ id: 'g1', name: 'Plain', collapsed: false, sessionIds: [] }]
    })
  })
  it('keeps every window, the groups and the top level in the order given', () => {
    const group = (id: string): typeof fullGroup => ({ ...fullGroup, id, name: id })
    const overview = projectSidebarOverview([
      { windowKey: 'w2', groups: [group('b'), group('a')], displayOrder: ['a', 'x', 'b'] },
      { windowKey: 'w1', groups: [group('c')], displayOrder: ['c'] }
    ])
    expect(overview.windows.map((w) => w.windowKey)).toEqual(['w2', 'w1'])
    expect(overview.windows[0].groups.map((g) => g.id)).toEqual(['b', 'a'])
    expect(overview.windows[0].displayOrder).toEqual(['a', 'x', 'b'])
  })
})

describe('the overview of the layouts a server holds', () => {
  it('reads every window key, with the workspace its window shows, and tells each change', () => {
    const storage = memorySidebarStorage()
    storage.documents.set('w1', { groups: [fullGroup], displayOrder: ['g1'] })
    storage.documents.set('w2', {
      groups: [{ id: 'g2', name: 'Docs', sessionIds: ['s3'] }],
      displayOrder: ['g2']
    })
    const layouts = new SidebarLayouts(storage, noWindowsHost)
    const source = layoutsOverviewSource(layouts, {
      workspaceOf: (key) => (key === 'w1' ? 'ws-a' : null)
    })
    const read = source.read()
    expect(read.windows.map((w) => [w.windowKey, w.workspaceId])).toEqual([
      ['w1', 'ws-a'],
      ['w2', undefined]
    ])
    expect(read.windows[1].groups).toEqual([
      { id: 'g2', name: 'Docs', collapsed: false, sessionIds: ['s3'] }
    ])
    let told = 0
    const off = source.onChange(() => told++)
    layouts.renameGroup('w2', 'g2', 'Notes')
    expect(told).toBe(1)
    expect(source.read().windows[1].groups[0].name).toBe('Notes')
    off()
    layouts.renameGroup('w2', 'g2', 'Again')
    expect(told).toBe(1)
  })
  it('reads the one shared sidebar of a daemon, whatever key a window names', () => {
    const layouts = new SidebarLayouts(memorySidebarStorage(), noWindowsHost, {
      layoutKey: 'server'
    })
    layouts.createGroup('any-window', { id: 'g1', name: 'Shared', sessionIds: ['s1'] })
    expect(layoutsOverviewSource(layouts).read()).toEqual({
      windows: [
        {
          windowKey: 'server',
          displayOrder: ['g1'],
          groups: [{ id: 'g1', name: 'Shared', collapsed: false, sessionIds: ['s1'] }]
        }
      ]
    })
  })
})

describe('the overview of the app’s own layout files', () => {
  let dir: string | null = null
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })
  const appFolder = async (): Promise<{ root: string; windows: string }> => {
    dir = await mkdtemp(join(tmpdir(), 'clave-overview-'))
    const windows = join(dir, 'sidebar-layouts', 'windows')
    await mkdir(windows, { recursive: true })
    return { root: dir, windows }
  }
  const until = async (check: () => boolean, ms = 3000): Promise<void> => {
    const end = Date.now() + ms
    while (!check()) {
      if (Date.now() > end) throw new Error('not within the time')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  it('reads the windows in the app’s order with their workspaces, strays after by key', async () => {
    const { root, windows } = await appFolder()
    await writeFile(
      join(root, 'windows.json'),
      JSON.stringify({
        version: 1,
        windows: [
          { key: 'kB', workspaceId: 'ws-b' },
          { key: 'kA', workspaceId: null },
          { key: 'kB', workspaceId: 'ws-dup' },
          { key: 'no-layout-yet', workspaceId: 'ws-c' }
        ]
      })
    )
    await writeFile(
      join(windows, 'kA.json'),
      JSON.stringify({ groups: [fullGroup], displayOrder: ['g1'], revision: 4 })
    )
    await writeFile(
      join(windows, 'kB.json'),
      JSON.stringify({ groups: [{ id: 'g2', name: 'B' }], displayOrder: ['g2'] })
    )
    await writeFile(join(windows, 'zStray.json'), '{ not json')
    await writeFile(join(windows, 'aStray.json'), JSON.stringify({ displayOrder: ['s5'] }))
    await writeFile(join(windows, 'kA.json.tmp'), 'half a save')
    const before = await readdir(windows)
    const overview = shellFilesOverviewSource(root).read()
    expect(overview).toEqual({
      windows: [
        {
          windowKey: 'kB',
          workspaceId: 'ws-b',
          displayOrder: ['g2'],
          groups: [{ id: 'g2', name: 'B', collapsed: false, sessionIds: [] }]
        },
        {
          windowKey: 'kA',
          displayOrder: ['g1'],
          groups: [
            {
              id: 'g1',
              name: 'Api',
              color: 'purple',
              collapsed: true,
              workspaceId: 'ws-a',
              sessionIds: ['s1', 's2']
            }
          ]
        },
        { windowKey: 'aStray', displayOrder: ['s5'], groups: [] },
        // A file that does not parse reads as an empty sidebar, never a failure.
        { windowKey: 'zStray', displayOrder: [], groups: [] }
      ]
    })
    expect(JSON.stringify(overview)).not.toContain('hunter2')
    // Read only: nothing written, renamed or removed in the app's folder.
    expect(await readdir(windows)).toEqual(before)
    expect(await readFile(join(windows, 'kA.json.tmp'), 'utf8')).toBe('half a save')
  })
  it('answers no window for an app that never saved a layout', async () => {
    dir = await mkdtemp(join(tmpdir(), 'clave-overview-'))
    expect(shellFilesOverviewSource(dir).read()).toEqual({ windows: [] })
  })
  it('tells a change once the app’s save has settled, and stops when nobody listens', async () => {
    const { root, windows } = await appFolder()
    const source = shellFilesOverviewSource(root, { settleMs: 100 })
    let told = 0
    const off = source.onChange(() => told++)
    // A save as the app writes it: the `.tmp`, then the rename over the file.
    await writeFile(join(windows, 'k1.json.tmp'), JSON.stringify({ displayOrder: ['s1'] }))
    const { rename } = await import('node:fs/promises')
    await rename(join(windows, 'k1.json.tmp'), join(windows, 'k1.json'))
    await until(() => told >= 1)
    expect(source.read().windows).toEqual([{ windowKey: 'k1', displayOrder: ['s1'], groups: [] }])
    await new Promise((resolve) => setTimeout(resolve, 250))
    // One save, one notice: the events of the write and the rename are folded.
    expect(told).toBe(1)
    off()
    await writeFile(join(windows, 'k2.json'), JSON.stringify({ displayOrder: [] }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(told).toBe(1)
  })
  it('finds the folder once the app creates it, and tells that as a change', async () => {
    dir = await mkdtemp(join(tmpdir(), 'clave-overview-'))
    const source = shellFilesOverviewSource(dir, { settleMs: 20, rearmMs: 40 })
    let told = 0
    const off = source.onChange(() => told++)
    await mkdir(join(dir, 'sidebar-layouts', 'windows'), { recursive: true })
    await writeFile(join(dir, 'sidebar-layouts', 'windows', 'k1.json'), '{}')
    await until(() => told >= 1)
    expect(source.read().windows.map((w) => w.windowKey)).toEqual(['k1'])
    off()
  })
})

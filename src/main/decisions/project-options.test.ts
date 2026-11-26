import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceFiles, memoryWorkspaceFilesStorage } from '@clave/server/workspace-files'
import {
  describeGroup,
  folderOf,
  OPTION_DESCRIPTION_MAX,
  optionsOfGroups,
  projectOptionsOf
} from './project-options'

// The projects a tab may work on (PRDCT-5179): the groups of the workspace's
// own `.clave` files, read trusted-or-nothing, on invented groups.

describe('the pure helpers', () => {
  it('makes a folder relative to the workspace, the root empty, outside none', () => {
    expect(folderOf('/w/labs/quill', '/w')).toBe('labs/quill')
    expect(folderOf('/w', '/w/')).toBe('')
    expect(folderOf('/elsewhere/atlas', '/w')).toBeNull()
    expect(folderOf('/w-other/atlas', '/w')).toBeNull()
  })

  it("describes a group by its prompt, else its sessions' longest, clipped", () => {
    expect(describeGroup({ name: 'Quill', cwd: '/w', prompt: '  The Quill editor.  ' })).toBe(
      'The Quill editor.'
    )
    expect(
      describeGroup({
        name: 'Atlas',
        cwd: '/w',
        sessions: [{ prompt: 'Short.' }, { prompt: 'The Atlas maps, the longer one.' }, {}]
      })
    ).toBe('The Atlas maps, the longer one.')
    expect(describeGroup({ name: 'Lumen', cwd: '/w', sessions: [] })).toBe('')
    const long = describeGroup({ name: 'Long', cwd: '/w', prompt: 'x'.repeat(5000) })
    expect(long).toHaveLength(OPTION_DESCRIPTION_MAX)
    expect(long.endsWith('…')).toBe(true)
  })

  it('gives one option per described group inside the workspace, none for a shared name', () => {
    const options = optionsOfGroups(
      [
        {
          file: '/w/.clave/workspaces/default.clave',
          groups: [
            { name: 'Workspace', cwd: '/w', prompt: 'The whole workspace.' },
            { name: 'Quill', cwd: '/w/labs/quill', prompt: 'The Quill editor.' },
            { name: 'Silent', cwd: '/w/labs/silent' },
            { name: 'Outside', cwd: '/tmp/outside', prompt: 'Not ours.' },
            { name: 'Twin', cwd: '/w/a', prompt: 'One twin.' }
          ]
        },
        {
          file: '/w/labs/atlas/.clave/workspaces/default.clave',
          groups: [
            { name: 'Atlas', cwd: '/w/labs/atlas', sessions: [{ prompt: 'The Atlas maps.' }] },
            { name: 'Twin', cwd: '/w/b', prompt: 'The other twin.' }
          ]
        }
      ],
      '/w'
    )
    expect(options).toEqual([
      {
        file: '/w/.clave/workspaces/default.clave',
        name: 'Workspace',
        folder: '',
        description: 'The whole workspace.'
      },
      {
        file: '/w/.clave/workspaces/default.clave',
        name: 'Quill',
        folder: 'labs/quill',
        description: 'The Quill editor.'
      },
      {
        file: '/w/labs/atlas/.clave/workspaces/default.clave',
        name: 'Atlas',
        folder: 'labs/atlas',
        description: 'The Atlas maps.'
      }
    ])
  })
})

describe('projectOptionsOf', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clave-decisions-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function profile(dir: string, doc: unknown): string {
    mkdirSync(join(dir, '.clave', 'workspaces'), { recursive: true })
    const file = join(dir, '.clave', 'workspaces', 'default.clave')
    writeFileSync(file, JSON.stringify(doc))
    return file
  }

  const doc = {
    autoDiscover: { enabled: true, maxDepth: 4 },
    groups: [
      { name: 'Workspace', cwd: '.', prompt: 'The whole workspace.', sessions: [], terminals: [] }
    ]
  }

  it('reads the profile file and the discovered ones, when they are trusted', async () => {
    const file = profile(root, doc)
    const quill = join(root, 'labs', 'quill')
    const quillFile = profile(quill, {
      name: 'Quill',
      cwd: '.',
      prompt: 'The Quill editor.',
      sessions: [],
      terminals: []
    })
    const files = new WorkspaceFiles(memoryWorkspaceFilesStorage())
    files.trustRoot(root)
    files.trustRoot(quill)
    const options = await projectOptionsOf(files, {
      id: 'ws',
      name: 'W',
      rootDir: root,
      profileFile: file
    })
    expect(options).toEqual([
      { file, name: 'Workspace', folder: '', description: 'The whole workspace.' },
      { file: quillFile, name: 'Quill', folder: 'labs/quill', description: 'The Quill editor.' }
    ])
  })

  it('a file nobody trusted gives nothing, and asks nobody', async () => {
    const file = profile(root, doc)
    const files = new WorkspaceFiles(memoryWorkspaceFilesStorage())
    expect(
      await projectOptionsOf(files, { id: 'ws', name: 'W', rootDir: root, profileFile: file })
    ).toEqual([])
  })
})

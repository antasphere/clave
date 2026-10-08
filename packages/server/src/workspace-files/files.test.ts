/**
 * The `WorkspaceFiles` class on a real folder: the trust store behind its
 * storage, the review's four answers, the writer's echo, the watcher and the
 * discovery walks. The HTTP and push shape of the same domain is
 * `workspace-files.test.ts`; the pure trust boundary is `trust.test.ts`.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReviewAnswer } from '@clave/contract/workspace-files'
import {
  TRUSTED_CONTENT_FILE,
  TRUSTED_ROOTS_FILE,
  WorkspaceFiles,
  fileWorkspaceFilesStorage,
  memoryWorkspaceFilesStorage,
  type ReviewRequest
} from './files'

let root: string
let files: WorkspaceFiles
let storage: ReturnType<typeof memoryWorkspaceFilesStorage>

const single = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    $schema: 'clave/1.0',
    name: 'Lane',
    cwd: '.',
    sessions: [{ cwd: '.', name: 'tab', claudeMode: true, dangerousMode: false }],
    terminals: [],
    ...overrides
  })

const answering =
  (answer: ReviewAnswer | null, seen: ReviewRequest[] = []) =>
  async (request: ReviewRequest): Promise<ReviewAnswer | null> => {
    seen.push(request)
    return answer
  }

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'clave-wsf-')))
  storage = memoryWorkspaceFilesStorage()
  // A debounce wide enough that one edit's burst of kernel events (a rename
  // fires for the inode that left and the one that came) is one change.
  files = new WorkspaceFiles(storage, { debounceMs: 120, echoMs: 300 })
})
afterEach(() => {
  files.close()
  rmSync(root, { recursive: true, force: true })
})

describe('reading', () => {
  it('resolves paths against the file’s folder, or the root dir given', async () => {
    const file = join(root, 'a.clave')
    writeFileSync(file, single({ cwd: 'src', sessions: [{ cwd: 'lib', name: 't' }] }))
    const own = await files.read(file)
    expect(own).toMatchObject({ type: 'single', name: 'Lane', cwd: join(root, 'src') })
    expect(own?.type === 'single' && own.sessions[0].cwd).toBe(join(root, 'lib'))
    const other = await files.read(file, { rootDir: join(root, 'elsewhere') })
    expect(other?.type === 'single' && other.cwd).toBe(join(root, 'elsewhere', 'src'))
  })

  it('answers null for a missing, unparsable or non-document file, never a throw', async () => {
    expect(await files.read(join(root, 'none.clave'))).toBeNull()
    writeFileSync(join(root, 'bad.clave'), '{not json')
    expect(await files.read(join(root, 'bad.clave'))).toBeNull()
    writeFileSync(join(root, 'null.clave'), 'null')
    expect(await files.read(join(root, 'null.clave'))).toBeNull()
    writeFileSync(join(root, 'sessions-object.clave'), '{"sessions":{}}')
    expect(await files.read(join(root, 'sessions-object.clave'))).toBeNull()
    writeFileSync(join(root, 'groups-of-null.clave'), '{"groups":[null]}')
    expect(await files.read(join(root, 'groups-of-null.clave'))).toBeNull()
  })

  it('every field the parser produces survives the wire: the contract names them all', async () => {
    const { Schema } = await import('effect')
    const { ClaveFileReadResult } = await import('@clave/contract/workspace-files')
    const file = join(root, 'full.clave')
    writeFileSync(join(root, 'logo.png'), Buffer.from([1]))
    writeFileSync(
      file,
      JSON.stringify({
        name: 'Full',
        cwd: 'p',
        color: 'teal',
        toolbar: true,
        category: 'Work',
        logo: 'logo.png',
        prompt: 'G',
        view: 'page.html',
        sessions: [
          {
            cwd: 'lib',
            name: 't',
            claudeMode: true,
            antigravityMode: true,
            codexMode: true,
            piMode: true,
            claudeAgentsMode: true,
            dangerousMode: true,
            prompt: 'S',
            rootSession: true,
            account: 'Work'
          }
        ],
        terminals: [
          {
            command: 'npm run dev',
            commandMode: 'auto',
            color: 'blue',
            icon: 'bolt',
            cwd: 'web',
            autoLaunchLocalhost: true,
            persistent: true,
            serverUrl: 'http://localhost:3000',
            groupView: true
          }
        ]
      })
    )
    files.trustRoot(root)
    const result = await files.read(file)
    if (result?.type !== 'single') throw new Error('expected single')
    // Every optional field set: nothing undefined to be dropped by JSON.
    expect(Object.values(result).every((v) => v !== undefined)).toBe(true)
    expect(Object.values(result.sessions[0]).every((v) => v !== undefined)).toBe(true)
    expect(Object.values(result.terminals[0]).every((v) => v !== undefined)).toBe(true)
    const overTheWire = Schema.decodeUnknownSync(ClaveFileReadResult)(
      JSON.parse(JSON.stringify(Schema.encodeSync(ClaveFileReadResult)(result)))
    )
    expect(overTheWire).toEqual(result)
  })

  it('reads a multi-group file as multi, naming an unnamed group by its place', async () => {
    const file = join(root, 'm.clave')
    writeFileSync(file, JSON.stringify({ groups: [{ cwd: '.' }, { name: 'Two', cwd: 'b' }] }))
    const result = await files.read(file)
    expect(result?.type).toBe('multi')
    if (result?.type !== 'multi') throw new Error('expected multi')
    expect(result.groups.map((g) => g.name)).toEqual(['Group 1', 'Two'])
  })

  it('does not consult the reviewer for a file with nothing elevated', async () => {
    const file = join(root, 'plain.clave')
    writeFileSync(file, single())
    const seen: ReviewRequest[] = []
    expect(await files.read(file, { reviewer: answering(null, seen) })).not.toBeNull()
    expect(seen).toEqual([])
  })

  it('with no reviewer at hand, an elevated untrusted file is cancelled', async () => {
    const file = join(root, 'e.clave')
    writeFileSync(file, single({ prompt: 'do the thing' }))
    expect(await files.read(file)).toBeNull()
  })
})

describe('the review', () => {
  let file: string
  beforeEach(() => {
    file = join(root, 'elevated.clave')
    writeFileSync(
      file,
      single({
        prompt: 'GROUP-BRIEF drive the lane',
        sessions: [{ cwd: '.', name: 't', claudeMode: true, dangerousMode: true, prompt: 'S' }],
        terminals: [{ command: 'npm run dev', commandMode: 'auto', color: 'blue' }]
      })
    )
  })

  it('discloses exactly what would act on launch, and the folder the checkbox trusts', async () => {
    const seen: ReviewRequest[] = []
    await files.read(file, {
      rootDir: root,
      reviewer: answering({ response: 2, checkboxChecked: false }, seen)
    })
    expect(seen).toEqual([
      {
        path: file,
        folder: root,
        autoCommands: ['npm run dev'],
        prompts: ['GROUP-BRIEF drive the lane', 'S'],
        dangerous: true
      }
    ])
  })

  it('Cancel answers null and trusts nothing', async () => {
    expect(
      await files.read(file, { reviewer: answering({ response: 2, checkboxChecked: false }) })
    ).toBeNull()
    expect(storage.documents.size).toBe(0)
    expect(await files.read(file)).toBeNull()
  })

  it('Open safely answers the file sanitized and remembers nothing', async () => {
    const safe = await files.read(file, {
      reviewer: answering({ response: 0, checkboxChecked: false })
    })
    if (safe?.type !== 'single') throw new Error('expected single')
    expect(safe.prompt).toBeUndefined()
    expect(safe.sessions[0]).toMatchObject({ dangerousMode: false })
    expect(safe.sessions[0].prompt).toBeUndefined()
    expect(safe.terminals[0].commandMode).toBe('prefill')
    expect(storage.documents.size).toBe(0)
    // The next read asks again.
    const seen: ReviewRequest[] = []
    await files.read(file, { reviewer: answering({ response: 2, checkboxChecked: false }, seen) })
    expect(seen).toHaveLength(1)
  })

  it('Trust and run answers the file whole and trusts that exact content', async () => {
    const whole = await files.read(file, {
      reviewer: answering({ response: 1, checkboxChecked: false })
    })
    if (whole?.type !== 'single') throw new Error('expected single')
    expect(whole.prompt).toBe('GROUP-BRIEF drive the lane')
    expect(whole.terminals[0].commandMode).toBe('auto')
    expect(JSON.parse(storage.documents.get(TRUSTED_CONTENT_FILE) ?? '[]')).toHaveLength(1)
    expect(storage.documents.has(TRUSTED_ROOTS_FILE)).toBe(false)
    // No review on the next read of the same content; an edit asks again.
    const seen: ReviewRequest[] = []
    const again = await files.read(file, { reviewer: answering(null, seen) })
    expect(again?.type === 'single' && again.prompt).toBe('GROUP-BRIEF drive the lane')
    expect(seen).toEqual([])
    writeFileSync(file, single({ prompt: 'EDITED' }))
    expect(await files.read(file, { reviewer: answering(null, seen) })).toBeNull()
    expect(seen).toHaveLength(1)
  })

  it('the ticked folder checkbox trusts the folder and supersedes sanitizing', async () => {
    const safeButTrusted = await files.read(file, {
      rootDir: root,
      reviewer: answering({ response: 0, checkboxChecked: true })
    })
    expect(safeButTrusted?.type === 'single' && safeButTrusted.prompt).toBe(
      'GROUP-BRIEF drive the lane'
    )
    expect(files.listTrustedRoots()).toEqual([root])
    expect(JSON.parse(storage.documents.get(TRUSTED_ROOTS_FILE) ?? '[]')).toEqual([root])
    // Every file under the root now skips the review, edited or not.
    writeFileSync(file, single({ prompt: 'EDITED' }))
    const seen: ReviewRequest[] = []
    const next = await files.read(file, { reviewer: answering(null, seen) })
    expect(next?.type === 'single' && next.prompt).toBe('EDITED')
    expect(seen).toEqual([])
  })

  it('a trusted root is honoured through the root dir given, and forgotten on untrust', async () => {
    const nested = join(root, 'deep', 'er')
    mkdirSync(nested, { recursive: true })
    const deepFile = join(nested, 'x.clave')
    writeFileSync(deepFile, single({ prompt: 'P' }))
    files.trustRoot(root)
    expect((await files.read(deepFile))?.type).toBe('single')
    files.untrustRoot(root)
    expect(files.listTrustedRoots()).toEqual([])
    expect(await files.read(deepFile)).toBeNull()
  })

  it('a sibling folder is not under the trusted root (no prefix trick)', async () => {
    const sibling = `${root}-evil`
    mkdirSync(sibling, { recursive: true })
    try {
      writeFileSync(join(sibling, 's.clave'), single({ prompt: 'P' }))
      files.trustRoot(root)
      expect(await files.read(join(sibling, 's.clave'))).toBeNull()
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })
})

describe('the trust store on disk', () => {
  it('persists across instances, written then renamed', async () => {
    const data = join(root, 'data')
    const first = new WorkspaceFiles(fileWorkspaceFilesStorage(data))
    first.trustRoot(root)
    const second = new WorkspaceFiles(fileWorkspaceFilesStorage(data))
    expect(second.listTrustedRoots()).toEqual([root])
    writeFileSync(join(root, 'p.clave'), single({ prompt: 'P' }))
    expect((await second.read(join(root, 'p.clave')))?.type).toBe('single')
  })
})

describe('writing', () => {
  it('writes relative paths, mirrors the read, and trusts what it wrote', async () => {
    const file = join(root, 'out.clave')
    files.write(
      file,
      {
        name: 'Out',
        cwd: join(root, 'proj'),
        color: 'teal',
        prompt: 'AUTHORED brief',
        sessions: [
          {
            cwd: join(root, 'proj', 'lib'),
            name: 't',
            claudeMode: true,
            antigravityMode: false,
            codexMode: false,
            dangerousMode: false,
            account: 'Work'
          }
        ],
        terminals: [
          {
            command: 'npm run dev',
            commandMode: 'auto',
            color: 'blue',
            groupView: true,
            serverUrl: 'http://localhost:3000'
          }
        ]
      },
      root
    )
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    expect(raw).toMatchObject({ $schema: 'clave/1.0', cwd: 'proj', prompt: 'AUTHORED brief' })
    expect(raw.sessions[0]).toMatchObject({ cwd: 'proj/lib', account: 'Work' })
    expect(raw.terminals[0]).toMatchObject({ commandMode: 'auto', groupView: true })
    // Authored content is trusted: the elevated file opens whole with no reviewer.
    const back = await files.read(file, { rootDir: root })
    expect(back?.type === 'single' && back.prompt).toBe('AUTHORED brief')
    expect(back?.type === 'single' && back.sessions[0].cwd).toBe(join(root, 'proj', 'lib'))
  })

  it('writes a multi-group file from `groups`', () => {
    const file = join(root, 'multi.clave')
    const group = { name: 'G', cwd: root, color: null, sessions: [], terminals: [] }
    files.write(file, { groups: [group, { ...group, name: 'H' }] })
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    expect(raw.groups.map((g: { name: string }) => g.name)).toEqual(['G', 'H'])
  })
})

describe('watching', () => {
  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  it('tells one change per burst of edits, not the server’s own write, and stops on unwatch', async () => {
    const file = join(root, 'w.clave')
    writeFileSync(file, single())
    const heard: string[] = []
    files.onEvent((e) => heard.push(e.path))
    files.watch(file)
    files.watch(file)
    expect(files.watched()).toEqual([file])
    await settle(50)
    writeFileSync(file, single({ name: 'A' }))
    writeFileSync(file, single({ name: 'B' }))
    await settle(400)
    expect(heard).toEqual([file])
    // The server's own write is not a change.
    files.write(file, { name: 'C', cwd: root, color: null, sessions: [], terminals: [] })
    await settle(400)
    expect(heard).toEqual([file])
    files.unwatch(file)
    expect(files.watched()).toEqual([])
    writeFileSync(file, single({ name: 'D' }))
    await settle(400)
    expect(heard).toEqual([file])
  })

  it('closes with its last holder, not its first', async () => {
    const file = join(root, 'held.clave')
    writeFileSync(file, single())
    const heard: string[] = []
    files.onEvent((e) => heard.push(e.path))
    files.watch(file, 'ipc:w1')
    files.watch(file, 'server:w1')
    files.watch(file, 'ipc:w2')
    expect(files.holdersOf(file).sort()).toEqual(['ipc:w1', 'ipc:w2', 'server:w1'])
    // The shipped app's hand-over: the IPC name released, the server's kept.
    files.unwatch(file, 'ipc:w1')
    files.unwatch(file, 'ipc:w2')
    files.unwatch(file, 'nobody')
    expect(files.watched()).toEqual([file])
    await settle(50)
    writeFileSync(file, single({ name: 'edited' }))
    await settle(400)
    expect(heard).toEqual([file])
    files.unwatch(file, 'server:w1')
    expect(files.watched()).toEqual([])
    expect(files.holdersOf(file)).toEqual([])
  })

  it('survives an atomic rename of the file', async () => {
    const file = join(root, 'r.clave')
    writeFileSync(file, single())
    const heard: string[] = []
    files.onEvent((e) => heard.push(e.path))
    files.watch(file)
    await settle(50)
    const tmp = join(root, 'r.clave.tmp')
    writeFileSync(tmp, single({ name: 'Renamed' }))
    renameSync(tmp, file)
    await settle(400)
    expect(heard).toEqual([file])
  })
})

describe('discovery', () => {
  it('finds workspace.clave and .clave/workspaces/*.clave in a folder', () => {
    writeFileSync(join(root, 'workspace.clave'), single())
    mkdirSync(join(root, '.clave', 'workspaces'), { recursive: true })
    writeFileSync(join(root, '.clave', 'workspaces', 'romain.clave'), single())
    expect(files.discover(root)).toEqual([
      { name: 'workspace', path: join(root, 'workspace.clave'), rootDir: null },
      { name: 'romain', path: join(root, '.clave', 'workspaces', 'romain.clave'), rootDir: root }
    ])
  })

  it('walks the tree, prefers the personal file, stops at a project, and skips excluded folders', async () => {
    const make = (dir: string, name: string): void => {
      mkdirSync(join(root, dir, '.clave', 'workspaces'), { recursive: true })
      writeFileSync(join(root, dir, '.clave', 'workspaces', `${name}.clave`), single())
    }
    make('labs/one', 'default')
    make('labs/one', 'romain')
    make('labs/one/nested', 'default')
    make('node_modules/pkg', 'default')
    mkdirSync(join(root, 'labs', 'two'), { recursive: true })
    writeFileSync(join(root, 'labs', 'two', 'workspace.clave'), single())
    const found = await files.discoverRecursive(root, { workspaceId: 'romain' })
    expect(found).toEqual([
      {
        name: 'one',
        path: join(root, 'labs/one/.clave/workspaces/romain.clave'),
        rootDir: join(root, 'labs/one')
      },
      { name: 'two', path: join(root, 'labs/two/workspace.clave'), rootDir: join(root, 'labs/two') }
    ])
    expect(await files.discoverRecursive(root, { maxDepth: 1 })).toEqual([])
  })

  it('reads the autoDiscover key, true meaning enabled', () => {
    writeFileSync(join(root, 'ad.clave'), JSON.stringify({ autoDiscover: true }))
    expect(files.readAutoDiscover(join(root, 'ad.clave'))).toEqual({ enabled: true })
    writeFileSync(
      join(root, 'ad2.clave'),
      JSON.stringify({ autoDiscover: { enabled: true, maxDepth: 2 } })
    )
    expect(files.readAutoDiscover(join(root, 'ad2.clave'))).toEqual({ enabled: true, maxDepth: 2 })
    writeFileSync(join(root, 'ad3.clave'), single())
    expect(files.readAutoDiscover(join(root, 'ad3.clave'))).toBeNull()
  })

  it('reads an image as a data URL, null when missing', () => {
    writeFileSync(join(root, 'logo.png'), Buffer.from([1, 2, 3]))
    expect(files.readImage(join(root, 'logo.png'))).toBe('data:image/png;base64,AQID')
    expect(files.readImage(join(root, 'none.png'))).toBeNull()
    expect(files.exists(join(root, 'logo.png'))).toBe(true)
    expect(files.exists(join(root, 'none.png'))).toBe(false)
  })
})

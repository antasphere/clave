import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FILE_TREE_IGNORED, type FilesDirsChanged } from '@clave/contract/files'
import { FileTreeWatcher, FILE_WATCH_LEASE_MS } from './watch'

let root: string
let watcher: FileTreeWatcher
let events: FilesDirsChanged[]
let handles: Array<{
  path: string
  closed: boolean
  emit: (name: string) => void
  error: () => void
}>
beforeEach(async () => {
  vi.useFakeTimers()
  root = await realpath(await mkdtemp(join(tmpdir(), 'clave-file-watch-')))
  await mkdir(join(root, 'a'))
  await mkdir(join(root, 'b'))
  events = []
  handles = []
  watcher = new FileTreeWatcher({
    now: () => Date.now(),
    watch: (path, change) => {
      const emitter = new EventEmitter()
      const handle = {
        path,
        closed: false,
        emit: (name: string) => change('rename', name),
        error: () => emitter.emit('error', new Error('gone')),
        close: () => {
          handle.closed = true
        },
        on: (event: 'error', listener: (error: Error) => void) => emitter.on(event, listener)
      }
      handles.push(handle)
      return handle
    }
  })
  watcher.onEvent((e) => events.push(e))
})
afterEach(async () => {
  watcher.dispose()
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})
const sync = (
  generation: number,
  dirs = ['a'],
  namespace = 'one'
): ReturnType<FileTreeWatcher['sync']> =>
  watcher.sync({ namespace, generation, tree: { root, dirs } })

describe('whole tree watches', () => {
  it('ignores older generations, reapplies equal ones and drops unnamed dirs', async () => {
    expect((await sync(2)).watched).toEqual(['.', 'a'])
    expect(await sync(1, ['b'])).toEqual({ watched: [] })
    expect((await sync(2, ['b'])).watched).toEqual(['.', 'b'])
    expect(handles.find((h) => h.path === join(root, 'a'))?.closed).toBe(true)
    await watcher.sync({ namespace: 'one', generation: 3, tree: null })
    expect(handles.every((h) => h.closed)).toBe(true)
  })
  it('applies in arrival order while the first root check is slow', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const first = watcher.sync(
      { namespace: 'one', generation: 1, tree: { root, dirs: ['a'] } },
      async () => {
        await gate
        return root
      }
    )
    const second = sync(2, ['b'])
    await Promise.resolve()
    expect(handles).toHaveLength(0)
    release()
    await first
    expect((await second).watched).toEqual(['.', 'b'])
    expect(handles.find((h) => h.path === join(root, 'a'))?.closed).toBe(true)
  })
  it('isolates two namespaces and expires unrenewed leases', async () => {
    await sync(1)
    await sync(1, ['b'], 'two')
    await vi.advanceTimersByTimeAsync(FILE_WATCH_LEASE_MS - 60_000)
    await sync(1, ['b'], 'two')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(handles.filter((h) => !h.closed).map((h) => h.path)).toEqual([root, join(root, 'b')])
    watcher.dispose()
    expect(handles.every((h) => h.closed)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('expires a lease fifteen minutes after its renewal, between sweep boundaries', async () => {
    await sync(1)
    await vi.advanceTimersByTimeAsync(1234)
    await sync(1)
    await vi.advanceTimersByTimeAsync(FILE_WATCH_LEASE_MS - 1)
    expect(handles.every((h) => !h.closed)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(handles.every((h) => h.closed)).toBe(true)
  })
  it('skips traversal, absolute dirs, symlink escapes and files', async () => {
    await writeFile(join(root, 'file'), '')
    await symlink(tmpdir(), join(root, 'escape'))
    expect(
      (await sync(1, ['..', join(root, 'a'), 'escape', 'file', 'a', 'a/../b', 'bad\0'])).watched
    ).toEqual(['.', 'a'])
    await expect(
      watcher.sync({ namespace: 'bad', generation: 1, tree: { root: 'relative', dirs: [] } })
    ).rejects.toThrow()
    await expect(
      watcher.sync({
        namespace: 'bad',
        generation: 1,
        tree: { root: join(root, 'file'), dirs: [] }
      })
    ).rejects.toThrow()
  })
  it('ignores noisy basenames and debounces a burst of changed folders', async () => {
    await sync(1)
    for (const name of FILE_TREE_IGNORED) handles[0].emit(name)
    await vi.advanceTimersByTimeAsync(300)
    expect(events).toEqual([])
    handles[0].emit('hello')
    handles[1].emit('one')
    await vi.advanceTimersByTimeAsync(200)
    handles[1].emit('two')
    await vi.advanceTimersByTimeAsync(299)
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(events).toEqual([
      { _tag: 'files.dirs_changed', namespace: 'one', root, dirs: ['.', 'a'] }
    ])
  })
  it('closes and forgets a failed watcher, and equal generation repairs it', async () => {
    await sync(1)
    handles[1].error()
    expect(handles[1].closed).toBe(true)
    expect((await sync(1)).watched).toEqual(['.', 'a'])
    expect(handles).toHaveLength(3)
  })
})

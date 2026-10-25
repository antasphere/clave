import { watch as fsWatch } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  FILE_TREE_IGNORED,
  type FilesDirsChanged,
  type FilesWatchInput,
  type FilesWatchResult
} from '@clave/contract/files'

export const FILE_WATCH_LEASE_MS = 15 * 60_000
const ignored = new Set<string>(FILE_TREE_IGNORED)
interface WatchHandle {
  close(): void
  on(event: 'error', listener: (error: Error) => void): unknown
}
export interface FileTreeWatchOptions {
  watch?: (
    path: string,
    change: (event: string, filename: string | Buffer | null) => void
  ) => WatchHandle
  now?: () => number
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}
interface Namespace {
  generation: number
  tree: FilesWatchInput['tree']
  renewedAt: number
  watchers: Map<string, { path: string; handle: WatchHandle }>
  changed: Set<string>
  timer?: ReturnType<typeof setTimeout>
}

/** Each namespace applies whole trees in arrival order. Equal generations
 * renew the lease and repair watches lost to an error or a daemon restart. */
export class FileTreeWatcher {
  private readonly namespaces = new Map<string, Namespace>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly listeners = new Set<(event: FilesDirsChanged) => void>()
  private readonly options: Required<FileTreeWatchOptions>
  private sweep: ReturnType<typeof setTimeout> | undefined
  private sweeping = false
  private disposed = false

  constructor(options: FileTreeWatchOptions = {}) {
    this.options = {
      watch: options.watch ?? ((path, change) => fsWatch(path, change)),
      now: options.now ?? Date.now,
      setTimeout: options.setTimeout ?? setTimeout,
      clearTimeout: options.clearTimeout ?? clearTimeout
    }
  }

  private scheduleSweep(): void {
    if (this.disposed || this.sweeping) return
    if (this.sweep !== undefined) this.options.clearTimeout(this.sweep)
    this.sweep = undefined
    if (!this.namespaces.size) return
    const deadline = Math.min(
      ...[...this.namespaces.values()].map((s) => s.renewedAt + FILE_WATCH_LEASE_MS)
    )
    this.sweep = this.options.setTimeout(
      () => {
        this.sweep = undefined
        this.sweeping = true
        const pending: Promise<void>[] = []
        for (const [namespace, state] of this.namespaces) {
          if (this.options.now() - state.renewedAt < FILE_WATCH_LEASE_MS) continue
          pending.push(
            this.enqueue(namespace, () => {
              if (
                this.namespaces.get(namespace) === state &&
                this.options.now() - state.renewedAt >= FILE_WATCH_LEASE_MS
              ) {
                this.close(state)
                this.namespaces.delete(namespace)
              }
            })
          )
        }
        void Promise.allSettled(pending).then(() => {
          this.sweeping = false
          this.scheduleSweep()
        })
      },
      Math.max(0, deadline - this.options.now())
    )
    this.sweep.unref?.()
  }

  private enqueue<T>(namespace: string, run: () => T | Promise<T>): Promise<T> {
    const next = (this.chains.get(namespace) ?? Promise.resolve()).catch(() => {}).then(run)
    this.chains.set(namespace, next)
    void next
      .finally(() => {
        if (this.chains.get(namespace) === next) this.chains.delete(namespace)
      })
      .catch(() => {})
    return next
  }

  private close(state: Namespace): void {
    if (state.timer !== undefined) this.options.clearTimeout(state.timer)
    state.timer = undefined
    state.changed.clear()
    for (const watcher of state.watchers.values()) watcher.handle.close()
    state.watchers.clear()
  }

  sync(
    input: FilesWatchInput,
    checkedRoot: (root: string) => Promise<string> = async (root) => {
      if (!isAbsolute(root) || root.includes('\0')) throw new Error('Invalid root.')
      const canonical = await realpath(root)
      if (!(await stat(canonical)).isDirectory()) throw new Error('Invalid root.')
      return canonical
    }
  ): Promise<FilesWatchResult> {
    return this.enqueue(input.namespace, async () => {
      if (this.disposed) return { watched: [] }
      const old = this.namespaces.get(input.namespace)
      if (old && input.generation < old.generation) return { watched: [] }
      const desired = new Map<string, string>()
      if (input.tree) {
        const root = await checkedRoot(input.tree.root)
        desired.set('.', root)
        for (const dir of input.tree.dirs.slice(0, 1000)) {
          if (isAbsolute(dir) || dir.includes('\0') || dir.split(/[\\/]/).includes('..')) continue
          try {
            const canonical = await realpath(resolve(root, dir))
            const rel = relative(root, canonical)
            if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) continue
            if (!(await stat(canonical)).isDirectory()) continue
            desired.set(dir === '' ? '.' : dir, canonical)
          } catch {
            /* A folder deleted since the listing is not watched. */
          }
        }
      }
      if (this.disposed) return { watched: [] }
      const state: Namespace = old ?? {
        generation: input.generation,
        tree: null,
        renewedAt: 0,
        watchers: new Map(),
        changed: new Set()
      }
      const sameRoot = state.tree?.root === input.tree?.root
      if (!sameRoot) this.close(state)
      state.generation = input.generation
      state.tree = input.tree
      state.renewedAt = this.options.now()
      this.namespaces.set(input.namespace, state)
      this.scheduleSweep()
      for (const [dir, held] of state.watchers) {
        if (desired.get(dir) === held.path) continue
        held.handle.close()
        state.watchers.delete(dir)
      }
      for (const [dir, path] of desired) {
        if (state.watchers.has(dir)) continue
        try {
          const handle = this.options.watch(path, (_event, filename) => {
            if (ignored.has(basename(filename?.toString() ?? ''))) return
            if (!state.watchers.has(dir) || this.namespaces.get(input.namespace) !== state) return
            state.changed.add(dir)
            if (state.timer !== undefined) this.options.clearTimeout(state.timer)
            state.timer = this.options.setTimeout(() => {
              state.timer = undefined
              const dirs = [...state.changed].filter((d) => state.watchers.has(d))
              state.changed.clear()
              if (!state.tree || !dirs.length) return
              const event: FilesDirsChanged = {
                _tag: 'files.dirs_changed',
                namespace: input.namespace,
                root: state.tree.root,
                dirs
              }
              for (const listener of this.listeners) listener(event)
            }, 300)
            state.timer.unref?.()
          })
          state.watchers.set(dir, { path, handle })
          handle.on('error', () => {
            if (state.watchers.get(dir)?.handle !== handle) return
            handle.close()
            state.watchers.delete(dir)
            state.changed.delete(dir)
          })
        } catch {
          /* This filesystem may not support notifications. */
        }
      }
      return { watched: [...state.watchers.keys()] }
    })
  }

  onEvent(listener: (event: FilesDirsChanged) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.sweep !== undefined) this.options.clearTimeout(this.sweep)
    for (const state of this.namespaces.values()) this.close(state)
    this.namespaces.clear()
    this.listeners.clear()
  }
}

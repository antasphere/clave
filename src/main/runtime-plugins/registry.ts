import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type {
  InstalledRuntimePlugin,
  PluginBindings,
  PluginPin,
  PluginProviderDescriptor,
  PluginViewDescriptor,
  PluginViewEntry,
  RuntimePluginManifest
} from '../../shared/runtime-plugins'
import type { AgentCapabilities } from '../../shared/agent-session'
import type { AdapterFactory } from '../conversations/adapter'
import { AdapterError } from '../conversations/adapters/transport'
import { builtinPlugins } from './builtins'
import { isSafeRelativePath, validateManifest } from './manifest'

const MAX_BYTES = 16 * 1024 * 1024
const MAX_FILES = 256
interface RecordEntry {
  id: string
  revision: string
  enabled: boolean
  source: string
}
export interface PreparedPluginInstall {
  readonly manifest: RuntimePluginManifest
  readonly revision: string
  readonly source: string
}
interface PackageBytes {
  manifest: RuntimePluginManifest
  files: Map<string, Buffer>
  revision: string
}
export interface ResolvedPluginProvider {
  descriptor: PluginProviderDescriptor
  command: string[]
  capabilities: AgentCapabilities
  entryPath?: string
  factory?: AdapterFactory
}

function digest(files: Map<string, Buffer>): string {
  const hash = createHash('sha256')
  for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(JSON.stringify([path, bytes.length]) + '\n').update(bytes)
  }
  return hash.digest('hex')
}

// No module evaluation occurs here. Plugins are trusted native code once launched,
// not an OS sandbox. Only built CJS/HTML plus their manifest belong in this package.
function capture(folder: string): PackageBytes {
  if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink())
    throw new Error('Plugin source must be a real directory')
  const files = new Map<string, Buffer>()
  let total = 0
  let directories = 0
  const walk = (directory: string, prefix = ''): void => {
    if (++directories > MAX_FILES) throw new Error('Too many plugin directories')
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix + name
      if (!isSafeRelativePath(relative)) throw new Error(`Forbidden plugin path: ${relative}`)
      const path = join(directory, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`Plugin symlinks are forbidden: ${relative}`)
      if (stat.isDirectory()) {
        walk(path, relative + '/')
        continue
      }
      if (!stat.isFile() || (relative !== 'clave-plugin.json' && !/\.(cjs|html)$/.test(relative)))
        throw new Error(`Only built .cjs and .html plugin files are supported: ${relative}`)
      if (files.size >= MAX_FILES || stat.size > MAX_BYTES - total)
        throw new Error('Plugin package exceeds size limits')
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        // Bound the read too: the source file can grow after lstat.
        const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES - total + 1))
        let length = 0
        while (length < buffer.length) {
          const count = readSync(fd, buffer, length, buffer.length - length, null)
          if (!count) break
          length += count
        }
        if (length > stat.size) throw new Error('Plugin source changed during inspection')
        const bytes = buffer.subarray(0, length)
        total += bytes.length
        if (total > MAX_BYTES) throw new Error('Plugin package exceeds size limits')
        files.set(relative, bytes)
      } finally {
        closeSync(fd)
      }
    }
  }
  walk(folder)
  const raw = files.get('clave-plugin.json')
  if (!raw || raw.length > 64 * 1024) throw new Error('Missing or oversized clave-plugin.json')
  const manifest = validateManifest(JSON.parse(raw.toString('utf8')))
  for (const contribution of [
    ...(manifest.provider ? [manifest.provider] : []),
    ...manifest.views
  ]) {
    if (!files.has(contribution.entry))
      throw new Error(`Missing plugin entry: ${contribution.entry}`)
  }
  return { manifest, files, revision: digest(files) }
}

function pin(plugin: InstalledRuntimePlugin): PluginPin {
  return {
    pluginId: plugin.manifest.id,
    revision: plugin.revision,
    version: plugin.manifest.version
  }
}
function syncDirectory(path: string): void {
  // Windows does not support opening directory handles with Node's openSync.
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Main process writes; daemon readers reload the atomically replaced index. */
export class RuntimePluginRegistry {
  private readonly root?: string
  private readonly prepared = new WeakMap<
    PreparedPluginInstall,
    PackageBytes & { source: string }
  >()

  /** Omit userData only for the builtin-only compatibility factory. */
  constructor(userData?: string) {
    this.root = userData ? join(resolve(userData), 'runtime-plugins') : undefined
  }

  private records(): RecordEntry[] {
    if (!this.root || !existsSync(join(this.root, 'registry.json'))) return []
    const value: unknown = JSON.parse(readFileSync(join(this.root, 'registry.json'), 'utf8'))
    if (
      !Array.isArray(value) ||
      value.some(
        (record) =>
          !record ||
          typeof record.id !== 'string' ||
          !/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(record.id) ||
          typeof record.revision !== 'string' ||
          !/^[a-f0-9]{64}$/.test(record.revision) ||
          typeof record.enabled !== 'boolean' ||
          typeof record.source !== 'string'
      ) ||
      new Set(value.map((record) => record.id)).size !== value.length
    )
      throw new Error('Invalid runtime plugin registry')
    return value
  }

  private writeRecords(records: RecordEntry[]): void {
    if (!this.root) throw new Error('Registry has no installation directory')
    mkdirSync(this.root, { recursive: true })
    const stage = mkdtempSync(join(this.root, '.index-'))
    try {
      const file = join(stage, 'registry.json')
      const fd = openSync(file, 'wx', 0o600)
      try {
        writeFileSync(fd, JSON.stringify(records))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(file, join(this.root, 'registry.json'))
      syncDirectory(this.root)
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
  }

  private revisionPath(revision: string): string {
    if (!this.root || !/^[a-f0-9]{64}$/.test(revision))
      throw new Error('Plugin revision unavailable')
    return join(this.root, 'revisions', revision)
  }

  private readRevision(revision: string): PackageBytes {
    const result = capture(this.revisionPath(revision))
    if (result.revision !== revision) throw new Error('Plugin revision integrity check failed')
    return result
  }

  list(): InstalledRuntimePlugin[] {
    return [
      ...builtinPlugins().map(({ manifest, revision, enabled, builtin }) => ({
        manifest,
        revision,
        enabled,
        builtin
      })),
      ...this.records().map((record) => {
        const { manifest } = this.readRevision(record.revision)
        if (manifest.id !== record.id) throw new Error('Plugin registry identity mismatch')
        return { manifest, revision: record.revision, enabled: record.enabled, builtin: false }
      })
    ]
  }

  providers(): PluginProviderDescriptor[] {
    return this.list().flatMap((plugin) =>
      plugin.enabled && plugin.manifest.provider
        ? [
            {
              id: plugin.manifest.provider.id,
              name: plugin.manifest.provider.name,
              plugin: pin(plugin)
            }
          ]
        : []
    )
  }

  inspectFolder(source: string): PreparedPluginInstall {
    source = resolve(source)
    const bytes = capture(source)
    this.assertNoCollision(bytes.manifest)
    const preview = Object.freeze({
      manifest: structuredClone(bytes.manifest),
      revision: bytes.revision,
      source
    })
    this.prepared.set(preview, { ...bytes, source })
    return preview
  }

  prepareUpdate(id: string): PreparedPluginInstall {
    const record = this.records().find((record) => record.id === id)
    if (!record) throw new Error('Only installed local plugins can be updated')
    const prepared = this.inspectFolder(record.source)
    if (prepared.manifest.id !== id) throw new Error('Plugin update changed its identity')
    return prepared
  }

  private assertNoCollision(manifest: RuntimePluginManifest): void {
    for (const installed of this.list()) {
      if (installed.manifest.id === manifest.id) continue
      if (manifest.provider && installed.manifest.provider?.id === manifest.provider.id)
        throw new Error(`Provider ID already installed: ${manifest.provider.id}`)
    }
  }

  installPrepared(preview: PreparedPluginInstall): InstalledRuntimePlugin {
    const prepared = this.prepared.get(preview)
    if (!prepared) throw new Error('Installation requires a preview from this registry')
    this.assertNoCollision(prepared.manifest)
    const destination = this.revisionPath(prepared.revision)
    mkdirSync(dirname(destination), { recursive: true })
    if (!existsSync(destination)) {
      const stage = mkdtempSync(join(dirname(destination), '.stage-'))
      try {
        for (const [relative, bytes] of prepared.files) {
          const path = join(stage, relative)
          mkdirSync(dirname(path), { recursive: true })
          const fd = openSync(path, 'wx', 0o600)
          try {
            writeFileSync(fd, bytes)
            fsyncSync(fd)
            fchmodSync(fd, 0o400)
          } finally {
            closeSync(fd)
          }
          let parent = dirname(path)
          while (parent !== stage) {
            syncDirectory(parent)
            parent = dirname(parent)
          }
        }
        syncDirectory(stage)
        renameSync(stage, destination)
        syncDirectory(dirname(destination))
      } finally {
        rmSync(stage, { recursive: true, force: true })
      }
    }
    this.readRevision(prepared.revision)
    const records = this.records()
    const previous = records.find((record) => record.id === prepared.manifest.id)
    const record = {
      id: prepared.manifest.id,
      revision: prepared.revision,
      source: prepared.source,
      enabled: previous?.enabled ?? true
    }
    this.writeRecords([...records.filter((record) => record.id !== prepared.manifest.id), record])
    this.prepared.delete(preview)
    return {
      manifest: structuredClone(prepared.manifest),
      revision: prepared.revision,
      enabled: record.enabled,
      builtin: false
    }
  }

  setEnabled(id: string, enabled: boolean): void {
    const records = this.records()
    if (!records.some((record) => record.id === id)) throw new Error('Unknown or built-in plugin')
    this.writeRecords(records.map((record) => (record.id === id ? { ...record, enabled } : record)))
  }

  /** Permission checks need activation state, not a fresh hash of every package. */
  isEnabled(id: string): boolean {
    return (
      builtinPlugins().some((plugin) => plugin.manifest.id === id) ||
      this.records().some((record) => record.id === id && record.enabled)
    )
  }

  bindingsFor(providerId: string): PluginBindings {
    const provider = this.providers().find((provider) => provider.id === providerId)
    if (!provider) throw new Error(`Provider unavailable or disabled: ${providerId}`)
    return {
      provider: provider.plugin,
      // Enhancers pin on first use so newly installed views can serve old sessions.
      views: []
    }
  }

  private pinnedManifest(binding: PluginPin, requireEnabled: boolean): RuntimePluginManifest {
    const builtin = builtinPlugins().find((plugin) => plugin.manifest.id === binding.pluginId)
    if (builtin) {
      if (builtin.revision !== binding.revision || builtin.manifest.version !== binding.version)
        throw new AdapterError(
          'Built-in plugin revision unavailable in this runtime. If you just updated Clave, use Settings → Agents → Restart background service. If this persists, start a new conversation with the current provider. Saved history has not been changed.'
        )
      return builtin.manifest
    }
    const record = this.records().find((record) => record.id === binding.pluginId)
    if (!record || (requireEnabled && !record.enabled))
      throw new Error('Plugin unavailable or disabled')
    const { manifest } = this.readRevision(binding.revision)
    if (manifest.id !== binding.pluginId || manifest.version !== binding.version)
      throw new Error('Plugin pin identity mismatch')
    return manifest
  }

  resolveProvider(providerId: string, binding?: PluginPin): ResolvedPluginProvider {
    binding ??= this.providers().find((provider) => provider.id === providerId)?.plugin
    if (!binding) throw new Error(`Provider unavailable: ${providerId}`)
    const manifest = this.pinnedManifest(binding, false)
    const provider = manifest.provider
    if (!provider || provider.id !== providerId)
      throw new Error('Pinned plugin does not provide this provider')
    const builtin = builtinPlugins().find((plugin) => plugin.manifest.id === manifest.id)
    return {
      descriptor: { id: provider.id, name: provider.name, plugin: { ...binding } },
      command: [...provider.command],
      capabilities: { ...provider.capabilities },
      ...(builtin
        ? { factory: builtin.factory }
        : { entryPath: join(this.revisionPath(binding.revision), provider.entry) })
    }
  }

  viewsFor(bindings: PluginPin[], entry: PluginViewEntry): PluginViewDescriptor[] {
    return bindings.flatMap((binding) => {
      try {
        return this.pinnedManifest(binding, true)
          .views.filter((view) =>
            entry.kind === 'artifact'
              ? view.mimeTypes?.includes(entry.mimeType)
              : view.toolNames?.includes(entry.name)
          )
          .map((view) => ({
            id: view.id,
            name: view.name,
            plugin: { ...binding },
            capabilities: [...view.capabilities]
          }))
      } catch {
        return []
      } // Core artifact rendering stays available if a plugin is missing.
    })
  }

  readView(binding: PluginPin, viewId: string): string {
    const manifest = this.pinnedManifest(binding, true)
    const view = manifest.views.find((view) => view.id === viewId)
    if (!view) throw new Error('View not found in pinned plugin')
    return this.readRevision(binding.revision).files.get(view.entry)!.toString('utf8')
  }
}

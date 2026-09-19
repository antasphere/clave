import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
  lstatSync,
  symlinkSync,
  rmSync,
  unlinkSync
} from 'node:fs'
import { join, relative, isAbsolute, sep } from 'node:path'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import {
  pluginManifestSchema,
  isEngineCompatible,
  type PluginManifest,
  type PluginPermission
} from '@clave/plugin-sdk'

const installedSchema = z.array(
  z.strictObject({
    id: z.string(),
    version: z.string(),
    source: z.enum(['bundled', 'git', 'link']),
    enabled: z.boolean(),
    enabledBeforeEngineRefusal: z.boolean().optional(),
    permissionsGranted: z.array(
      z.enum(['sessions.read', 'sessions.write', 'fs.read', 'fs.write', 'net', 'secrets', 'shell'])
    ),
    installedAt: z.string().datetime(),
    directory: z.string().optional(),
    contentDigest: z.string().optional(),
    reviewDigest: z.string().optional(),
    declaredPermissions: z.array(z.string()).optional(),
    needsReview: z
      .enum(['permission-growth', 'digest-change', 'source-change', 'engine-refusal'])
      .optional()
  })
)
export type InstalledPlugin = z.infer<typeof installedSchema>[number]
export interface PluginRecord extends InstalledPlugin {
  manifest?: PluginManifest
  directory: string
  error?: string
  status: 'disabled' | 'starting' | 'active' | 'error'
  panels: string[]
  commands: string[]
  generation: number
  lastNotification?: { title: string; body?: string }
}

/** Both the lexical path and its real target must stay inside the plugin. */
export function pluginFile(root: string, entry: string): string {
  const realRoot = realpathSync(root)
  const target = realpathSync(join(realRoot, entry))
  const rel = relative(realRoot, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Path leaves plugin directory')
  return target
}

export class PluginStore {
  readonly records = new Map<string, PluginRecord>()
  private installed: InstalledPlugin[]
  constructor(
    readonly root: string,
    readonly bundled: string,
    readonly version: string
  ) {
    mkdirSync(join(root, 'plugins'), { recursive: true })
    const file = join(root, 'installed.json')
    // Corrupt state must never silently re-enable code or re-grant permissions.
    this.installed = existsSync(file)
      ? installedSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
      : []
  }
  discover(): PluginRecord[] {
    this.records.clear()
    for (const [folder, source] of [
      [this.bundled, 'bundled'],
      [join(this.root, 'plugins'), 'git']
    ] as const) {
      if (!existsSync(folder)) continue
      for (const name of readdirSync(folder).sort()) {
        const directory = join(folder, name)
        let id = name
        const actualSource =
          source === 'git' && lstatSync(directory).isSymbolicLink() ? 'link' : source
        try {
          const manifestBytes = readFileSync(join(directory, 'clave-plugin.json'))
          const rawManifest = JSON.parse(manifestBytes.toString('utf8'))
          const manifest = pluginManifestSchema.parse(rawManifest)
          id = manifest.id
          if (this.records.has(id))
            throw new Error(`Duplicate plugin id ${id}; bundled plugins cannot be overridden`)
          const saved = this.installed.find((r) => r.id === id)
          const contentHash = createHash('sha256')
          const reviewHash = createHash('sha256')
          // Seal file contents, modes and internal link targets, including surface assets.
          // Only version and permission changes are excluded from consent comparison.
          const reviewManifest = { ...rawManifest }
          delete reviewManifest.version
          delete reviewManifest.permissions
          const files: string[] = []
          const walk = (folder: string): void => {
            for (const name of readdirSync(folder).sort()) {
              const file = join(folder, name)
              const stat = lstatSync(file)
              if (stat.isSymbolicLink()) {
                const target = relative(realpathSync(directory), realpathSync(file))
                if (target === '..' || target.startsWith(`..${sep}`) || isAbsolute(target))
                  throw new Error('Path leaves plugin directory')
                const link = JSON.stringify(['@link', relative(directory, file), target])
                contentHash.update(link)
                reviewHash.update(link)
                continue
              }
              if (name === 'node_modules' || name === '.git') continue
              if (stat.isDirectory()) walk(file)
              else if (stat.isFile()) files.push(relative(directory, file))
            }
          }
          walk(directory)
          for (const entry of files.sort()) {
            const mode = lstatSync(join(directory, entry)).mode & 0o777
            const bytes = readFileSync(join(directory, entry))
            const reviewBytes =
              entry === 'clave-plugin.json' ? Buffer.from(JSON.stringify(reviewManifest)) : bytes
            contentHash.update(JSON.stringify([entry, mode, bytes.length])).update(bytes)
            reviewHash.update(JSON.stringify([entry, mode, reviewBytes.length])).update(reviewBytes)
          }
          const contentDigest = contentHash.digest('hex')
          const reviewDigest = reviewHash.digest('hex')
          const permissionGrowth =
            saved &&
            manifest.permissions.some(
              (p) => !(saved.declaredPermissions ?? saved.permissionsGranted).includes(p)
            )
          const digestChanged =
            saved &&
            actualSource === 'git' &&
            saved.contentDigest !== contentDigest &&
            saved.reviewDigest !== reviewDigest
          const firstBundledInstall = !saved && source === 'bundled'
          const record: PluginRecord = {
            id,
            version: manifest.version,
            source: actualSource,
            enabled: saved
              ? saved.needsReview === 'engine-refusal'
                ? (saved.enabledBeforeEngineRefusal ?? saved.enabled)
                : saved.enabled
              : firstBundledInstall,
            permissionsGranted: [
              ...(saved
                ? saved.permissionsGranted.filter((p) => manifest.permissions.includes(p))
                : firstBundledInstall
                  ? manifest.permissions
                  : [])
            ],
            installedAt: saved?.installedAt ?? new Date().toISOString(),
            contentDigest,
            reviewDigest,
            declaredPermissions: [...manifest.permissions],
            needsReview: saved?.needsReview === 'engine-refusal' ? undefined : saved?.needsReview,
            manifest,
            directory,
            status: 'disabled',
            panels: [],
            commands: [],
            generation: 0
          }
          if (digestChanged) record.needsReview = 'digest-change'
          if (permissionGrowth) {
            record.needsReview = 'permission-growth'
            record.permissionsGranted = []
          }
          if (saved && saved.source !== actualSource) record.needsReview = 'source-change'
          if (!isEngineCompatible(manifest, this.version)) {
            record.error = `Requires Clave ${manifest.engines.clave}; running ${this.version}`
            if (!record.needsReview) {
              record.enabledBeforeEngineRefusal = record.enabled
              record.needsReview = 'engine-refusal'
            }
          }
          if (
            record.needsReview ||
            manifest.permissions.some((p) => !record.permissionsGranted.includes(p))
          )
            record.enabled = false
          if (manifest.main) pluginFile(directory, manifest.main)
          if (manifest.uiEntry) {
            const uiRoot = realpathSync(join(directory, 'ui'))
            pluginFile(uiRoot, relative(uiRoot, pluginFile(directory, manifest.uiEntry)))
          }
          if (record.error) record.status = 'error'
          this.records.set(id, record)
        } catch (error) {
          // A duplicate gets a separate diagnostic row; it never replaces the original.
          const duplicate = this.records.has(id)
          const saved = !duplicate
            ? this.installed.find((r) => r.directory === directory || r.id === id)
            : undefined
          const key = duplicate ? `invalid:${directory}` : (saved?.id ?? id)
          this.records.set(key, {
            id: key,
            version: '',
            source: actualSource,
            enabled: false,
            permissionsGranted: [],
            installedAt: new Date().toISOString(),
            ...saved,
            directory,
            error: String(error),
            status: 'error',
            panels: [],
            commands: [],
            generation: 0
          })
        }
      }
    }
    for (const r of this.records.values())
      if (r.error) console.error(`[plugins] ${r.id}: ${r.error}`)
    this.save()
    return this.list()
  }
  list(): PluginRecord[] {
    return [...this.records.values()]
  }
  get(id: string): PluginRecord {
    const record = this.records.get(id)
    if (!record) throw new Error(`Unknown plugin ${id}`)
    return record
  }
  enable(id: string, grants: PluginPermission[]): void {
    const record = this.get(id)
    if (!record.manifest || record.error) throw new Error(record.error ?? 'Invalid plugin')
    if (record.manifest.permissions.some((p) => !grants.includes(p)))
      throw new Error('All declared permissions must be granted before enabling')
    record.permissionsGranted = record.manifest.permissions.filter((p) => grants.includes(p))
    record.enabled = true
    delete record.needsReview
    this.save()
  }
  disable(id: string): void {
    const record = this.get(id)
    record.enabled = false
    if (record.needsReview === 'engine-refusal') record.enabledBeforeEngineRefusal = false
    this.save()
  }
  link(directory: string): string {
    const target = realpathSync(directory)
    const manifest = pluginManifestSchema.parse(
      JSON.parse(readFileSync(join(target, 'clave-plugin.json'), 'utf8'))
    )
    if (this.records.has(manifest.id)) throw new Error(`Plugin ${manifest.id} is already installed`)
    const destination = join(this.root, 'plugins', manifest.id)
    symlinkSync(target, destination, 'dir')
    return manifest.id
  }
  remove(id: string): void {
    const record = this.get(id)
    if (record.source === 'bundled') throw new Error('Bundled plugins can be disabled, not removed')
    // Remove only our managed installation. Never follow a link to its source.
    const rel = relative(join(this.root, 'plugins'), record.directory)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).length !== 1)
      throw new Error('Not a managed plugin installation')
    if (lstatSync(record.directory).isSymbolicLink()) unlinkSync(record.directory)
    else rmSync(record.directory, { recursive: true })
    this.records.delete(id)
    this.installed = this.installed.filter((r) => r.id !== id)
    this.save()
  }
  save(): void {
    const current = this.list().flatMap((record): InstalledPlugin[] => {
      if (!record.manifest) {
        // A half-written manifest is not an uninstall. Keep the exact saved entry
        // until it can be parsed again, including its consent and previous digests.
        const saved = this.installed.find((r) => r.id === record.id)
        return saved ? [saved] : []
      }
      const {
        id,
        version,
        source,
        enabled,
        permissionsGranted,
        installedAt,
        directory,
        contentDigest,
        reviewDigest,
        declaredPermissions,
        needsReview,
        enabledBeforeEngineRefusal
      } = record
      return [
        {
          id,
          version,
          source,
          enabled,
          permissionsGranted,
          installedAt,
          directory,
          contentDigest,
          reviewDigest,
          declaredPermissions,
          needsReview,
          enabledBeforeEngineRefusal
        }
      ]
    })
    // Absence revokes trust: a replacement must be reviewed on discovery.
    this.installed = current
    const file = join(this.root, 'installed.json')
    writeFileSync(`${file}.tmp`, JSON.stringify(this.installed, null, 2), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
}

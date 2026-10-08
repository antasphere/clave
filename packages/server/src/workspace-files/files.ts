/**
 * The workspace files domain without the server: the `.clave` parser and
 * writer, the trust store, the trusted roots, the per-file watchers and the
 * discovery walks, as one plain class the Electron shell builds at boot and
 * the standalone entry builds over its data directory. It imports nothing of
 * Effect or the framework (`@clave/server/workspace-files` is the light
 * entry, the way `@clave/server/sidebar-layouts` is), so building it costs
 * the shell nothing (`src/main/server/lazy-load.test.ts`).
 *
 * Places 2 and 3 of the six-place mirror rule in the app's CLAUDE.md live
 * beside each other here: the trust boundary in `trust.ts`, the parser
 * (`resolveGroup`) and the writer (`serializeGroup`) in this file. A new
 * `.clave` field goes through both, and through the contract's shape.
 *
 * The review is NOT this class's: a read that meets an elevated file nobody
 * trusted calls the `reviewer` it was handed with what the dialog must
 * disclose and applies the answer. The server's handler publishes the
 * review as an event and waits for the answer command; the shell's IPC arm
 * shows the Electron dialog itself. The trust decision (which roots, which
 * content hashes, what each answer does) stays here, once.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type {
  AutoDiscoverConfig,
  ClaveFileReadResult,
  ClaveFileWriteData,
  ClaveFileWriteGroup,
  ClaveGroup,
  DiscoveredFile,
  DiscoveredProjectFile,
  ReviewAnswer
} from '@clave/contract/workspace-files'
import { describeElevated, sanitizeElevated } from './trust'

export type Unsubscribe = () => void

/** Where the trust store is kept: two JSON documents, `clave-trusted.json`
 *  (the content hashes the person trusted or authored) and
 *  `clave-trusted-roots.json` (the folders every `.clave` under skips the
 *  review in). The app's data folder in-process, the standalone's
 *  `--data-dir` when the server runs alone, a Map for the tests. */
export interface WorkspaceFilesStorage {
  read(name: string): string | null
  write(name: string, text: string): void
}

export const TRUSTED_CONTENT_FILE = 'clave-trusted.json'
export const TRUSTED_ROOTS_FILE = 'clave-trusted-roots.json'

/** A store that lives as long as the process: the tests' and a server's
 *  with no data directory. */
export function memoryWorkspaceFilesStorage(): WorkspaceFilesStorage & {
  documents: Map<string, string>
} {
  const documents = new Map<string, string>()
  return {
    documents,
    read: (name) => documents.get(name) ?? null,
    write: (name, text) => {
      documents.set(name, text)
    }
  }
}

/** The trust store as files under `dir`, written then renamed so a kill
 *  mid-write leaves the old document whole. */
export function fileWorkspaceFilesStorage(dir: string): WorkspaceFilesStorage {
  const target = (name: string): string => path.join(dir, name)
  return {
    read: (name) => {
      try {
        return fs.readFileSync(target(name), 'utf-8')
      } catch {
        return null
      }
    },
    write: (name, text) => {
      const file = target(name)
      const tmp = `${file}.tmp`
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.rmSync(tmp, { force: true })
      fs.writeFileSync(tmp, text, 'utf-8')
      fs.renameSync(tmp, file)
    }
  }
}

/** What a review discloses: the file, the folder the checkbox would trust,
 *  and what would act on launch. */
export interface ReviewRequest {
  readonly path: string
  readonly folder: string
  readonly autoCommands: ReadonlyArray<string>
  readonly prompts: ReadonlyArray<string>
  readonly dangerous: boolean
}

/** Whoever can ask the person: answers the dialog's buttons, or null when
 *  nobody answered (read as Cancel). */
export type Reviewer = (request: ReviewRequest) => Promise<ReviewAnswer | null>

/** A read with no reviewer at hand: an elevated untrusted file is cancelled. */
export const noReviewer: Reviewer = async () => null

export interface ReadOptions {
  readonly rootDir?: string | undefined
  readonly reviewer?: Reviewer
}

export type WorkspaceFilesEvent = {
  readonly _tag: 'workspace_files.changed'
  readonly path: string
}

export interface WorkspaceFilesOptions {
  /** How long a change on disk is held before it is told, so an editor's
   *  burst of writes is one event. 500 ms by default. */
  readonly debounceMs?: number
  /** How long after the server's own write a change on that file is the
   *  echo of that write and not told. 1000 ms by default. */
  readonly echoMs?: number
}

/** The raw document as it is on disk, either shape. */
interface ClaveFileRaw {
  $schema?: string
  name?: string
  cwd?: string
  color?: string | null
  prompt?: string
  sessions?: RawSession[]
  terminals?: RawTerminal[]
  toolbar?: boolean
  category?: string
  logo?: string
  view?: string
  groups?: RawGroup[]
  autoDiscover?: boolean | AutoDiscoverConfig
}
interface RawGroup {
  name?: string
  cwd?: string
  color?: string | null
  toolbar?: boolean
  category?: string
  logo?: string
  prompt?: string
  sessions?: RawSession[]
  terminals?: RawTerminal[]
  view?: string
}
interface RawSession {
  cwd?: string
  name: string
  claudeMode?: boolean
  antigravityMode?: boolean
  /** @deprecated the retired alias of antigravityMode, read for back-compat */
  geminiMode?: boolean
  codexMode?: boolean
  piMode?: boolean
  claudeAgentsMode?: boolean
  dangerousMode?: boolean
  prompt?: string
  rootSession?: boolean
  account?: unknown
}
interface RawTerminal {
  command?: string
  commandMode?: 'prefill' | 'auto'
  color?: string
  icon?: string
  cwd?: string
  autoLaunchLocalhost?: boolean
  persistent?: boolean
  serverUrl?: string
  groupView?: boolean
}

const MIME: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon'
}

export function readImageAsDataUrl(absolutePath: string): string | null {
  try {
    if (!fs.existsSync(absolutePath)) return null
    const ext = path.extname(absolutePath).toLowerCase().slice(1)
    const mime = MIME[ext] ?? 'application/octet-stream'
    const data = fs.readFileSync(absolutePath)
    return `data:${mime};base64,${data.toString('base64')}`
  } catch {
    return null
  }
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await fs.promises.access(absolutePath)
    return true
  } catch {
    return false
  }
}

/** Resolve symlinks and normalize so trust checks cannot be defeated by path tricks. */
function normalizeRoot(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p))
  } catch {
    return path.resolve(p)
  }
}

const isUrl = (value: string): boolean => /^https?:\/\//i.test(value)

/** The parser: one group of the document, every relative path resolved
 *  against `dir`, the logo read into a data URL, free text kept as it is. */
export function resolveGroup(raw: RawGroup, dir: string, fallbackName: string): ClaveGroup {
  return {
    name: raw.name || fallbackName,
    cwd: path.resolve(dir, raw.cwd || '.'),
    color: raw.color ?? null,
    toolbar: raw.toolbar ?? undefined,
    category: raw.category ?? undefined,
    logo: raw.logo
      ? raw.logo.startsWith('data:')
        ? raw.logo
        : (readImageAsDataUrl(path.resolve(dir, raw.logo)) ?? undefined)
      : undefined,
    // Free text, like a session prompt: kept as the raw template, @-tokens
    // substituted at spawn, never path-resolved here.
    ...(raw.prompt ? { prompt: raw.prompt } : {}),
    // A served view is an http(s) URL and travels verbatim; a page on disk is a
    // path and resolves against the file's root dir, exactly like `cwd`.
    ...(raw.view ? { view: isUrl(raw.view) ? raw.view : path.resolve(dir, raw.view) } : {}),
    sessions: (raw.sessions || []).map((s) => ({
      cwd: path.resolve(dir, s.cwd || '.'),
      name: s.name,
      claudeMode: s.claudeMode ?? false,
      // Accept the retired `geminiMode` key from older .clave files.
      antigravityMode: s.antigravityMode ?? s.geminiMode ?? false,
      codexMode: s.codexMode ?? false,
      piMode: s.piMode ?? false,
      claudeAgentsMode: s.claudeAgentsMode ?? false,
      dangerousMode: s.dangerousMode ?? false,
      // Free text, auto-submitted to the agent on launch: the raw template.
      ...(s.prompt ? { prompt: s.prompt } : {}),
      // cwd stays the project dir; the spawn-at-root override happens at spawn.
      ...(s.rootSession ? { rootSession: true } : {}),
      // The account by label (or `any`), resolved at launch, never here.
      ...(typeof s.account === 'string' && s.account.trim() ? { account: s.account.trim() } : {})
    })),
    terminals: (raw.terminals || []).map((t) => ({
      command: t.command || '',
      commandMode: t.commandMode || 'prefill',
      color: t.color || 'blue',
      icon: t.icon,
      cwd: t.cwd ? path.resolve(dir, t.cwd) : undefined,
      autoLaunchLocalhost: t.autoLaunchLocalhost ?? undefined,
      persistent: t.persistent ?? undefined,
      serverUrl: t.serverUrl ?? undefined,
      groupView: t.groupView ?? undefined
    }))
  }
}

/** The writer: one group as the document carries it, every absolute path
 *  made relative to `dir`, the mirror of `resolveGroup`. */
export function serializeGroup(g: ClaveFileWriteGroup, dir: string): RawGroup {
  const toRelative = (abs: string | null | undefined): string => {
    if (!abs) return '.'
    const rel = path.relative(dir, abs)
    return rel === '' ? '.' : rel
  }
  return {
    name: g.name,
    cwd: toRelative(g.cwd),
    color: g.color,
    ...(g.toolbar ? { toolbar: true } : {}),
    ...(g.category ? { category: g.category } : {}),
    ...(g.logo ? { logo: g.logo.startsWith('data:') ? g.logo : toRelative(g.logo) } : {}),
    ...(g.prompt ? { prompt: g.prompt } : {}),
    // Mirror of the read: a URL verbatim, a page on disk back to relative.
    ...(g.view ? { view: isUrl(g.view) ? g.view : toRelative(g.view) } : {}),
    sessions: g.sessions.map((s) => ({
      cwd: toRelative(s.cwd),
      name: s.name,
      claudeMode: s.claudeMode,
      antigravityMode: s.antigravityMode,
      codexMode: s.codexMode,
      piMode: s.piMode,
      claudeAgentsMode: s.claudeAgentsMode,
      dangerousMode: s.dangerousMode,
      ...(s.prompt ? { prompt: s.prompt } : {}),
      ...(s.rootSession ? { rootSession: true } : {}),
      ...(s.account ? { account: s.account } : {})
    })),
    terminals: g.terminals.map((t) => ({
      command: t.command,
      commandMode: t.commandMode,
      color: t.color,
      ...(t.icon ? { icon: t.icon } : {}),
      ...(t.cwd ? { cwd: toRelative(t.cwd) } : {}),
      ...(t.autoLaunchLocalhost ? { autoLaunchLocalhost: true } : {}),
      ...(t.persistent ? { persistent: true } : {}),
      ...(t.serverUrl ? { serverUrl: t.serverUrl } : {}),
      ...(t.groupView ? { groupView: true } : {})
    }))
  }
}

const DEFAULT_PATTERNS = ['workspace.clave', '.clave/workspace.clave']
const DEFAULT_EXCLUDE = ['node_modules', '.git', 'references', 'build', 'dist', '.next', '.turbo']
// Depth 6 covers a workspace like ~/.antasphere, where checkouts sit at
// labs/products/<family>/<tool>/<repo> and skills nest a level deeper
// still. Affordable because a directory holding a workspace file is not
// descended into (see scan()), so the walk stops at project level instead
// of crawling every source tree.
const DEFAULT_MAX_DEPTH = 6

export class WorkspaceFiles {
  private trustedHashes: Set<string> | null = null
  private trustedRoots: string[] | null = null
  private readonly watchers = new Map<string, { watcher: fs.FSWatcher; cleanup: () => void }>()
  /** Who holds each watch; the watcher closes with its last holder. */
  private readonly holders = new Map<string, Set<string>>()
  /** The files the server itself just wrote: a change on one is the echo. */
  private readonly recentWrites = new Set<string>()
  private readonly listeners = new Set<(event: WorkspaceFilesEvent) => void>()
  private readonly debounceMs: number
  private readonly echoMs: number

  constructor(
    private readonly storage: WorkspaceFilesStorage,
    options: WorkspaceFilesOptions = {}
  ) {
    this.debounceMs = options.debounceMs ?? 500
    this.echoMs = options.echoMs ?? 1000
  }

  // ── Trust by content hash (back-compat for files outside any trusted root) ──

  private hashes(): Set<string> {
    if (this.trustedHashes) return this.trustedHashes
    try {
      const raw = this.storage.read(TRUSTED_CONTENT_FILE)
      this.trustedHashes = new Set(raw ? (JSON.parse(raw) as string[]) : [])
    } catch {
      this.trustedHashes = new Set()
    }
    return this.trustedHashes
  }

  private trustContent(content: string): void {
    const set = this.hashes()
    set.add(createHash('sha256').update(content).digest('hex'))
    try {
      this.storage.write(TRUSTED_CONTENT_FILE, JSON.stringify([...set]))
    } catch {
      // best effort
    }
  }

  private isTrustedContent(content: string): boolean {
    return this.hashes().has(createHash('sha256').update(content).digest('hex'))
  }

  // ── Trusted workspace roots (VS Code Workspace Trust style) ──
  // Content-hash trust is fragile: every distinct .clave file prompts, and
  // any edit (the app's own rewrites included) re-prompts. When the person
  // explicitly adds a workspace folder, that folder is trusted as a root and
  // every .clave discovered under it skips the review.

  private roots(): string[] {
    if (this.trustedRoots) return this.trustedRoots
    try {
      const raw = this.storage.read(TRUSTED_ROOTS_FILE)
      this.trustedRoots = raw ? (JSON.parse(raw) as string[]).map(normalizeRoot) : []
    } catch {
      this.trustedRoots = []
    }
    return this.trustedRoots
  }

  private persistRoots(): void {
    if (!this.trustedRoots) return
    try {
      this.storage.write(TRUSTED_ROOTS_FILE, JSON.stringify(this.trustedRoots))
    } catch {
      // best effort
    }
  }

  trustRoot(root: string): void {
    const set = this.roots()
    const norm = normalizeRoot(root)
    if (!set.includes(norm)) {
      set.push(norm)
      this.persistRoots()
    }
  }

  untrustRoot(root: string): void {
    const norm = normalizeRoot(root)
    this.trustedRoots = this.roots().filter((r) => r !== norm)
    this.persistRoots()
  }

  listTrustedRoots(): string[] {
    return [...this.roots()]
  }

  /** True when the path lives at or under a trusted root (after realpath). */
  isUnderTrustedRoot(absolutePath: string): boolean {
    let real: string
    try {
      real = fs.realpathSync(absolutePath)
    } catch {
      real = path.resolve(absolutePath)
    }
    for (const root of this.roots()) {
      const rel = path.relative(root, real)
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true
    }
    return false
  }

  // ── Read and write ──

  /**
   * Read a `.clave` file and resolve its paths against `rootDir` (the file's
   * own folder when none is given). Trust is resolved in order: the file
   * lives under a trusted root, the root dir given is itself trusted, the
   * exact content was trusted or authored before. An elevated file none of
   * those cover goes to the `reviewer`; its answer decides: Cancel (or no
   * answer) reads as null, "Trust and run" trusts the content and answers
   * the file whole, "Open safely" answers it sanitized, and a ticked folder
   * checkbox trusts the folder and answers the file whole either way.
   * Null when the file cannot be read or parsed.
   */
  async read(absolutePath: string, options: ReadOptions = {}): Promise<ClaveFileReadResult | null> {
    const { rootDir, reviewer = noReviewer } = options
    let raw: string
    let result: ClaveFileReadResult
    // The parse and the resolve under one try, as the IPC handler always had
    // them: a file that is not a document (a bare `null`, `sessions: {}`) is
    // no file, null on both roads, never a throw that stops a workspace's
    // sync at the first bad file of a tree.
    try {
      raw = fs.readFileSync(absolutePath, 'utf-8')
      const data = JSON.parse(raw) as ClaveFileRaw
      const dir = rootDir || path.dirname(absolutePath)
      const fallbackName = path.basename(absolutePath, '.clave')
      result = Array.isArray(data.groups)
        ? {
            type: 'multi',
            groups: data.groups.map((g, i) => resolveGroup(g, dir, `Group ${i + 1}`))
          }
        : { type: 'single', ...resolveGroup(data, dir, fallbackName) }
    } catch (err) {
      console.error('[clave] Failed to read .clave file:', absolutePath, err)
      return null
    }

    const { autoCommands, prompts, dangerous } = describeElevated(result)
    const elevated = autoCommands.length > 0 || prompts.length > 0 || dangerous
    const trusted =
      this.isUnderTrustedRoot(absolutePath) ||
      (rootDir != null && this.isUnderTrustedRoot(rootDir)) ||
      this.isTrustedContent(raw)
    if (!elevated || trusted) return result

    const folder = rootDir || path.dirname(absolutePath)
    const answer = await reviewer({ path: absolutePath, folder, autoCommands, prompts, dangerous })
    if (!answer || answer.response === 2) return null
    if (answer.checkboxChecked) this.trustRoot(folder)
    if (answer.response === 1) {
      if (!answer.checkboxChecked) this.trustContent(raw)
      return result
    }
    // Open safely: folder trust (if ticked) supersedes sanitization.
    return answer.checkboxChecked ? result : sanitizeElevated(result)
  }

  /** Write a `.clave` file, paths made relative to `rootDir` (the file's own
   *  folder when none is given), and trust its content as authored, so the
   *  person is not asked to review their own file on the next open. */
  write(absolutePath: string, pinned: ClaveFileWriteData, rootDir?: string): void {
    const dir = rootDir || path.dirname(absolutePath)
    const output: object = pinned.groups
      ? { $schema: 'clave/1.0', groups: pinned.groups.map((g) => serializeGroup(g, dir)) }
      : {
          $schema: 'clave/1.0',
          ...serializeGroup(
            {
              name: pinned.name || '',
              cwd: pinned.cwd || null,
              color: pinned.color || null,
              ...(pinned.toolbar ? { toolbar: true } : {}),
              ...(pinned.category ? { category: pinned.category } : {}),
              ...(pinned.logo ? { logo: pinned.logo } : {}),
              ...(pinned.prompt ? { prompt: pinned.prompt } : {}),
              ...(pinned.view ? { view: pinned.view } : {}),
              sessions: pinned.sessions ?? [],
              terminals: pinned.terminals ?? []
            },
            dir
          )
        }
    // Suppress the watcher echo for this file.
    this.recentWrites.add(absolutePath)
    setTimeout(() => this.recentWrites.delete(absolutePath), this.echoMs).unref?.()
    const serialized = JSON.stringify(output, null, 2) + '\n'
    fs.writeFileSync(absolutePath, serialized, 'utf-8')
    this.trustContent(serialized)
  }

  exists(absolutePath: string): boolean {
    try {
      return fs.existsSync(absolutePath)
    } catch {
      return false
    }
  }

  readImage(absolutePath: string): string | null {
    return readImageAsDataUrl(absolutePath)
  }

  /** The `autoDiscover` key of a file, or null when it has none or cannot be
   *  read; normalised to the contract's shape (`enabled` a boolean, the lists
   *  lists of strings, the depth a number), so the two roads answer the same
   *  thing for a loosely written file. */
  readAutoDiscover(filePath: string): AutoDiscoverConfig | null {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ClaveFileRaw
      const cfg = data.autoDiscover
      if (!cfg) return null
      if (cfg === true) return { enabled: true }
      if (typeof cfg !== 'object') return null
      const strings = (value: unknown): string[] | undefined =>
        Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined
      const patterns = strings(cfg.patterns)
      const exclude = strings(cfg.exclude)
      return {
        enabled: cfg.enabled === true,
        ...(patterns !== undefined && { patterns }),
        ...(exclude !== undefined && { exclude }),
        ...(typeof cfg.maxDepth === 'number' && Number.isFinite(cfg.maxDepth)
          ? { maxDepth: cfg.maxDepth }
          : {})
      }
    } catch {
      return null
    }
  }

  // ── Discovery ──

  /** `workspace.clave` in the folder (paths relative to its own dir) and
   *  `.clave/workspaces/*.clave` (paths relative to the folder). */
  discover(folderPath: string): DiscoveredFile[] {
    const results: DiscoveredFile[] = []
    const directFile = path.join(folderPath, 'workspace.clave')
    if (fs.existsSync(directFile))
      results.push({ name: 'workspace', path: directFile, rootDir: null })
    const workspacesDir = path.join(folderPath, '.clave', 'workspaces')
    try {
      if (fs.existsSync(workspacesDir) && fs.statSync(workspacesDir).isDirectory()) {
        for (const entry of fs.readdirSync(workspacesDir)) {
          if (entry.endsWith('.clave')) {
            results.push({
              name: path.basename(entry, '.clave'),
              path: path.join(workspacesDir, entry),
              rootDir: folderPath
            })
          }
        }
      }
    } catch (err) {
      console.warn('[clave] Failed to scan workspaces dir:', workspacesDir, err)
    }
    return results
  }

  /** Every project workspace file under a root, for a workspace with
   *  `autoDiscover` on: a directory that defines a workspace is a leaf. */
  async discoverRecursive(
    rootDir: string,
    config?: {
      patterns?: ReadonlyArray<string>
      exclude?: ReadonlyArray<string>
      maxDepth?: number
      workspaceId?: string
    }
  ): Promise<DiscoveredProjectFile[]> {
    const patterns = config?.patterns ?? DEFAULT_PATTERNS
    const exclude = new Set(config?.exclude ?? DEFAULT_EXCLUDE)
    const maxDepth = config?.maxDepth ?? DEFAULT_MAX_DEPTH
    const workspaceId = config?.workspaceId // "romain" prefers romain.clave over default.clave
    const results: DiscoveredProjectFile[] = []

    async function findClaveFile(dir: string): Promise<string | null> {
      for (const pattern of patterns) {
        const filePath = path.join(dir, pattern)
        if (await exists(filePath)) return filePath
      }
      // .clave/workspaces/*.clave: {workspaceId}.clave, then default.clave, then the first.
      const wsDir = path.join(dir, '.clave', 'workspaces')
      try {
        const files = (await fs.promises.readdir(wsDir)).filter((f) => f.endsWith('.clave'))
        if (files.length > 0) {
          if (workspaceId) {
            const personal = files.find((f) => f === `${workspaceId}.clave`)
            if (personal) return path.join(wsDir, personal)
          }
          const defaultFile = files.find((f) => f === 'default.clave')
          return path.join(wsDir, defaultFile ?? files[0])
        }
      } catch {
        /* not a directory, or unreadable */
      }
      return null
    }

    async function scan(dir: string, depth: number): Promise<void> {
      if (depth > maxDepth) return
      const found = await findClaveFile(dir)
      if (found) {
        results.push({ name: path.basename(dir), path: found, rootDir: dir })
        // A directory that defines a workspace is a leaf: one workspace per
        // project, so its subtree holds no other. The one exception is the
        // scan root, whose own workspace file sits right above the projects.
        if (depth > 0) return
      }
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      const subdirs = entries.filter(
        (e) => e.isDirectory() && !exclude.has(e.name) && !e.name.startsWith('.')
      )
      await Promise.all(subdirs.map((d) => scan(path.join(dir, d.name), depth + 1)))
    }

    await scan(rootDir, 0)
    results.sort((a, b) => a.name.localeCompare(b.name))
    return results
  }

  // ── Watching ──

  /** Watch a file for changes on disk; every listener hears them. One
   *  watcher per path whoever holds it: a second holder joins it, and the
   *  watcher closes only when its last holder releases it. A window names
   *  itself as the holder so another window's release, or the same window's
   *  release on the road it left, never closes a watch still wanted. */
  watch(absolutePath: string, holder = 'default'): void {
    const held = this.holders.get(absolutePath) ?? new Set<string>()
    held.add(holder)
    this.holders.set(absolutePath, held)
    if (this.watchers.has(absolutePath)) return
    try {
      let debounceTimer: NodeJS.Timeout | null = null
      // Watch the parent directory, not the file itself: editors and agents
      // replace files via atomic rename, which orphans a file-inode watcher
      // after the first change. A directory watch survives inode swaps.
      const dir = path.dirname(absolutePath)
      const base = path.basename(absolutePath)
      const watcher = fs.watch(dir, (_eventType, filename) => {
        // filename can be null on some platforms: treat as a possible match.
        if (filename && filename !== base) return
        if (this.recentWrites.has(absolutePath)) return
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          debounceTimer = null
          this.emit({ _tag: 'workspace_files.changed', path: absolutePath })
        }, this.debounceMs)
      })
      const cleanup = (): void => {
        if (debounceTimer) clearTimeout(debounceTimer)
        watcher.close()
        this.watchers.delete(absolutePath)
        this.holders.delete(absolutePath)
      }
      watcher.on('error', cleanup)
      this.watchers.set(absolutePath, { watcher, cleanup })
    } catch (err) {
      console.warn('[clave] Watch failed for:', absolutePath, (err as Error).message)
    }
  }

  /** Release one holder's watch; the watcher closes with its last holder. */
  unwatch(absolutePath: string, holder = 'default'): void {
    const held = this.holders.get(absolutePath)
    if (!held) return
    held.delete(holder)
    if (held.size === 0) this.watchers.get(absolutePath)?.cleanup()
  }

  /** The paths watched right now (tests, and the shell's diagnostics). */
  watched(): string[] {
    return [...this.watchers.keys()]
  }

  /** Who holds a path's watch (tests). */
  holdersOf(absolutePath: string): string[] {
    return [...(this.holders.get(absolutePath) ?? [])]
  }

  /** Every change on a watched file, as it is told. */
  onEvent(listener: (event: WorkspaceFilesEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(event: WorkspaceFilesEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (err) {
        console.error('[clave] workspace file listener failed', err)
      }
    }
  }

  /** Stop every watcher (the server stopping, the app quitting). */
  close(): void {
    for (const { cleanup } of [...this.watchers.values()]) cleanup()
  }
}

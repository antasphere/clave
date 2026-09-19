import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import {
  describeElevated,
  sanitizeElevated,
  type ClaveGroupData,
  type ClaveFileReadResult
} from './clave-trust'

export {
  describeElevated,
  sanitizeElevated,
  type ClaveGroupData,
  type ClaveFileReadResult
} from './clave-trust'

interface ClaveFileRaw {
  $schema?: string
  // Single-group format
  name?: string
  cwd?: string
  color?: string | null
  prompt?: string
  sessions?: ClaveGroupData['sessions']
  terminals?: ClaveGroupData['terminals']
  toolbar?: boolean
  category?: string
  logo?: string
  view?: string
  // Multi-group format
  groups?: Array<{
    name: string
    cwd?: string
    color?: string | null
    toolbar?: boolean
    category?: string
    logo?: string
    prompt?: string
    sessions?: ClaveGroupData['sessions']
    terminals?: ClaveGroupData['terminals']
    view?: string
  }>
}

import { createHash } from 'crypto'

/** Async existence check — keeps directory walks off the main process's event loop. */
async function exists(absolutePath: string): Promise<boolean> {
  try {
    await fs.promises.access(absolutePath)
    return true
  } catch {
    return false
  }
}

function readImageAsDataUrl(absolutePath: string): string | null {
  try {
    if (!fs.existsSync(absolutePath)) return null
    const ext = path.extname(absolutePath).toLowerCase().slice(1)
    const mime = ext === 'svg' ? 'image/svg+xml'
      : ext === 'png' ? 'image/png'
      : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp'
      : ext === 'ico' ? 'image/x-icon'
      : 'application/octet-stream'
    const data = fs.readFileSync(absolutePath)
    return `data:${mime};base64,${data.toString('base64')}`
  } catch {
    return null
  }
}

/** Active .clave file watchers keyed by absolute file path */
const claveWatchers = new Map<string, { watcher: fs.FSWatcher; cleanup: () => void }>()

/** Suppress file-changed events briefly after we write (to avoid echo) */
const recentWrites = new Set<string>()

// ── .clave trust gate ───────────────────────────────────────────────────────
// A .clave file can auto-run shell commands (commandMode: 'auto') and launch
// agents with permission prompts disabled (dangerousMode). These files are made
// to be shared/checked-in, so opening one authored by someone else must not
// silently execute code. We track trusted file *content* (hash) and only honor
// auto-run / dangerousMode for content the user explicitly trusted or authored.

let trustedHashes: Set<string> | null = null

function trustStorePath(): string {
  return path.join(app.getPath('userData'), 'clave-trusted.json')
}

function loadTrustedHashes(): Set<string> {
  if (trustedHashes) return trustedHashes
  try {
    const raw = fs.readFileSync(trustStorePath(), 'utf-8')
    trustedHashes = new Set(JSON.parse(raw) as string[])
  } catch {
    trustedHashes = new Set()
  }
  return trustedHashes
}

function persistTrustedHashes(): void {
  if (!trustedHashes) return
  try {
    fs.writeFileSync(trustStorePath(), JSON.stringify([...trustedHashes]), 'utf-8')
  } catch {
    // best effort
  }
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function trustContent(content: string): void {
  const set = loadTrustedHashes()
  set.add(hashContent(content))
  persistTrustedHashes()
}

function isTrusted(content: string): boolean {
  return loadTrustedHashes().has(hashContent(content))
}

// ── Trusted workspace roots (VS Code Workspace Trust style) ──────────────────
// Content-hash trust above is fragile: every distinct .clave file prompts, and
// any edit (incl. the app's own rewrites) re-prompts. Instead, when the user
// explicitly *adds a workspace folder* we trust that folder as a root, and every
// .clave discovered under it skips the prompt. Files opened from outside any
// trusted root still fall back to the content-hash gate.

let trustedRoots: string[] | null = null

function trustedRootsPath(): string {
  return path.join(app.getPath('userData'), 'clave-trusted-roots.json')
}

/** Resolve symlinks + normalize so trust checks can't be defeated by path tricks. */
function normalizeRoot(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p))
  } catch {
    return path.resolve(p)
  }
}

function loadTrustedRoots(): string[] {
  if (trustedRoots) return trustedRoots
  try {
    const raw = fs.readFileSync(trustedRootsPath(), 'utf-8')
    trustedRoots = (JSON.parse(raw) as string[]).map(normalizeRoot)
  } catch {
    trustedRoots = []
  }
  return trustedRoots
}

function persistTrustedRoots(): void {
  if (!trustedRoots) return
  try {
    fs.writeFileSync(trustedRootsPath(), JSON.stringify(trustedRoots), 'utf-8')
  } catch {
    // best effort
  }
}

export function addTrustedRoot(root: string): void {
  const set = loadTrustedRoots()
  const norm = normalizeRoot(root)
  if (!set.includes(norm)) {
    set.push(norm)
    persistTrustedRoots()
  }
}

function removeTrustedRoot(root: string): void {
  const norm = normalizeRoot(root)
  trustedRoots = loadTrustedRoots().filter((r) => r !== norm)
  persistTrustedRoots()
}

/** True if absolutePath lives at or under any trusted root (after realpath). */
export function isUnderTrustedRoot(absolutePath: string): boolean {
  let real: string
  try {
    real = fs.realpathSync(absolutePath)
  } catch {
    real = path.resolve(absolutePath)
  }
  for (const root of loadTrustedRoots()) {
    const rel = path.relative(root, real)
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true
  }
  return false
}

interface ClaveFileWriteData {
  name?: string
  cwd?: string | null
  color?: string | null
  logo?: string
  prompt?: string
  view?: string
  sessions?: ClaveGroupData['sessions']
  terminals?: ClaveGroupData['terminals']
  groups?: Array<{
    name: string
    cwd: string | null
    color: string | null
    logo?: string
    prompt?: string
    view?: string
    sessions: ClaveGroupData['sessions']
    terminals: ClaveGroupData['terminals']
  }>
}

function resolveGroup(raw: { name?: string; cwd?: string; color?: string | null; toolbar?: boolean; category?: string; logo?: string; prompt?: string; sessions?: ClaveGroupData['sessions']; terminals?: ClaveGroupData['terminals']; view?: string }, dir: string, fallbackName: string): ClaveGroupData {
  return {
    name: raw.name || fallbackName,
    cwd: path.resolve(dir, raw.cwd || '.'),
    color: raw.color ?? null,
    toolbar: raw.toolbar ?? undefined,
    category: raw.category ?? undefined,
    logo: raw.logo
      ? raw.logo.startsWith('data:') ? raw.logo : readImageAsDataUrl(path.resolve(dir, raw.logo)) ?? undefined
      : undefined,
    // Free text, like a session prompt: kept as the raw template, @-tokens
    // substituted at spawn, never path-resolved here.
    ...(raw.prompt ? { prompt: raw.prompt } : {}),
    // A served view is an http(s) URL and travels verbatim; a page on disk is a
    // path and resolves against the file's root dir, exactly like `cwd`.
    ...(raw.view
      ? { view: /^https?:\/\//i.test(raw.view) ? raw.view : path.resolve(dir, raw.view) }
      : {}),
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
      // Free text — no path resolution. Auto-submitted to the agent on launch.
      // Kept as the raw template; @-tokens are substituted at spawn, not here.
      ...(s.prompt ? { prompt: s.prompt } : {}),
      // cwd stays the project dir; the spawn-at-root override happens at spawn.
      ...(s.rootSession ? { rootSession: true } : {})
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

export function registerClaveFileHandlers(): void {
  // Read a .clave file and resolve relative paths to absolute
  // Optional rootDir overrides the default (file's parent dir) for path resolution
  ipcMain.handle(
    'clave:read-file',
    async (_event, absolutePath: string, rootDir?: string): Promise<ClaveFileReadResult | null> => {
      try {
        const raw = fs.readFileSync(absolutePath, 'utf-8')
        const data: ClaveFileRaw = JSON.parse(raw)
        const dir = rootDir || path.dirname(absolutePath)
        const fallbackName = path.basename(absolutePath, '.clave')

        // Multi-group format
        const result: ClaveFileReadResult = Array.isArray(data.groups)
          ? { type: 'multi', groups: data.groups.map((g, i) => resolveGroup(g, dir, `Group ${i + 1}`)) }
          : { type: 'single', ...resolveGroup(data, dir, fallbackName) }

        // Trust gate: a file requesting auto-run or dangerousMode that the user
        // has neither authored nor trusted must be confirmed before its commands
        // can execute. Trust is resolved in order: (1) the file lives under a
        // trusted workspace root, (2) the supplied rootDir is itself a trusted
        // root, (3) the exact content hash was previously trusted/authored
        // (back-compat). Default to the safe (no-elevation) outcome.
        const { autoCommands, prompts, dangerous } = describeElevated(result)
        const elevated = autoCommands.length > 0 || prompts.length > 0 || dangerous
        const trusted =
          isUnderTrustedRoot(absolutePath) ||
          (rootDir != null && isUnderTrustedRoot(rootDir)) ||
          isTrusted(raw)
        if (elevated && !trusted) {
          const win = BrowserWindow.fromWebContents(_event.sender)
          const detailLines: string[] = []
          if (autoCommands.length > 0) {
            detailLines.push('Commands that would run automatically:')
            detailLines.push(...autoCommands.map((c) => `  • ${c}`))
          }
          if (prompts.length > 0) {
            if (detailLines.length > 0) detailLines.push('')
            detailLines.push('Instructions that would be auto-submitted to an agent:')
            detailLines.push(...prompts.map((p) => {
              const flat = p.replace(/\s+/g, ' ').trim()
              return `  • ${flat.length > 120 ? flat.slice(0, 117) + '…' : flat}`
            }))
          }
          if (dangerous) {
            detailLines.push('')
            detailLines.push('One or more agents would start with permission prompts disabled (--dangerously-skip-permissions).')
          }
          const folderForTrust = rootDir || path.dirname(absolutePath)
          const { response, checkboxChecked } = await dialog.showMessageBox(win!, {
            type: 'warning',
            buttons: ['Open safely', 'Trust and run', 'Cancel'],
            defaultId: 0,
            cancelId: 2,
            noLink: true,
            checkboxLabel: `Trust all workspace files in “${path.basename(folderForTrust)}”`,
            checkboxChecked: false,
            title: 'Review workspace file',
            message: `“${path.basename(absolutePath)}” wants to run content automatically.`,
            detail: detailLines.join('\n') + '\n\nOnly trust this file if you recognise and understand what it would run.'
          })
          if (response === 2) return null // Cancel
          if (checkboxChecked) addTrustedRoot(folderForTrust)
          if (response === 1) {
            if (!checkboxChecked) trustContent(raw) // Trust and run this exact file
            return result
          }
          // Open safely — but folder trust (if ticked) supersedes sanitization
          return checkboxChecked ? result : sanitizeElevated(result)
        }

        return result
      } catch (err) {
        console.error('[clave] Failed to read .clave file:', absolutePath, err)
        return null
      }
    }
  )

  // Write a .clave file, converting absolute paths to relative
  // Optional rootDir overrides the default (file's parent dir) for path resolution
  ipcMain.handle(
    'clave:write-file',
    async (_event, absolutePath: string, pinned: ClaveFileWriteData, rootDir?: string): Promise<void> => {
      try {
        const dir = rootDir || path.dirname(absolutePath)

        const toRelative = (abs: string | null): string => {
          if (!abs) return '.'
          const rel = path.relative(dir, abs)
          return rel === '' ? '.' : rel
        }

        const serializeGroup = (g: { name: string; cwd: string | null; color: string | null; toolbar?: boolean; category?: string; logo?: string; prompt?: string; view?: string; sessions: ClaveGroupData['sessions']; terminals: ClaveGroupData['terminals'] }): NonNullable<ClaveFileRaw['groups']>[number] => ({
          name: g.name,
          cwd: toRelative(g.cwd),
          color: g.color,
          ...(g.toolbar ? { toolbar: true } : {}),
          ...(g.category ? { category: g.category } : {}),
          ...(g.logo ? { logo: g.logo.startsWith('data:') ? g.logo : toRelative(g.logo) } : {}),
          ...(g.prompt ? { prompt: g.prompt } : {}),
          // Mirror of the read: a URL verbatim, a page on disk back to relative.
          ...(g.view ? { view: /^https?:\/\//i.test(g.view) ? g.view : toRelative(g.view) } : {}),
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
            ...(s.rootSession ? { rootSession: true } : {})
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
        })

        let output: object

        // Multi-group format
        if (pinned.groups) {
          output = {
            $schema: 'clave/1.0',
            groups: pinned.groups.map(serializeGroup)
          }
        } else {
          // Single-group format
          output = {
            $schema: 'clave/1.0',
            ...serializeGroup({
              name: pinned.name || '',
              cwd: pinned.cwd || null,
              color: pinned.color || null,
              logo: pinned.logo,
              sessions: pinned.sessions || [],
              terminals: pinned.terminals || []
            })
          }
        }

        // Suppress the watcher echo for this file
        recentWrites.add(absolutePath)
        setTimeout(() => recentWrites.delete(absolutePath), 1000)

        const serialized = JSON.stringify(output, null, 2) + '\n'
        fs.writeFileSync(absolutePath, serialized, 'utf-8')
        // The user authored this content, so trust it — they won't be re-prompted
        // when reopening their own workspace file.
        trustContent(serialized)
      } catch (err) {
        console.error('[clave] Failed to write .clave file:', absolutePath, err)
      }
    }
  )

  // Discover .clave files in a folder (legacy workspace.clave + .clave/workspaces/*.clave)
  // rootDir: the folder paths should be resolved relative to (= the selected folder)
  // For legacy workspace.clave, rootDir is null (same as file's parent dir)
  // For .clave/workspaces/*.clave, rootDir is the selected folder
  ipcMain.handle(
    'clave:discover-files',
    async (_event, folderPath: string): Promise<{ name: string; path: string; rootDir: string | null }[]> => {
      const results: { name: string; path: string; rootDir: string | null }[] = []

      // Legacy: direct workspace.clave in the folder (paths relative to its own dir = folderPath)
      const directFile = path.join(folderPath, 'workspace.clave')
      if (fs.existsSync(directFile)) {
        results.push({ name: 'workspace', path: directFile, rootDir: null })
      }

      // New: scan .clave/workspaces/*.clave (paths relative to the root folder)
      const workspacesDir = path.join(folderPath, '.clave', 'workspaces')
      try {
        if (fs.existsSync(workspacesDir) && fs.statSync(workspacesDir).isDirectory()) {
          const entries = fs.readdirSync(workspacesDir)
          for (const entry of entries) {
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
  )

  // Recursively discover .clave files under a root directory
  // Used by workspaces with autoDiscover enabled
  ipcMain.handle(
    'clave:discover-files-recursive',
    async (_event, rootDir: string, config?: { patterns?: string[]; exclude?: string[]; maxDepth?: number; workspaceId?: string }): Promise<{ name: string; path: string; rootDir: string }[]> => {
      const patterns = config?.patterns ?? ['workspace.clave', '.clave/workspace.clave']
      const exclude = new Set(config?.exclude ?? ['node_modules', '.git', 'references', 'build', 'dist', '.next', '.turbo'])
      // Depth 6 covers a workspace like ~/.antasphere, where checkouts sit at
      // labs/products/<family>/<tool>/<repo> and skills nest a level deeper
      // still. Affordable because a directory holding a workspace file is not
      // descended into (see scan()), so the walk stops at project level instead
      // of crawling every source tree.
      const maxDepth = config?.maxDepth ?? 6
      const workspaceId = config?.workspaceId // e.g. "romain" → prefer romain.clave over default.clave
      const results: { name: string; path: string; rootDir: string }[] = []

      async function findClaveFile(dir: string): Promise<string | null> {
        // 1. Check fixed pattern files
        for (const pattern of patterns) {
          const filePath = path.join(dir, pattern)
          if (await exists(filePath)) return filePath
        }
        // 2. Check .clave/workspaces/*.clave — priority: {workspaceId}.clave → default.clave → first found
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
        } catch { /* not a directory, or unreadable */ }
        return null
      }

      async function scan(dir: string, depth: number): Promise<void> {
        if (depth > maxDepth) return

        const found = await findClaveFile(dir)
        if (found) {
          results.push({ name: path.basename(dir), path: found, rootDir: dir })
          // A directory that defines a workspace is a leaf: one workspace per
          // project/repo, so its subtree cannot hold another. Stopping here is
          // what keeps a deeper maxDepth cheap — without it the walk descends
          // into every source tree under every match. The one exception is the
          // scan root (depth 0): the root workspace file itself lives there,
          // right above the projects being discovered, so the root must still
          // be descended into.
          if (depth > 0) return
        }

        let entries: fs.Dirent[]
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true })
        } catch {
          return
        }

        // Recurse into subdirectories
        const subdirs = entries.filter((e) => e.isDirectory() && !exclude.has(e.name) && !e.name.startsWith('.'))
        await Promise.all(subdirs.map((d) => scan(path.join(dir, d.name), depth + 1)))
      }

      await scan(rootDir, 0)
      // Sort alphabetically by name for stable ordering
      results.sort((a, b) => a.name.localeCompare(b.name))
      return results
    }
  )

  // Read autoDiscover config from a .clave file (lightweight, no group parsing)
  ipcMain.handle(
    'clave:read-auto-discover',
    async (_event, filePath: string): Promise<{ enabled: boolean; patterns?: string[]; exclude?: string[]; maxDepth?: number } | null> => {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8')
        const data = JSON.parse(raw)
        if (!data.autoDiscover) return null
        if (data.autoDiscover === true) return { enabled: true }
        return data.autoDiscover
      } catch {
        return null
      }
    }
  )

  // Check if a file exists
  ipcMain.handle('clave:file-exists', (_event, absolutePath: string): boolean => {
    try {
      return fs.existsSync(absolutePath)
    } catch {
      return false
    }
  })

  // Watch a .clave file for external changes
  ipcMain.handle('clave:watch-file', (_event, absolutePath: string) => {
    if (claveWatchers.has(absolutePath)) return

    const win = BrowserWindow.fromWebContents(_event.sender)
    if (!win) return

    try {
      let debounceTimer: NodeJS.Timeout | null = null

      // Watch the parent directory, not the file itself: editors and agents
      // replace files via atomic rename, which orphans a file-inode watcher
      // after the first change. A directory watch survives inode swaps.
      const dir = path.dirname(absolutePath)
      const base = path.basename(absolutePath)
      const watcher = fs.watch(dir, (_eventType, filename) => {
        // filename can be null on some platforms — treat as a possible match
        if (filename && filename !== base) return
        if (recentWrites.has(absolutePath)) return

        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          if (win && !win.isDestroyed()) {
            win.webContents.send('clave:file-changed', absolutePath)
          }
        }, 500)
      })

      const cleanup = (): void => {
        if (debounceTimer) clearTimeout(debounceTimer)
        watcher.close()
        claveWatchers.delete(absolutePath)
      }

      watcher.on('error', cleanup)
      claveWatchers.set(absolutePath, { watcher, cleanup })
    } catch (err) {
      console.warn('[clave] Watch failed for:', absolutePath, (err as Error).message)
    }
  })

  // Stop watching a .clave file
  ipcMain.handle('clave:unwatch-file', (_event, absolutePath: string) => {
    const existing = claveWatchers.get(absolutePath)
    if (existing) existing.cleanup()
  })

  // Save dialog for exporting .clave files
  ipcMain.handle(
    'dialog:saveFile',
    async (
      _event,
      defaultName: string,
      filters: { name: string; extensions: string[] }[]
    ): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(_event.sender)
      const result = await dialog.showSaveDialog(win!, {
        defaultPath: defaultName,
        filters
      })
      if (result.canceled || !result.filePath) return null
      return result.filePath
    }
  )

  // Get the Downloads folder path
  ipcMain.handle('app:get-downloads-path', () => app.getPath('downloads'))
  ipcMain.handle('app:get-user-data-path', () => app.getPath('userData'))

  // Read an image file and return as data URL
  ipcMain.handle('clave:read-image', (_event, absolutePath: string): string | null => {
    return readImageAsDataUrl(absolutePath)
  })

  // Trusted workspace roots (folder-level trust for .clave files)
  ipcMain.handle('clave:trust-root', (_event, root: string) => {
    addTrustedRoot(root)
  })
  ipcMain.handle('clave:untrust-root', (_event, root: string) => {
    removeTrustedRoot(root)
  })
  ipcMain.handle('clave:list-trusted-roots', (): string[] => {
    return loadTrustedRoots()
  })

  // Preferences get/set
  ipcMain.handle('preferences:get', (_event, key: string) => {
    return preferencesManager.get(key)
  })

  ipcMain.handle('preferences:set', (_event, key: string, value: unknown) => {
    preferencesManager.set(key, value)
  })
}

/** Cleanup all watchers (call on app quit) */
export function cleanupClaveWatchers(): void {
  for (const { cleanup } of claveWatchers.values()) {
    cleanup()
  }
}

// ── Inline preferences manager (simple key-value JSON file) ──

class PreferencesManager {
  private filePath: string
  private cache: Record<string, unknown> = {}

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'clave-preferences.json')
    this.load()
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      this.cache = JSON.parse(raw)
    } catch {
      this.cache = {}
    }
  }

  get(key: string): unknown {
    return this.cache[key] ?? null
  }

  set(key: string, value: unknown): void {
    this.cache[key] = value
    this.save()
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8')
    } catch (err) {
      console.error('[preferences] Failed to save:', err)
    }
  }
}

const preferencesManager = new PreferencesManager()

/** Read a persisted app preference from the main process (e.g. the global
 *  tmux toggle, which the PTY spawn handler consults as a default). */
export function getPreference(key: string): unknown {
  return preferencesManager.get(key)
}

/** Persist one app preference from a main-process feature. */
export function setPreference(key: string, value: unknown): void {
  preferencesManager.set(key, value)
}

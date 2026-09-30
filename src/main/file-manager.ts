import * as fs from 'fs/promises'
import { existsSync } from 'fs'
import * as path from 'path'
import fg from 'fast-glob'
import { IGNORED_DIRECTORIES, MAX_FILES, MAX_FILE_SIZE, BINARY_PROBE_SIZE } from './constants'

export interface DirEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
}

export interface FileStat {
  type: 'file' | 'directory'
  size: number
  modified: number
}

export interface FileReadResult {
  content: string
  truncated: boolean
  size: number
  binary: boolean
}

function validatePath(rootCwd: string, requestedPath: string): string {
  const resolved = path.resolve(rootCwd, requestedPath)
  // Separator-aware containment check: a bare startsWith would let a sibling
  // directory sharing a name prefix (e.g. `<root>-secret`) escape the root.
  const base = rootCwd.endsWith(path.sep) ? rootCwd : rootCwd + path.sep
  if (resolved !== rootCwd && !resolved.startsWith(base)) {
    throw new Error('Path traversal detected')
  }
  return resolved
}

class FileManager {
  async listFiles(cwd: string): Promise<{ files: string[]; truncated: boolean }> {
    const files = await fg('**/*', {
      cwd,
      dot: false,
      ignore: IGNORED_DIRECTORIES.map((p) => `**/${p}/**`),
      onlyFiles: true,
      followSymbolicLinks: false
    })

    const truncated = files.length >= MAX_FILES
    return {
      files: files.slice(0, MAX_FILES).sort(),
      truncated
    }
  }

  /**
   * Synchronous existence check, sandboxed to the root. Used by the Files-tab
   * context menu to decide (instantly, within the synchronous right-click
   * handler) whether a folder is a Slideless deck.
   */
  existsSync(rootCwd: string, relPath: string): boolean {
    try {
      return existsSync(validatePath(rootCwd, relPath))
    } catch {
      return false
    }
  }

  async readDir(rootCwd: string, dirPath: string): Promise<DirEntry[]> {
    const resolved = validatePath(rootCwd, dirPath)
    const entries = await fs.readdir(resolved, { withFileTypes: true })

    const filtered = entries.filter((e) => {
      if (IGNORED_DIRECTORIES.includes(e.name)) return false
      return true
    })

    const results: DirEntry[] = []
    for (const entry of filtered) {
      const entryPath = path.join(dirPath === '.' ? '' : dirPath, entry.name)
      const result: DirEntry = {
        name: entry.name,
        path: entryPath,
        type: entry.isDirectory() ? 'directory' : 'file'
      }
      if (entry.isFile()) {
        try {
          const stat = await fs.stat(path.join(resolved, entry.name))
          result.size = stat.size
        } catch (err) {
          console.warn('[fs] stat failed for entry:', entry.name, (err as Error).message)
        }
      }
      results.push(result)
    }

    // Sort: folders first, then alphabetical case-insensitive
    results.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

    return results
  }

  async readFile(rootCwd: string, filePath: string): Promise<FileReadResult> {
    const resolved = validatePath(rootCwd, filePath)
    const stat = await fs.stat(resolved)

    if (stat.isDirectory()) {
      throw new Error('Cannot read a directory')
    }

    // Check for binary by reading first 8KB
    const fd = await fs.open(resolved, 'r')
    try {
      const probe = Buffer.alloc(Math.min(BINARY_PROBE_SIZE, stat.size))
      const { bytesRead } = await fd.read(probe, 0, probe.length, 0)
      const isBinary = probe.subarray(0, bytesRead).includes(0)

      if (isBinary) {
        return { content: '', truncated: false, size: stat.size, binary: true }
      }
    } finally {
      await fd.close()
    }

    const truncated = stat.size > MAX_FILE_SIZE
    const content = await fs.readFile(resolved, {
      encoding: 'utf-8',
      flag: 'r'
    })

    return {
      content: truncated ? content.slice(0, MAX_FILE_SIZE) : content,
      truncated,
      size: stat.size,
      binary: false
    }
  }

  async stat(rootCwd: string, filePath: string): Promise<FileStat> {
    const resolved = validatePath(rootCwd, filePath)
    const s = await fs.stat(resolved)
    return {
      type: s.isDirectory() ? 'directory' : 'file',
      size: s.size,
      modified: s.mtimeMs
    }
  }

  async writeFile(rootCwd: string, filePath: string, content: string): Promise<void> {
    const resolved = validatePath(rootCwd, filePath)
    await fs.writeFile(resolved, content, 'utf-8')
  }

  async createFile(rootCwd: string, filePath: string): Promise<void> {
    const resolved = validatePath(rootCwd, filePath)
    // Ensure parent directory exists
    await fs.mkdir(path.dirname(resolved), { recursive: true })
    // Create empty file (fail if already exists)
    await fs.writeFile(resolved, '', { flag: 'wx' })
  }

  async createDirectory(rootCwd: string, dirPath: string): Promise<void> {
    const resolved = validatePath(rootCwd, dirPath)
    await fs.mkdir(resolved, { recursive: true })
  }
}

export const fileManager = new FileManager()

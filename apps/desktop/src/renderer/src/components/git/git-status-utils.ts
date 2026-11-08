import type { GitFileStatus } from '../../../../preload/index.d'

export type PullStrategy = 'auto' | 'merge' | 'rebase' | 'ff-only'

/** The row's status in the user's words, not git's letters: what the dot beside
    the file name says on hover and to a screen reader (2026-09-21). */
export function statusWord(status: GitFileStatus['status']): string {
  switch (status) {
    case 'staged':
      return 'New, ready to commit'
    case 'modified':
      return 'Changed'
    case 'deleted':
      return 'Removed'
    case 'untracked':
      return 'New'
    case 'staged-modified':
      return 'Changed, ready to commit'
    case 'staged-deleted':
      return 'Removed, ready to commit'
    case 'renamed':
      return 'Renamed, ready to commit'
  }
}

export function statusColor(status: GitFileStatus['status']): string {
  switch (status) {
    case 'staged':
    case 'renamed':
      return 'text-green-400'
    case 'modified':
    case 'staged-modified':
      return 'text-git-modified'
    case 'deleted':
    case 'staged-deleted':
      return 'text-red-400'
    case 'untracked':
      return 'text-text-tertiary'
  }
}

export function splitPath(filePath: string): { name: string; dir: string } {
  const lastSlash = filePath.lastIndexOf('/')
  if (lastSlash === -1) return { name: filePath, dir: '' }
  return { name: filePath.slice(lastSlash + 1), dir: filePath.slice(0, lastSlash + 1) }
}

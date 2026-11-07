import { parseResourceKey } from '@clave/contract/fleet'
/**
 * The file paths a drop carries, whichever way they arrived: Finder hands
 * real File objects, VS Code and friends a text/uri-list, Clave's own file and
 * git panels newline-separated absolute paths as text/plain. One reader for
 * every drop target, so the terminal pane and the chat composer accept the
 * same drags.
 */
export function pathsFromDataTransfer(dt: DataTransfer): string[] {
  const owned = dt.getData('application/x-clave-files')
  if (owned) {
    try {
      const paths = JSON.parse(owned) as unknown
      if (
        Array.isArray(paths) &&
        paths.every(
          (p) => typeof p === 'string' && parseResourceKey('file', p).serverId !== 'local'
        )
      )
        return paths
    } catch {
      return []
    }
  }
  // 1. Files from a native file manager
  if (dt.files.length > 0) {
    const paths = Array.from(dt.files)
      .map((f) => window.electronAPI.getPathForFile(f))
      .filter(Boolean)
    if (paths.length) return paths
  }
  // 2. text/uri-list (VS Code, other apps)
  const uriList = dt.getData('text/uri-list')
  if (uriList) {
    const paths = uriList
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith('#'))
      .map((uri) => {
        try {
          const url = new URL(uri.trim())
          if (url.protocol === 'file:') return decodeURIComponent(url.pathname)
        } catch {
          // not a valid URL
        }
        return ''
      })
      .filter(Boolean)
    if (paths.length) return paths
  }
  // 3. text/plain: absolute paths, one per line (Clave's own panels)
  const text = dt.getData('text/plain')
  if (!text) return []
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('/') || l.startsWith('~'))
}

/** A path as it reads in a message: quoted only when a shell would need it. */
export function pathForMessage(p: string): string {
  return /^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`
}

/** What a failure says, in the words of whoever refused: an IPC error's
 *  routing prefix is not part of the sentence. */
export function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').trim()
}

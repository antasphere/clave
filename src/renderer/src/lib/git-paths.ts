/**
 * A repository in the git panel is named by the key of its folder (wave
 * wcs1023, lane C, #242): the plain path for the Mac's own, and
 * `resourceKey('file', serverId, path)` for a checkout on a Clave server.
 * The key is what every store keyed by folder holds (a commit message draft,
 * the journey, the diff preview, the status caches), so the same path on two
 * machines never shares a drawer; it is not a path to read. These are the
 * two readings the panel shows, decoded at the display site and nowhere
 * else, so the key travels intact to the routing boundary.
 */
import { parseResourceKey } from '@clave/contract/fleet'

/** The folder a repository key names, as a path to read. */
export function repoDisplayPath(key: string): string {
  return key.startsWith('clave-owner:') ? parseResourceKey('file', key).id : key
}

/** The repository's folder name, as its row shows it. */
export function repoDisplayName(key: string): string {
  const path = repoDisplayPath(key)
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/**
 * The relative prefix of `folder` under `root`, with its trailing slash, when
 * `folder` is strictly inside `root` and both belong to the same owner; null
 * otherwise. Both are keys; a Mac folder under a server root is never inside.
 */
export function relativeFolderPrefix(folder: string, root: string): string | null {
  const owner = (key: string): string =>
    key.startsWith('clave-owner:') ? parseResourceKey('file', key).serverId : 'local'
  if (owner(folder) !== owner(root)) return null
  const folderPath = repoDisplayPath(folder)
  const rootPath = repoDisplayPath(root)
  if (!folderPath.startsWith(rootPath + '/')) return null
  return folderPath.slice(rootPath.length + 1) + '/'
}

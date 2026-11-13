/**
 * One spelling for a git remote, so two checkouts of the same repository
 * match whatever URL form each machine cloned with (PRDCT-4151, the pairing
 * key of a workspace laid on two machines): `git@github.com:acme/shop.git`,
 * `https://github.com/acme/shop`, `ssh://git@github.com:22/acme/shop.git` and
 * `GitHub.com/Acme/Shop` all read `github.com/acme/shop`. A remote that is a
 * path on the disk (a bare repository beside the checkout, which is what the
 * end-to-end fleet uses) keeps its absolute path without `.git`. Nothing to
 * say answers null.
 */
export function normalizeGitRemote(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null
  const value = url.trim()
  if (!value) return null
  let host = ''
  let path = value
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const parsed = new URL(value)
      host = parsed.protocol === 'file:' ? '' : parsed.hostname.toLowerCase()
      path = decodeURIComponent(parsed.pathname)
    } catch {
      return null
    }
  } else if (!value.startsWith('/') && !value.startsWith('.')) {
    // scp-like: [user@]host:path
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value)
    if (scp) {
      host = scp[1].toLowerCase()
      path = scp[2]
    }
  }
  path = path
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  if (host) path = path.replace(/^\/+/, '')
  if (!path) return null
  return host ? `${host}/${path}`.toLowerCase() : path
}

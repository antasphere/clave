/**
 * What a decision sends is data the person wrote or the agent touched, and it
 * leaves the machine for TypeSafe (PRDCT-5179). Before it does, it is clipped
 * and scrubbed, by these rules, in this order:
 *
 * 1. an absolute path inside the workspace becomes relative to it (`.` for
 *    the root itself): the workspace's own folders are what a project is
 *    recognised by;
 * 2. a `file://` link takes the same rules on its path: inside the workspace
 *    the relative path alone, outside it `<path>`;
 * 3. any other absolute path becomes `<path>`. The home folder is outside
 *    the workspace, so nothing of it leaves either (a `~/…` path is read from
 *    it, by rules 1 and 3). On POSIX, a path is a `/` at a boundary (the
 *    start, a space, a quote, a bracket, `=`, `:`, `,`, `;`, `|`, `&`)
 *    followed by at least two components (`/a/b`), so a slash command
 *    (`/clear`, `/exos:lane clave 42`), a fraction, a date (`11/25/2026`),
 *    « and/or » and a link's own path are never taken; on Windows, `X:\` or
 *    `X:/` followed by a component;
 * 4. a link keeps its scheme and its host (and port) and loses its user, its
 *    password and everything after the host (`http://localhost:8080/…`); a
 *    link with nothing after its host is left as it is;
 * 5. JWTs, e-mail addresses and token-like runs are taken out, with the
 *    measurement kit's patterns.
 *
 * The links are found together with the paths, so a path inside a link is
 * the link's. A limit: a path is cut at a space, so a folder with a space in
 * its name (`/Volumes/Ada Backup/notes.md`) becomes `<path>` up to the space,
 * and what follows it (` Backup/notes.md`) stays. Pure: no process, no file.
 */

/** Whitespace collapsed to single spaces, cut at `limit` characters with a
 *  final `…` (the `…` counts). Pure. */
export function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  if (limit <= 1) return '…'.slice(0, Math.max(0, limit))
  return `${flat.slice(0, limit - 1).trimEnd()}…`
}

export interface ScrubContext {
  /** The workspace's root: a path inside it becomes relative to it. */
  workspaceRoot: string
  /** The person's home folder: where a `~/…` path starts. A path in it is
   *  outside the workspace like any other. */
  home: string
}

/** What a path outside the workspace becomes. */
export const PATH_MARK = '<path>'

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One component of a path: up to a separator, a space, a quote, a bracket,
 *  or a `:` that starts another path (`/opt/a/bin:/opt/b/bin`). */
const PART = String.raw`(?:[^/\s"'\`()\[\]{}<>:]|:(?!/))+`
const WINDOWS_PART = String.raw`(?:[^\\/\s"'\`()\[\]{}<>:]|:(?![\\/]))+`
/** Where a path outside the workspace may start (rule 3). */
const BOUNDARY = String.raw`(?<=^|[\s"'\`()\[\]{}<>=:,;|&])`
/** Where the workspace's root may start (rule 1): anywhere but inside a
 *  word or another path. */
const ROOT_START = String.raw`(?<![\w/.~-])`
/** What may follow the root's own name: its end, a separator, a space. */
const ROOT_END = String.raw`(?=$|[/\s"'<>()\[\]{}\`,;:!?.])`

/** A link: a scheme, `://`, and the rest up to a space, a quote or a closing
 *  bracket (rules 2 and 4). */
const LINK = String.raw`(?<![A-Za-z0-9+.-])(?<scheme>[A-Za-z][A-Za-z0-9+.-]*):\/\/(?<link>[^\s"'<>)\`]*)`
const WINDOWS = String.raw`${BOUNDARY}(?<windows>[A-Za-z]:[\\/]+${WINDOWS_PART}(?:[\\/]+${WINDOWS_PART})*[\\/]*)`
const TILDE = String.raw`${BOUNDARY}~(?<tilde>(?:/+${PART})+/*)`
const POSIX = String.raw`${BOUNDARY}(?<posix>/${PART}(?:/+${PART})+/*)`

export const JWT_PATTERN = /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g
export const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
export const TOKEN_PATTERN =
  /(?<![\w/.-])(?:sk|pk|ghp|gho|xox[abp]|AKIA|AIza)[\w-]{10,}|(?<![\w/-])[A-Za-z0-9_-]{28,}(?![\w/-])/g

/** Punctuation that closes a sentence rather than a path or a link. */
function splitTrailing(rest: string): [string, string] {
  const match = /[.,;:!?]+$/.exec(rest)
  return match ? [rest.slice(0, match.index), match[0]] : [rest, '']
}

function decoded(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

/** A link scrubbed (rules 2 and 4); `inside` answers a path's form relative
 *  to the workspace, or null when the path is outside it. */
function scrubLink(scheme: string, body: string, inside: (path: string) => string | null): string {
  const [link, trailing] = splitTrailing(body)
  const cut = link.search(/[/?#]/)
  const authority = cut === -1 ? link : link.slice(0, cut)
  const rest = cut === -1 ? '' : link.slice(cut)
  // The user and the password go, whatever the scheme.
  const host = authority.slice(authority.lastIndexOf('@') + 1)
  if (scheme.toLowerCase() === 'file') {
    const path = rest.replace(/[?#].*$/, '')
    if (!path) return `${scheme}://${host}${trailing}`
    // Another machine's file is outside the workspace by definition.
    if (host !== '' && host.toLowerCase() !== 'localhost') return `${PATH_MARK}${trailing}`
    return `${inside(decoded(path)) ?? PATH_MARK}${trailing}`
  }
  return `${scheme}://${host}${rest === '' || rest === '/' ? rest : '/…'}${trailing}`
}

/** Rules 1 to 4, the paths and the links, found together so that a path
 *  inside a link is the link's. Pure. */
export function scrubPaths(text: string, context: ScrubContext): string {
  const trimmed = context.workspaceRoot.replace(/\/+$/, '')
  const root = trimmed.startsWith('/') && trimmed.length > 1 ? trimmed : null
  const home = context.home.replace(/\/+$/, '')
  const inside = (absolute: string): string | null => {
    if (!root || (absolute !== root && !absolute.startsWith(`${root}/`))) return null
    return absolute.slice(root.length).replace(/^\/+/, '') || '.'
  }
  const workspace = root
    ? String.raw`${ROOT_START}(?<root>${escapeRegExp(root)})${ROOT_END}(?<rest>(?:/+${PART})*/*)`
    : null
  const pattern = new RegExp(
    [LINK, ...(workspace ? [workspace] : []), WINDOWS, TILDE, POSIX].join('|'),
    'g'
  )
  return text.replace(pattern, (whole: string, ...args: unknown[]) => {
    const groups = args[args.length - 1] as Record<string, string | undefined>
    if (groups.scheme !== undefined) return scrubLink(groups.scheme, groups.link ?? '', inside)
    if (groups.root !== undefined) {
      const [rest, trailing] = splitTrailing(groups.rest ?? '')
      return `${rest.replace(/^\/+/, '') || '.'}${trailing}`
    }
    if (groups.tilde !== undefined) {
      const [rest, trailing] = splitTrailing(groups.tilde)
      const resolved = home.startsWith('/') ? inside(`${home}${rest}`) : null
      return `${resolved ?? PATH_MARK}${trailing}`
    }
    const outside = groups.windows ?? groups.posix
    if (outside !== undefined) return `${PATH_MARK}${splitTrailing(outside)[1]}`
    return whole
  })
}

/** Every rule, in order: the paths and the links, then JWT, e-mail, token.
 *  Pure. */
export function scrubText(text: string, context: ScrubContext): string {
  return scrubPaths(text, context)
    .replace(JWT_PATTERN, '<token>')
    .replace(EMAIL_PATTERN, '<email>')
    .replace(TOKEN_PATTERN, '<token>')
}

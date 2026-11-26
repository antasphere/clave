/**
 * What a decision sends is data the person wrote or the agent touched, and it
 * leaves the machine for TypeSafe (PRDCT-5179). Before it does, it is clipped
 * and scrubbed, by these rules, in this order:
 *
 * 1. an absolute path inside the workspace becomes relative to it (`.` for
 *    the root itself): the workspace's own folders are what a project is
 *    recognised by. Inside is decided on the path's normalised form, its
 *    `.` and `..` segments resolved (a last `..` is the path's, never
 *    punctuation): one that climbs above the root is outside
 *    (`/Users/ada/w/../Clients/x` is `<path>`), one that stays in leaves
 *    resolved (`/Users/ada/w/src/../lib/b.ts` as `lib/b.ts`);
 * 2. a `file://` link takes the same rules on its path: inside the workspace
 *    the relative path alone, outside it `<path>`;
 * 3. any other absolute path becomes `<path>`. The home folder is outside
 *    the workspace, so nothing of it leaves either (a `~/…` path is read from
 *    it, by rules 1 and 3; a `~name/…` path, another account's home as far
 *    as the scrub can tell, is `<path>`). On POSIX, a path is a `/` followed
 *    by at least two components (`/a/b`); on Windows, `X:\` or `X:/` followed
 *    by a component. A path, the workspace's root of rule 1 included, starts
 *    at its first character unless that character follows a letter, a digit,
 *    `/`, `.`, `-` or `~`, that is unless it sits inside a word, a number or
 *    another path: after a space, a quote of any kind, `@`, `**`, `_`, `!`,
 *    `→` or any other character, it is taken. So a slash command (`/clear`,
 *    `/exos:lane clave 42`), a fraction, a date (`11/25/2026`), « and/or »,
 *    `./a/b`, `../a/b` and a link's own path (the link is found first) are
 *    never taken;
 * 4. a link keeps its scheme and its host (and port) and loses its user, its
 *    password and everything after the host (`http://localhost:8080/…`); a
 *    link with nothing after its host is left as it is;
 * 5. JWTs, e-mail addresses and token-like runs are taken out, with the
 *    measurement kit's patterns;
 * 6. last, the guarantee, whatever the starts of rules 1 to 3 let through:
 *    any occurrence left of the person's home folder, wherever it stands,
 *    and any `/Users/<name>` or `/home/<name>` segment (`\Users\<name>` and
 *    `\home\<name>` too) that does not follow a letter, a digit, `.` or `-`
 *    (after a space, a quote, `@`, `_`, `/` or `:` alike), becomes `<path>`
 *    with the rest of its path. The person's name never leaves, whatever
 *    stands before it; a folder named `home` or `Users` inside a relative
 *    path is a folder and keeps its path (`web/home/page.tsx`). The price:
 *    another account's home inside a relative path keeps its name
 *    (`backup/home/lumen/x`).
 *
 * The links are found together with the paths, so a path inside a link is
 * the link's. Two limits: a path is cut at a space, so a folder with a space
 * in its name (`/Volumes/Ada Backup/notes.md`) becomes `<path>` up to the
 * space, and what follows it (` Backup/notes.md`) stays; and a path ends at
 * a space, an ASCII quote or a bracket, so a closing curly quote, `»` or
 * `**` right after it goes with it (`“/a/b”` leaves as `“<path>`). Pure: no
 * process, no file.
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
/** Where a path may start, the workspace's root (rule 1) and any other
 *  (rule 3) alike: anywhere but after a letter, a digit, `/`, `.`, `-` or
 *  `~`, that is inside a word, a number or another path. Nothing else keeps
 *  a path whole: not an underscore, a curly quote, `@` nor `*`. */
const START = String.raw`(?<![A-Za-z0-9/.~-])`
/** What may follow the root's own name: its end, a separator, a space. */
const ROOT_END = String.raw`(?=$|[/\s"'<>()\[\]{}\`,;:!?.])`

/** A link: a scheme, `://`, and the rest up to a space, a quote or a closing
 *  bracket (rules 2 and 4). */
const LINK = String.raw`(?<![A-Za-z0-9+.-])(?<scheme>[A-Za-z][A-Za-z0-9+.-]*):\/\/(?<link>[^\s"'<>)\`]*)`
const WINDOWS = String.raw`${START}(?<windows>[A-Za-z]:[\\/]+${WINDOWS_PART}(?:[\\/]+${WINDOWS_PART})*[\\/]*)`
/** `~/…`, or `~name/…`: the home of the account `name`. */
const TILDE = String.raw`${START}~(?<user>[A-Za-z_][\w.-]*)?(?<tilde>(?:/+${PART})+/*)`
const POSIX = String.raw`${START}(?<posix>/${PART}(?:/+${PART})+/*)`

/** A home folder's segment as the systems write it (rule 6): `/Users/<name>`,
 *  `/home/<name>`, and the same with `\` (`C:\Users\<name>`, a WSL home),
 *  where it does not follow a letter, a digit, `.` or `-`: there it is a
 *  folder of a relative path (`web/home/page.tsx`). */
const HOME_SEGMENT = String.raw`(?<![A-Za-z0-9.-])[\\/](?:Users|home)[\\/]+${WINDOWS_PART}`
/** The rest of a path after a home folder, on either separator (rule 6). */
const HOME_REST = String.raw`(?:[\\/]+${WINDOWS_PART})*[\\/]*`
/** A name that goes on past the home folder's own (`/srv/adam` is not the
 *  home `/srv/ada`). */
const NAME_GOES_ON = String.raw`[A-Za-z0-9_-]`

export const JWT_PATTERN = /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g
export const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
export const TOKEN_PATTERN =
  /(?<![\w/.-])(?:sk|pk|ghp|gho|xox[abp]|AKIA|AIza)[\w-]{10,}|(?<![\w/-])[A-Za-z0-9_-]{28,}(?![\w/-])/g

/** Punctuation that closes a sentence rather than a path or a link. A last
 *  segment `..` is the path's own, never punctuation: it climbs. */
function splitTrailing(rest: string): [string, string] {
  const match = /[.,;:!?]+$/.exec(rest)
  if (!match) return [rest, '']
  const climbs = /[\\/]$/.test(rest.slice(0, match.index)) && /^\.\.(?!\.)/.test(match[0])
  const cut = match.index + (climbs ? 2 : 0)
  return [rest.slice(0, cut), rest.slice(cut)]
}

/** An absolute POSIX path with its `.` and `..` segments resolved and its
 *  separators single, a last one kept, as `path.posix.normalize` writes it;
 *  a `..` at `/` stays there. Pure. */
function normalised(absolute: string): string {
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }
  const path = `/${parts.join('/')}`
  return path !== '/' && absolute.endsWith('/') ? `${path}/` : path
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
  const under = (path: string): boolean => path === root || path.startsWith(`${root}/`)
  // A path that starts in the workspace is decided on its normalised form:
  // one that climbs above the root is outside.
  const inside = (absolute: string): string | null => {
    if (!root || !under(absolute)) return null
    const resolved = normalised(absolute)
    if (!under(resolved)) return null
    return resolved.slice(root.length).replace(/^\/+/, '') || '.'
  }
  const workspace = root
    ? String.raw`${START}(?<root>${escapeRegExp(root)})${ROOT_END}(?<rest>(?:/+${PART})*/*)`
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
      return `${inside(`${groups.root}${rest}`) ?? PATH_MARK}${trailing}`
    }
    if (groups.tilde !== undefined) {
      const [rest, trailing] = splitTrailing(groups.tilde)
      // Another account's home is outside the workspace as far as the
      // scrub can tell: only `~/…` is read from the home folder.
      const resolved =
        groups.user === undefined && home.startsWith('/') ? inside(`${home}${rest}`) : null
      return `${resolved ?? PATH_MARK}${trailing}`
    }
    const outside = groups.windows ?? groups.posix
    if (outside !== undefined) return `${PATH_MARK}${splitTrailing(outside)[1]}`
    return whole
  })
}

/** Rule 6, the last: any occurrence left of the home folder, wherever it
 *  stands, and any home folder's segment outside a relative path, becomes
 *  `<path>` with the rest of its path, so the person's name never leaves
 *  whatever a start of the rules before missed. Pure. */
export function scrubHomes(text: string, context: ScrubContext): string {
  const home = context.home.replace(/[\\/]+$/, '')
  const forms = [HOME_SEGMENT]
  // The home folder itself, wherever it is (`/var/root`, `/srv/ada`).
  if (home.length > 1 && /^(?:[A-Za-z]:)?[\\/]/.test(home))
    forms.push(String.raw`${escapeRegExp(home)}(?!${NAME_GOES_ON})`)
  const pattern = new RegExp(String.raw`(?:${forms.join('|')})${HOME_REST}`, 'g')
  return text.replace(pattern, (whole: string) => `${PATH_MARK}${splitTrailing(whole)[1]}`)
}

/** Every rule, in order: the paths and the links, then JWT, e-mail, token,
 *  and last the home folders left. Pure. */
export function scrubText(text: string, context: ScrubContext): string {
  const scrubbed = scrubPaths(text, context)
    .replace(JWT_PATTERN, '<token>')
    .replace(EMAIL_PATTERN, '<email>')
    .replace(TOKEN_PATTERN, '<token>')
  return scrubHomes(scrubbed, context)
}

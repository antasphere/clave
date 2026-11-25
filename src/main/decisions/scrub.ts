/**
 * What a decision sends is data the person wrote or the agent touched, and it
 * leaves the machine for TypeSafe (PRDCT-5179). Before it does, it is clipped
 * and scrubbed: paths made relative to the workspace (an absolute path
 * carries the person's name), e-mail addresses, the rest of a link past its
 * host, and anything shaped like a token taken out. The patterns are the
 * measurement kit's, ported, in its order: paths, JWT, e-mail, link, token.
 * Pure: no process, no file.
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
  /** The person's home folder: a path inside it starts with `~`. */
  home: string
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Where an absolute path may start: not inside a word, a link or another
 *  path (`https://host/w/…` is a link, never the workspace's `/w`). */
const PATH_START = String.raw`(?<![\w:/.~-])`
/** The rest of a path: up to a space, a quote, a bracket. */
const PATH_REST = String.raw`(?:/[^\s"'<>()\[\]{}\`]*)?`
/** What may follow a folder's own name: its end, a separator, a space. */
const PATH_END = String.raw`(?=$|[/\s"'<>()\[\]{}\`,;:!?.])`

/** Punctuation that closes a sentence rather than a path. */
function splitTrailing(rest: string): [string, string] {
  const match = /[.,;:!?]+$/.exec(rest)
  return match ? [rest.slice(0, match.index), match[0]] : [rest, '']
}

function prefixPattern(prefix: string): RegExp {
  const trimmed = prefix.replace(/\/+$/, '')
  return new RegExp(`${PATH_START}${escapeRegExp(trimmed)}${PATH_END}(${PATH_REST})`, 'g')
}

const HOME_PATTERN = new RegExp(
  `${PATH_START}/(?:Users|home)/[^/\\s"'<>()\\[\\]{}\`]+${PATH_END}(${PATH_REST})`,
  'g'
)

export const JWT_PATTERN = /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g
export const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
export const URL_PATTERN = /(https?:\/\/[^/\s"'<>)]+)[^\s"'<>)]*/g
export const TOKEN_PATTERN =
  /(?<![\w/.-])(?:sk|pk|ghp|gho|xox[abp]|AKIA|AIza)[\w-]{10,}|(?<![\w/-])[A-Za-z0-9_-]{28,}(?![\w/-])/g

/** Absolute paths only: inside the workspace relative to it (`.` for the
 *  root itself), else inside a home `~/…`. Pure. */
export function scrubPaths(text: string, context: ScrubContext): string {
  let out = text
  const root = context.workspaceRoot.replace(/\/+$/, '')
  if (root.startsWith('/') && root.length > 1) {
    out = out.replace(prefixPattern(root), (_whole, rest: string) => {
      const [path, trailing] = splitTrailing(rest)
      const relative = path.replace(/^\/+/, '')
      return `${relative || '.'}${trailing}`
    })
  }
  const home = context.home.replace(/\/+$/, '')
  if (home.startsWith('/') && home.length > 1) {
    out = out.replace(prefixPattern(home), (_whole, rest: string) => `~${rest}`)
  }
  return out.replace(HOME_PATTERN, (_whole, rest: string) => `~${rest}`)
}

/** Every rule, in the kit's order: paths, JWT, e-mail, link, token. Pure. */
export function scrubText(text: string, context: ScrubContext): string {
  return scrubPaths(text, context)
    .replace(JWT_PATTERN, '<token>')
    .replace(EMAIL_PATTERN, '<email>')
    .replace(URL_PATTERN, (_whole, origin: string) => `${origin}/…`)
    .replace(TOKEN_PATTERN, '<token>')
}

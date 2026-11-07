/**
 * The triage's last line before anything is written or shown (issue #227).
 *
 * The collectors never pick a credential up in the first place: they project
 * each source onto the contract's allowlisted fields and drop the tokens of
 * the discovery files at parse. This scrubs what can still carry one by
 * accident: an error message that quotes a request, a flag's value, a
 * health body, a label. Every known secret the collectors saw is replaced
 * wherever it appears, then the shapes a secret usually has are, and the
 * user's home directory reads as `~`.
 */

/** What replaces a secret. */
export const REDACTED = '<redacted>'

/** The shortest value treated as a KNOWN secret, as before round 4: nothing
 *  at the source bounds a token's length (an attached server's `--token` is
 *  whatever its starter chose), so every known value of six characters or
 *  more is scrubbed. Shorter secret-shaped values are still caught by the
 *  patterns below. */
export const MIN_KNOWN_SECRET = 6

/** The fixed values the collector ITSELF writes into typed snapshot fields
 *  (`src/shared/triage.ts`): server mode and ownership, a source's status, a
 *  session's or record's transport, a record's kind. Never a free-form string
 *  read from a source. Only the final pass consults this, and only for those
 *  exact fields (`collect.ts` `typedSnapshotField`), so a token equal to
 *  `separate` cannot rewrite `server.mode` while a window key, a label, an
 *  error or any other string equal to it is still scrubbed. */
export const TRUSTED_LITERALS: ReadonlySet<string> = new Set([
  // TriageServerMode, TriageServerOwnership
  'in-process',
  'separate',
  'attached',
  'unknown',
  'shell-process',
  'shell-child',
  'external',
  // TriageSource status
  'ok',
  'timeout',
  'error',
  'unavailable',
  // transports and TriageRecordKind
  'pty',
  'events',
  'claude',
  'codex',
  'antigravity',
  'pi',
  'terminal'
])

/** Where a string sits in the value the final pass walks. */
export type FieldPath = ReadonlyArray<string | number>

/** Lowercase A–Z only: always the same length, so indexes found in the folded
 *  string are indexes in the original whatever other characters it holds
 *  (`'İ'.toLowerCase()` is two code units long). */
const foldAscii = (value: string): string =>
  value.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))

export interface Redactor {
  /** Scrub a string: known secrets, secret-shaped values, the home directory. */
  text: (value: string, maxChars?: number) => string
  /** A path with the home directory as `~`, and any known secret replaced. */
  path: (value: string) => string
  /** Replace the known secrets only, in every string VALUE of a value,
   *  deeply: the final pass over a whole snapshot, whatever field a secret
   *  ended up in. Object keys are the contract's field names and are left as
   *  they are, so the pass cannot rename a property. `keep` names the typed
   *  fields whose value is the collector's own constant (see TRUSTED_LITERALS). */
  deep: <T>(value: T, keep?: (path: FieldPath, value: string) => boolean) => T
}

// Secret shapes, matched case-insensitively where the key names it.
const PATTERNS: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  // An authorization header or a bearer value, whatever its scheme.
  [/\b(authorization\s*[:=]\s*)(?:bearer\s+|basic\s+|token\s+)?[^\s"',;]+/gi, `$1${REDACTED}`],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  // Provider keys and tokens with a recognisable prefix.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  // A JSON Web Token.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // `NAME=value` the way an environment or a command line spells it.
  [/\b([A-Z][A-Z0-9_]{2,})=("[^"]*"?|'[^']*'?|[^\s"']+)/g, `$1=${REDACTED}`],
  // `token=…`, `"secret": "…"`, `password: …` in a query string, JSON or YAML.
  [
    /(["']?\b[\w-]*(?:token|secret|password|passwd|api[_-]?key|credential|cookie|session[_-]?key)[\w-]*["']?\s*[:=]\s*)("[^"]*"?|'[^']*'?|[^\s&"',;}]+)/gi,
    `$1${REDACTED}`
  ]
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function createRedactor(options: {
  home: string
  /** Every secret value a collector saw (a discovery token, the MCP token). */
  secrets?: Iterable<string | null | undefined>
}): Redactor {
  // Longest first, so a secret that contains another is replaced whole.
  const secrets = [...new Set([...(options.secrets ?? [])])]
    .filter((s): s is string => typeof s === 'string' && s.length >= MIN_KNOWN_SECRET)
    .sort((a, b) => b.length - a.length)
  const lowered = secrets.map(foldAscii)
  const home = options.home.replace(/\/+$/, '')
  const homePattern = home.length > 1 ? new RegExp(`${escapeRegExp(home)}(?=/|$|\\b)`, 'g') : null

  /** Every known secret replaced, case-insensitively (a URL lowercases a host,
   *  a token in one included), by a plain scan: no expression is built from a
   *  secret, so its length or content cannot make the scrub itself fail. */
  const scrubSecrets = (value: string): string => {
    let out = value
    for (let i = 0; i < secrets.length; i++) {
      const haystack = foldAscii(out)
      const needle = lowered[i]
      let at = haystack.indexOf(needle)
      if (at < 0) continue
      let result = ''
      let from = 0
      while (at >= 0) {
        result += out.slice(from, at) + REDACTED
        from = at + needle.length
        at = haystack.indexOf(needle, from)
      }
      out = result + out.slice(from)
    }
    return out
  }

  const path = (value: string): string => {
    const scrubbed = scrubSecrets(String(value))
    return homePattern ? scrubbed.replace(homePattern, '~') : scrubbed
  }

  const deep = <T>(
    value: T,
    keep?: (path: FieldPath, value: string) => boolean,
    at: FieldPath = []
  ): T => {
    if (typeof value === 'string') return (keep?.(at, value) ? value : scrubSecrets(value)) as T
    if (Array.isArray(value)) return value.map((v, i) => deep(v, keep, [...at, i])) as T
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) out[k] = deep(v, keep, [...at, k])
      return out as T
    }
    return value
  }

  const text = (value: string, maxChars = 2000): string => {
    let out = scrubSecrets(String(value))
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement as string)
    out = homePattern ? out.replace(homePattern, '~') : out
    if (out.length > maxChars)
      out = `${out.slice(0, maxChars)}… (${out.length - maxChars} more characters cut)`
    return out
  }

  return { text, path, deep }
}

/** An error as one redacted line. */
export function errorText(redact: Redactor, error: unknown): string {
  const raw =
    error instanceof Error
      ? `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}`
      : typeof error === 'string'
        ? error
        : (() => {
            try {
              return JSON.stringify(error)
            } catch {
              return String(error)
            }
          })()
  return redact.text(raw.split('\n')[0] ?? '', 400)
}

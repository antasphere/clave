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

export interface Redactor {
  /** Scrub a string: known secrets, secret-shaped values, the home directory. */
  text: (value: string, maxChars?: number) => string
  /** A path with the home directory as `~`, nothing else touched. */
  path: (value: string) => string
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
    .filter((s): s is string => typeof s === 'string' && s.length >= 6)
    .sort((a, b) => b.length - a.length)
  const home = options.home.replace(/\/+$/, '')
  const homePattern = home.length > 1 ? new RegExp(`${escapeRegExp(home)}(?=/|$|\\b)`, 'g') : null

  const path = (value: string): string => (homePattern ? value.replace(homePattern, '~') : value)

  const text = (value: string, maxChars = 2000): string => {
    let out = String(value)
    for (const secret of secrets) out = out.split(secret).join(REDACTED)
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement as string)
    out = path(out)
    if (out.length > maxChars)
      out = `${out.slice(0, maxChars)}… (${out.length - maxChars} more characters cut)`
    return out
  }

  return { text, path }
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

/**
 * What the Slideless command line prints with `--json`, read: the answers of
 * `push` and `share`, and how a refused push says its deck is gone. Shared by
 * the routines' publisher (PRDCT-4149, which re-exports them) and an
 * artefact's links (PRDCT-4266). Pure: no process, no file.
 */

/** A finished command, as far as these readers look at it. */
export interface SlidelessExit {
  readonly code: number | null
  readonly stderr: string
  /** `ENOENT` when the binary is not on the path. */
  readonly errorCode?: string
}

/** The JSON object in the CLI's output: the whole output, else the first `{` to the end. */
export function parseJsonOutput(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim()
  const candidates = [text, text.slice(text.indexOf('{'))]
  for (const candidate of candidates) {
    if (!candidate.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>
    } catch {
      /* the next candidate */
    }
  }
  return null
}

/** The deck id and the version out of `slideless push --json`. */
export function parsePush(stdout: string): { deckId: string; version: number } | null {
  const raw = parseJsonOutput(stdout)
  if (!raw) return null
  const presentation = raw.presentation as { id?: unknown } | undefined
  const version = raw.version as { version?: unknown } | undefined
  const deckId = presentation?.id
  const n = version?.version
  if (typeof deckId !== 'string' || !deckId) return null
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return null
  return { deckId, version: n }
}

/** The link's URL and token id out of `slideless share --json`. */
export function parseShare(stdout: string): { tokenId: string; url: string } | null {
  const raw = parseJsonOutput(stdout)
  if (!raw) return null
  const url = raw.url
  const token = raw.shareToken as { id?: unknown } | undefined
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return null
  if (typeof token?.id !== 'string' || !token.id) return null
  return { tokenId: token.id, url }
}

/** A link as `slideless share --json` describes its token. A field the
 *  answer does not carry, or carries in another shape, is `undefined`: the
 *  caller says what it asked for instead. */
export interface SharedLink {
  readonly tokenId: string
  readonly url: string
  readonly name: string | undefined
  readonly createdAt: string | undefined
  readonly expiresAt: string | null | undefined
  readonly pinnedVersion: number | null | undefined
  readonly hasPassword: boolean | undefined
}

/** `parseShare`, with what the token says of itself (PRDCT-4266). */
export function parseSharedLink(stdout: string): SharedLink | null {
  const shared = parseShare(stdout)
  if (!shared) return null
  const token = parseJsonOutput(stdout)?.shareToken as Record<string, unknown>
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined
  const pinned = token.pinnedVersion
  return {
    ...shared,
    name: text(token.name),
    createdAt: text(token.createdAt),
    expiresAt: token.expiresAt === null ? null : text(token.expiresAt),
    pinnedVersion:
      pinned === null
        ? null
        : typeof pinned === 'number' && Number.isInteger(pinned)
          ? pinned
          : undefined,
    hasPassword: typeof token.hasPassword === 'boolean' ? token.hasPassword : undefined
  }
}

/** Whether a refused push says the kept deck is gone (the instance's
 *  `not_found`, a 404, "no such deck"), the one refusal a new deck answers;
 *  a network error, a signed-out key or any other refusal is not that, and a
 *  new deck would orphan the link the person keeps (round 2, Minor 2). */
export const isGone = (result: SlidelessExit): boolean =>
  result.errorCode !== 'ENOENT' &&
  result.code !== null &&
  // The CLI's refusal is on stderr; stdout may carry the deck's own id.
  /\b(not_found|not found|404|no such|does not exist|deleted)\b/i.test(result.stderr)

/** The first line that says something, trimmed and kept short. */
export const firstLine = (text: string): string =>
  (text.split('\n').find((l) => l.trim() !== '') ?? '').trim().slice(0, 300)

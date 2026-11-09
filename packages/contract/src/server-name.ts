/**
 * What a Clave server may be called (PRDCT-4241): the name a routine's
 * `runsOn` field places it by, so it is matched trimmed and case-insensitively
 * and must be one word of letters, digits, dots, underscores and dashes, up
 * to 63 (the install script's own rule for `--server-name`). `every` is
 * reserved: it is the word that places a routine on every machine. Pure and
 * free of Effect on purpose: the server entry applies it at boot, where no
 * Effect module may load (`src/main/server/lazy-load.test.ts`);
 * `server-info.ts` re-exports it.
 */
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

/** The word that places a routine on every machine that reads its file. */
export const RUNS_EVERYWHERE = 'every'

/** Whether `value` may name a server: one word, the install script's rule, not `every`. */
export function isServerName(value: unknown): value is string {
  return (
    typeof value === 'string' && SERVER_NAME.test(value) && value.toLowerCase() !== RUNS_EVERYWHERE
  )
}

/** The sentence a refused name gets. */
export const SERVER_NAME_RULE =
  'A server name is one word of letters, digits, dots, underscores and dashes, up to 63, and not "every".'

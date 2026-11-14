import { connectionVariableNames } from './connection-handover'

/**
 * What Clave's Pi extension is told of a tab's stored connection, so that it
 * can answer, before each provider request and in the Pi process's own
 * memory, "does this request go to the connection's provider AND carry the
 * connection's key?" (PRDCT-4540). Two NAMES, never a value: the provider the
 * connection gives Pi, and the variable its key rides in; plus the path of
 * the tab's report file beside its state file. A tab on no connection is told
 * nothing and the extension does nothing.
 */

/** The provider the connection gives Pi (`kimi-coding`, `clave-deepseek`). */
export const CLAVE_CONNECTION_PROVIDER_ENV = 'CLAVE_CONNECTION_PROVIDER'
/** The NAME of the variable the connection's key rides in, never its value. */
export const CLAVE_CONNECTION_KEY_VAR_ENV = 'CLAVE_CONNECTION_KEY_VAR'
/** Where the extension writes its one-line report (`on` / `off <provider>`). */
export const CLAVE_CONNECTION_REPORT_FILE_ENV = 'CLAVE_CONNECTION_REPORT_FILE'

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** The report's line read: null for `on`, the provider for `off <provider>`,
 *  undefined for anything else (a partial write, a stranger's file). */
export function parseConnectionReport(raw: string | null | undefined): string | null | undefined {
  const line = raw?.trim()
  if (line === 'on') return null
  const off = /^off (\S+)$/.exec(line ?? '')
  return off && PROVIDER_RE.test(off[1]) ? off[1] : undefined
}

/** The two names for a Pi tab on a connection: its provider, and the one
 *  variable of its environment that carries the key (none for a connection
 *  that has no key, which is then watched by its provider alone). Null when
 *  there is no provider to watch. Pure. */
export function connectionWatchNames(
  provider: string | undefined,
  providerEnv: Readonly<Record<string, string>> | undefined
): Record<string, string> | null {
  if (!provider || !PROVIDER_RE.test(provider)) return null
  const keyVars = connectionVariableNames(providerEnv ?? {}).filter((name) => NAME_RE.test(name))
  return {
    [CLAVE_CONNECTION_PROVIDER_ENV]: provider,
    ...(keyVars.length === 1 ? { [CLAVE_CONNECTION_KEY_VAR_ENV]: keyVars[0] } : {})
  }
}

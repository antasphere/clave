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

/** The report's line read, as the tab's record keeps it (`connectionLeftFor`):
 *  null for `on`; `<provider>` for `off <provider>` (another provider);
 *  `<provider> credential` for `off <provider> credential` (the connection's
 *  provider, another credential); `<provider> unchecked` for
 *  `unchecked <provider>` (Clave could not check the credential); undefined
 *  for anything else (a partial write, a stranger's file). Ids and words,
 *  never a value. */
export function parseConnectionReport(raw: string | null | undefined): string | null | undefined {
  const line = raw?.trim()
  if (line === 'on') return null
  const off = /^off (\S+)( credential)?$/.exec(line ?? '')
  if (off && PROVIDER_RE.test(off[1])) return off[2] ? `${off[1]} credential` : off[1]
  const unchecked = /^unchecked (\S+)$/.exec(line ?? '')
  if (unchecked && PROVIDER_RE.test(unchecked[1])) return `${unchecked[1]} unchecked`
  return undefined
}

/**
 * PRDCT-4540 with PRDCT-4551: usage follows the report. The ledger counts a
 * record to the connection of its session's last line at or before it, so a
 * report that the tab left its connection writes a line for the tab's Pi
 * session with NO connection, and one that it is back writes the line with
 * the connection, each at the moment of the change. Pure: the line to
 * record, or null (no Pi session, no connection to leave). The ledger skips
 * a line that changes nothing.
 */
export function ledgerLineForReport(
  record:
    | {
        piMode?: boolean
        piSessionId?: string
        connectionId?: string
        connectionLabel?: string
      }
    | null
    | undefined,
  leftFor: string | null
): { harness: 'pi'; sessionId: string; connectionId: string | null; label: string | null } | null {
  if (!record?.piMode || !record.piSessionId || !record.connectionId) return null
  return leftFor === null
    ? {
        harness: 'pi',
        sessionId: record.piSessionId,
        connectionId: record.connectionId,
        label: record.connectionLabel ?? null
      }
    : { harness: 'pi', sessionId: record.piSessionId, connectionId: null, label: null }
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

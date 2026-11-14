/**
 * A stored connection's variables past a login profile (PRDCT-4496). A
 * terminal tab, and a chat started through the shell, run their program
 * after the person's login profile, and a profile that exports the
 * connection's own variable (`KIMI_API_KEY`, say) would replace the stored
 * key with the person's. So each value also travels under a private name of
 * Clave's that no profile exports, and the command, once the profile has
 * run, gives the value its real name back and drops the private one: names
 * only on the command line, never a value. The way a Codex account's home
 * rides past the profile, without its value ever being in the command.
 */

/** The private names a connection's values travel under, in order. A
 *  connection sets at most a key and OpenCode's inline configuration; one
 *  more is spare. Credential-named, so every mask by name hides them. */
export const CLAVE_TAB_CREDENTIAL_ENV_VARS: readonly string[] = [
  'CLAVE_TAB_CREDENTIAL_1',
  'CLAVE_TAB_CREDENTIAL_2',
  'CLAVE_TAB_CREDENTIAL_3'
]

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface ConnectionHandover {
  /** The private names and their values, for the process's environment. */
  env: Record<string, string>
  /** What the POSIX command starts with, after the profile: names only. */
  command: string
}

/** The handover of `names` (the connection's own variables), their values
 *  read in `values`; nothing for a name with no value. Throws on a name that
 *  is not a variable name or on more names than private slots. */
export function connectionHandover(
  names: readonly string[],
  values: Readonly<Record<string, string | undefined>>
): ConnectionHandover {
  const carried = [...new Set(names)].sort().filter((name) => values[name] !== undefined)
  if (carried.length > CLAVE_TAB_CREDENTIAL_ENV_VARS.length)
    throw new Error('The connection sets more variables than a tab can carry.')
  const env: Record<string, string> = {}
  let command = ''
  carried.forEach((name, i) => {
    if (!ENV_NAME.test(name)) throw new Error('The connection names an invalid variable.')
    const slot = CLAVE_TAB_CREDENTIAL_ENV_VARS[i]
    env[slot] = values[name]!
    command += `${name}="$${slot}"; export ${name}; unset ${slot}; `
  })
  return { env, command }
}

/** The variables of a connection's environment that carry its credential or
 *  its configuration: every one but the Pi directory, a path that already
 *  rides on the command line. */
export function connectionVariableNames(providerEnv: Readonly<Record<string, string>>): string[] {
  return Object.keys(providerEnv).filter((name) => name !== 'PI_CODING_AGENT_DIR')
}

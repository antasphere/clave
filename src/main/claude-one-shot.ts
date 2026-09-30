import type { LaunchProfile } from '../shared/agent-launch'
import {
  findExecutable,
  resolvePosixShellLaunch,
  shellSingleQuote,
  type ShellLaunch
} from './shell-launch'

/**
 * A Clave-owned `claude -p` one-shot: a tab title, a commit message, a group
 * summary. These calls have no terminal to show an error in, so anything wrong
 * with how they start surfaces only as the fallback they carry — a title cut
 * from the message's first words, a commit message left blank — and looks
 * like a design choice. Pure, so what actually gets spawned has tests.
 */

/** The account a one-shot runs on: the session's, or none for the Default
 *  passthrough. Same two fields `buildSpawnEnv` puts on a session. */
export interface OneShotAccount {
  configDir?: string
  oauthToken?: string
}

export interface OneShotLaunch extends ShellLaunch {
  env: Record<string, string>
}

const OAUTH_TOKEN_PREFIX = 'sk-ant-oat'

/**
 * The environment a one-shot runs in. Two things the user's login shell hands
 * it are corrected here:
 *
 *  - `CLAUDECODE`, set when Clave itself was started from inside a Claude
 *    session; left in place, the CLI believes it is nested.
 *  - a Claude Code OAuth token (`claude setup-token`, `sk-ant-oat…`) exported
 *    as ANTHROPIC_API_KEY. The CLI takes that variable ahead of every other
 *    auth source and presents it as an API key; the API answers 401 and the
 *    CLI retries eleven times with backoff, past any timeout a one-shot can
 *    afford. The same token in CLAUDE_CODE_OAUTH_TOKEN — the variable Clave's
 *    own token accounts use — answers in seconds, so it is moved there unless
 *    a token is already set, in which case the misplaced one is only dropped.
 *    A real API key (`sk-ant-api…`) is left alone.
 *
 * The account's fields go on first and win: a session on a token account is
 * named on that account, whatever its shell exports.
 */
export function oneShotEnv(
  base: Readonly<Record<string, string>>,
  account: OneShotAccount = {}
): Record<string, string> {
  const env: Record<string, string> = { ...base }
  delete env.CLAUDECODE
  if (account.configDir) env.CLAUDE_CONFIG_DIR = account.configDir
  if (account.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = account.oauthToken
  const key = env.ANTHROPIC_API_KEY
  if (key !== undefined && key.startsWith(OAUTH_TOKEN_PREFIX)) {
    delete env.ANTHROPIC_API_KEY
    if (!env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = key
  }
  return env
}

/**
 * How a one-shot starts: the way a session does. The launch profile's command
 * tokens lead (a custom binary, a wrapper script, a version manager's shim —
 * whatever the user made their Claude), then the one-shot's own arguments.
 * The profile's `additionalArgs` stay out: they describe an interactive
 * session (permission modes, added directories) and a one turn with no tool
 * has no use for them. A command the login PATH places starts directly; one
 * it cannot goes through the login-shell wrapper the sessions use, diverted
 * from a shell that cannot parse it (`resolvePosixShellLaunch`).
 */
export function buildOneShotLaunch(input: {
  profile: LaunchProfile
  args: readonly string[]
  loginEnv: Readonly<Record<string, string>>
  account?: OneShotAccount
  userShell: string
  /** Where a command lives on PATH; injectable so the fallback has a test. */
  locate?: (command: string, pathEnv: string | undefined) => string | null
  platform?: NodeJS.Platform
}): OneShotLaunch {
  if (input.profile.family !== 'claude')
    throw new Error('A Claude one-shot needs a Claude launch profile')
  const argv = [...input.profile.command, ...input.args]
  const env = oneShotEnv(input.loginEnv, input.account)
  const locate = input.locate ?? findExecutable
  const executable = locate(argv[0], env.PATH)
  const launch: ShellLaunch = executable
    ? { file: executable, args: argv.slice(1) }
    : resolvePosixShellLaunch(
        input.userShell,
        `exec ${argv.map(shellSingleQuote).join(' ')}`,
        input.platform
      )
  return { ...launch, env }
}

/**
 * The login jobs of a Clave server running on its own (`standalone-source.ts`):
 * one login only, `codex login --with-api-key`, which needs no browser and no
 * terminal, so a person on the server sets a Codex key with
 * `scripts/server-accounts.mjs codex add-key`. A Claude or a ChatGPT login
 * needs a browser beside the terminal that runs it, which a daemon has not:
 * those are refused with the contract's declared failure, as before, never a
 * silent no-op. There is no job to feed or cancel, and the list is empty.
 * Nothing here imports Electron or node-pty.
 */
import type { LoginJob } from '../account-login'
import { runCodexApiKeyLogin } from '../codex-api-key-login'
import { codexAccountsManager } from '../codex-accounts'
import { getLoginShellEnv, getUserShell } from '../sessions/adapters/pty-backend'
import { SettingsUnavailable, type LoginJobsLike } from './source'

const NO_TERMINAL = 'This server has no terminal to run a login in.'

/** The environment a login runs in on the server: its login shell, the
 *  tokens a shell may export stripped so the CLI signs in afresh, and the
 *  account's own home for Codex (the app's login manager does the same). */
function codexLoginEnv(accountId: string): Record<string, string> {
  const env: Record<string, string> = { ...getLoginShellEnv(), TERM: 'xterm-256color' }
  delete env.CLAUDECODE
  const home = codexAccountsManager.syncHome(accountId, env)
  if (home) env.CODEX_HOME = home
  else delete env.OPENAI_API_KEY
  return env
}

export function daemonLogins(): LoginJobsLike {
  const listeners = new Set<(job: LoginJob) => void>()
  const refuse = (): never => {
    throw new SettingsUnavailable('login', NO_TERMINAL)
  }
  return {
    startClaudeLogin: refuse,
    startCodexLogin: refuse,
    startCodexApiKeyLogin: (accountId, apiKey) =>
      runCodexApiKeyLogin({
        accountId,
        apiKey,
        env: codexLoginEnv(accountId),
        shell: getUserShell(),
        onDone: (job) => {
          for (const listener of listeners) listener(job)
        }
      }),
    sendInput: () => {},
    cancel: () => {},
    list: () => [],
    onProgress: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

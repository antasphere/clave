import { execFile } from 'node:child_process'
import { delimiter } from 'node:path'

/**
 * The login shell's environment, for the one tool the plugin runs on the person's own
 * machine: the Slideless CLI, whose viewer serves the decks. The plugin process is handed
 * the path, the home and the temp folder by the host and nothing else, so the CLI a person
 * installed with a version manager is found the way the app finds `gh` for the GitHub panel:
 * through `/bin/zsh -lic`, the plugin's own path first.
 */

type ExecCallback = (
  error: (Error & { code?: string | number; killed?: boolean }) | null,
  stdout: string,
  stderr: string
) => void
export type ExecLike = (
  file: string,
  args: string[],
  options: {
    env: Record<string, string>
    encoding: 'utf8'
    timeout: number
    maxBuffer: number
    killSignal?: 'SIGKILL'
  },
  callback: ExecCallback
) => unknown

const realExec = execFile as unknown as ExecLike
const SHELL_TIMEOUT_MS = 15_000
const MAX_BUFFER = 16 * 1024 * 1024

/** Printed by the shell right before `env -0`: whatever a profile prints to stdout comes
 *  before it and is dropped, so a chatty `.zshrc` cannot glue its line to the first entry. */
export const ENV_MARK = '__CLAVE_ENV_0__'
export const ENV_COMMAND = `printf '%s' '${ENV_MARK}'; env -0`

/** The entries after the mark, as `env -0` wrote them; nothing when the mark never came. */
export function parseMarkedEnv(stdout: string): Record<string, string> {
  const at = stdout.indexOf(ENV_MARK)
  return at < 0 ? {} : parseEnv0(stdout.slice(at + ENV_MARK.length))
}

/** `env -0` output into a map; an entry without `=` is skipped. */
export function parseEnv0(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of text.split('\0')) {
    const at = entry.indexOf('=')
    if (at <= 0) continue
    env[entry.slice(0, at)] = entry.slice(at + 1)
  }
  return env
}

/** The path lists joined in order, each folder once, the first list's folders first. */
export function mergePaths(...lists: (string | undefined)[]): string {
  const out: string[] = []
  for (const list of lists) {
    for (const folder of (list ?? '').split(delimiter)) {
      if (folder && !out.includes(folder)) out.push(folder)
    }
  }
  return out.join(delimiter)
}

function envOf(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (typeof value === 'string') env[key] = value
  return env
}

/**
 * The environment the CLI runs in: the login shell's own (`/bin/zsh -lic env -0`, the way
 * the app finds `gh` for the GitHub panel), with the plugin's own path FIRST. The shell is
 * not the person's choice here but zsh, the one the app itself falls back on; the plugin's
 * own path comes first because the dev app and the test harness carry the CLI (or its
 * stand-in) there, while the packaged app's path is the system's four folders, which the
 * login shell lists too. A shell that fails leaves the plugin's own environment.
 */
export async function loginShellEnv(
  exec: ExecLike = realExec,
  base: NodeJS.ProcessEnv = process.env
): Promise<Record<string, string>> {
  const own = envOf(base)
  const login = await new Promise<Record<string, string>>((resolve) => {
    try {
      // SIGKILL at the deadline: an interactive shell ignores the TERM a timeout sends.
      exec(
        '/bin/zsh',
        ['-lic', ENV_COMMAND],
        {
          env: own,
          encoding: 'utf8',
          timeout: SHELL_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          killSignal: 'SIGKILL'
        },
        (error, stdout) => resolve(error ? {} : parseMarkedEnv(stdout))
      )
    } catch {
      resolve({})
    }
  })
  const env = { ...login }
  env['PATH'] = mergePaths(own['PATH'], login['PATH'])
  for (const key of ['HOME', 'TMPDIR']) {
    const value = own[key]
    if (!env[key] && value) env[key] = value
  }
  return env
}

/** The login shell's environment, resolved once per process and kept: a shell per start is
 *  slow and leaves what the person's own profile leaves (a folder per shell under some
 *  version managers). Forgotten when the CLI was found missing, so an install is seen. */
let loginEnvCache: Record<string, string> | null = null

export async function cachedLoginEnv(
  exec: ExecLike = realExec,
  base: NodeJS.ProcessEnv = process.env
): Promise<Record<string, string>> {
  if (!loginEnvCache) loginEnvCache = await loginShellEnv(exec, base)
  return loginEnvCache
}

export function forgetLoginEnv(): void {
  loginEnvCache = null
}

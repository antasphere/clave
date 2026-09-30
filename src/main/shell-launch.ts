import { accessSync, constants, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface ShellLaunch {
  file: string
  args: string[]
}

/** Wrap a string as a single shell-quoted token (safe for embedding in `zsh -c`). */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Shells whose command language is POSIX sh. They parse Clave's agent wrapper
 * as written, so the user's own shell stays in charge — and with it the
 * profile that sets their PATH order (`path_helper` on macOS reorders PATH on
 * every login; a bash user's `.bash_profile` puts it back, their absent
 * `.zprofile` would not).
 */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash'])

/**
 * Keep the user's shell for interactive terminal tabs, where its own language
 * and configuration belong. Agent launches keep it too when it speaks POSIX;
 * otherwise (Nushell, Fish, xonsh, csh…) the wrapper goes to a shell Clave
 * controls, because their parsers reject it and the agent never starts.
 */
export function resolvePosixShellLaunch(
  userShell: string,
  command?: string,
  platform: NodeJS.Platform = process.platform
): ShellLaunch {
  if (command === undefined) return { file: userShell, args: ['-l'] }

  const file = POSIX_SHELLS.has(basename(userShell))
    ? userShell
    : platform === 'darwin'
      ? '/bin/zsh'
      : '/bin/sh'
  return { file, args: ['-l', '-c', command] }
}

/**
 * Where `command` lives on `pathEnv`, or null when it is nowhere on it. An
 * events adapter has no terminal to keep the user's shell in charge of, and
 * the login environment it spawns with is already the user's own (read once,
 * `getLoginShellEnv`), so when the binary can be found there the process
 * starts directly and skips the login shell the wrapper would pay for on every
 * launch (0.85s on a machine with an ordinary zprofile). A command that names
 * a path is checked as given; a bare name is looked up entry by entry. Null
 * sends the caller back to the wrapper, so a binary only a profile can find
 * still starts the way it always did.
 */
export function findExecutable(
  command: string,
  pathEnv: string | undefined,
  canExecute: (file: string) => boolean = isExecutableFile
): string | null {
  if (!command) return null
  if (command.includes('/')) return canExecute(command) ? command : null
  for (const dir of (pathEnv ?? '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, command)
    if (canExecute(candidate)) return candidate
  }
  return null
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

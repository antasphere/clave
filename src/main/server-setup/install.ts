/**
 * This Mac as a Clave server: `scripts/install-server.sh` run from the app,
 * and what the script leaves behind read back. The script is the one way a
 * server is installed (the same script a Linux box runs by hand and the
 * daemon's self-upgrade runs again), so the app only starts it, follows the
 * phases it writes to its status file, and reads its saved options
 * (`~/.config/<name>/install.env`) and the daemon's identity file once it is
 * done.
 *
 * What the run prints goes to a private log and nowhere else: git and npm
 * output can carry credentials, so the window learns a phase, a failure code
 * from the contract's closed list, an exit code and the log's path. The
 * token read from the identity file is the caller's to hand to the saved
 * connection; nothing here logs it. Nothing here imports Electron.
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerUpgradePhase } from '@clave/contract/upgrade-failure'
import { readRunStatus, runFailure } from '../server/install-status'
import type { ServerInstallResult, ServerServiceState } from '../../shared/server-setup-types'

export function installScriptPath(opts: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}): string {
  return join(opts.isPackaged ? opts.resourcesPath : opts.appPath, 'scripts', 'install-server.sh')
}

/** The escapes of a `$'...'` word that `printf %q` writes. */
const ANSI_C: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?'
}

/** One shell word as bash's `printf %q` writes it, back to its value:
 *  backslash escapes, `'single quoted'` runs and `$'...'` runs, concatenated. */
function unquote(word: string): string {
  let out = ''
  let i = 0
  while (i < word.length) {
    const c = word[i]
    if (c === '\\') {
      out += word[i + 1] ?? ''
      i += 2
    } else if (c === "'") {
      const end = word.indexOf("'", i + 1)
      const stop = end === -1 ? word.length : end
      out += word.slice(i + 1, stop)
      i = stop + 1
    } else if (c === '$' && word[i + 1] === "'") {
      i += 2
      // Octal escapes are BYTES: under a C locale (a GUI-launched app's,
      // bash 3.2) a non-ASCII character is written one escape per byte of
      // its UTF-8, so a run of them is decoded together, not one by one.
      let bytes: number[] = []
      const flush = (): void => {
        if (bytes.length) out += Buffer.from(bytes).toString('utf8')
        bytes = []
      }
      while (i < word.length && word[i] !== "'") {
        if (word[i] !== '\\') {
          flush()
          out += word[i++]
          continue
        }
        const next = word[i + 1] ?? ''
        const octal = /^[0-7]{1,3}/.exec(word.slice(i + 1))
        if (octal) {
          bytes.push(parseInt(octal[0], 8))
          i += 1 + octal[0].length
        } else {
          flush()
          out += ANSI_C[next] ?? next
          i += 2
        }
      }
      flush()
      i += 1
    } else {
      out += c
      i += 1
    }
  }
  return out
}

const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

/** The saved options of `install-server.sh`, one `KEY=value` per line with
 *  each value written by `printf %q`; comments and blank lines are skipped. */
export function parseInstallEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const match = ENV_LINE.exec(line)
    if (match) values[match[1]] = unquote(match[2])
  }
  return values
}

/** Where the installed server answers and keeps its data, or null when the
 *  script has not completed an install under this name. */
export function readInstalledServer(opts: {
  configDir: string
  name: string
}): { url: string; dataDir: string } | null {
  let text: string
  try {
    text = readFileSync(join(opts.configDir, opts.name, 'install.env'), 'utf8')
  } catch {
    return null
  }
  const env = parseInstallEnv(text)
  const url = env.CLAVE_URL
  const dataDir = env.CLAVE_DATA_DIR
  return url && dataDir ? { url, dataDir } : null
}

const TOKEN = /^[\x21-\x7e]{32,4096}$/

/** The daemon's bearer token from `<dataDir>/daemon/identity.json`. A secret:
 *  the caller passes it on and never logs it, and the error says nothing of it. */
export function readIdentityToken(dataDir: string): string {
  const invalid = (): Error => new Error("The server's identity file holds no valid token.")
  let identity: unknown
  try {
    // JSON.parse quotes the text it chokes on, so its message is never passed on.
    identity = JSON.parse(readFileSync(join(dataDir, 'daemon', 'identity.json'), 'utf8'))
  } catch {
    throw invalid()
  }
  const token = (identity as { token?: unknown } | null)?.token
  if (typeof token !== 'string' || !TOKEN.test(token)) throw invalid()
  return token
}

/** Running when the server answers its liveness route; stopped when only
 *  its service file is there; not installed otherwise. */
export async function serviceState(opts: {
  url: string | null
  plistPath: string
  probe: (url: string) => Promise<boolean>
}): Promise<ServerServiceState> {
  if (opts.url && (await opts.probe(`${opts.url}/health/live`).catch(() => false))) return 'running'
  return existsSync(opts.plistPath) ? 'stopped' : 'not-installed'
}

export interface InstallRun {
  script: string
  args: string[]
  env: NodeJS.ProcessEnv
  logDir: string
  onPhase: (phase: ServerUpgradePhase) => void
}

const POLL_MS = 300

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Runs the script to its end, its output appended to `<logDir>/install.log`
 *  and its phases read from `<logDir>/install-status` as it writes them.
 *  Resolves with the exit code (1 when a signal or a failed start ended it),
 *  the status file's text and the log's path. */
export function runInstallScript(
  run: InstallRun
): Promise<{ code: number; status: string | null; logPath: string }> {
  mkdirSync(run.logDir, { recursive: true, mode: 0o700 })
  const logPath = join(run.logDir, 'install.log')
  const statusPath = join(run.logDir, 'install-status')
  // Emptied for each run, so a phase or a code of an earlier run is never read.
  closeSync(openSync(statusPath, 'w', 0o600))
  const fd = openSync(logPath, 'a', 0o600)
  writeSync(fd, `\n── ${new Date().toISOString()} install-server.sh ${run.args.join(' ')}\n`)
  return new Promise((resolve) => {
    let last: ServerUpgradePhase | undefined
    const poll = (): string | null => {
      const status = readText(statusPath)
      const { phase } = readRunStatus(status)
      if (phase && phase !== last) {
        last = phase
        run.onPhase(phase)
      }
      return status
    }
    const timer = setInterval(poll, POLL_MS)
    let finished = false
    const finish = (code: number): void => {
      if (finished) return
      finished = true
      clearInterval(timer)
      closeSync(fd)
      resolve({ code, status: poll(), logPath })
    }
    try {
      const child = spawn('/bin/bash', [run.script, ...run.args], {
        env: { ...run.env, CLAVE_INSTALL_STATUS_FILE: statusPath },
        stdio: ['ignore', fd, fd]
      })
      child.once('error', (error) => {
        writeSync(fd, `The install did not start: ${error.message}\n`)
        finish(1)
      })
      child.once('exit', (code) => finish(code ?? 1))
    } catch (error) {
      writeSync(fd, `The install did not start: ${(error as Error).message}\n`)
      finish(1)
    }
  })
}

/** A failed run as the window learns it: values from closed lists and the log's path. */
export function installFailure(
  status: string | null,
  code: number,
  logPath: string
): Extract<ServerInstallResult, { ok: false }> {
  const failure = runFailure(status, code, logPath)
  return {
    ok: false,
    code: failure.code ?? 'unknown',
    ...(failure.phase && { phase: failure.phase }),
    ...(failure.exitCode !== undefined && { exitCode: failure.exitCode }),
    logPath
  }
}

/**
 * A child process that announces itself: started, its first stdout line
 * read as JSON and checked to carry the fields named, and killed here when
 * it never announces (ADR 0003, wave 5). The TypeScript twin of
 * `startAnnouncing` in `scripts/server-process.mjs`, for the two places
 * inside the app that start such a child: the server entry starting its
 * terminal process (`supervisor.ts`) and the shell starting its separate
 * server (`src/main/server-child.ts`). The protocol is the one both children
 * keep: ONE JSON line on stdout once they listen, nothing else on stdout,
 * ever; the diagnostics on stderr.
 *
 * Nothing here imports Electron: the entry runs under Bun or as Node.
 */
import { spawn, type ChildProcess } from 'node:child_process'

export interface AnnouncingChild<T> {
  readonly child: ChildProcess
  /** The announcement, parsed. Rejects, with the child already killed and
   *  gone, when it exits first, stays silent past the timeout, or prints
   *  something else; the rejection carries `pid` for the record. */
  readonly announced: Promise<T>
  /** What the child wrote to stderr so far. */
  readonly stderr: () => string
}

export interface AnnouncingOptions<F extends string> {
  /** How the child is named in a message (`the terminal process`). */
  readonly what: string
  readonly cmd: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  /** The string fields the announcement must carry. */
  readonly fields: readonly F[]
  /** Each line of the child's stderr, as it comes, for the owner's log. */
  readonly onStderr?: (line: string) => void
}

/** How long a child that never announced itself is given to die after the
 *  SIGKILL before the rejection goes out anyway. */
const KILL_GRACE_MS = 2_000
/** How much of the child's stderr is kept for a message: the last of it,
 *  since a child the app keeps for its whole life would otherwise grow a
 *  copy of everything it ever logged (the round-1 verifier's note). */
export const STDERR_KEEP_BYTES = 64 * 1024

export function startAnnouncing<F extends string>(
  options: AnnouncingOptions<F>
): AnnouncingChild<Record<F, string>> {
  const child = spawn(options.cmd, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  let pending = ''
  child.stderr?.on('data', (chunk: Buffer | string) => {
    const text = String(chunk)
    stderr += text
    if (stderr.length > STDERR_KEEP_BYTES) stderr = stderr.slice(-STDERR_KEEP_BYTES)
    if (!options.onStderr) return
    pending += text
    let nl = pending.indexOf('\n')
    while (nl >= 0) {
      options.onStderr(pending.slice(0, nl))
      pending = pending.slice(nl + 1)
      nl = pending.indexOf('\n')
    }
  })
  const announced = new Promise<Record<F, string>>((resolve, reject) => {
    let out = ''
    let settled = false
    const fail = (error: Error & { pid?: number }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      error.pid = child.pid
      const finish = (): void => reject(error)
      // Gone AT the rejection, not some time after: a caller that removes
      // the child's data directory on the rejection must find nothing still
      // writing there (the script's rule, kept).
      if (child.exitCode !== null || child.signalCode !== null) return finish()
      const grace = setTimeout(finish, KILL_GRACE_MS)
      child.once('exit', () => {
        clearTimeout(grace)
        finish()
      })
      try {
        child.kill('SIGKILL')
      } catch {
        clearTimeout(grace)
        finish()
      }
    }
    const succeed = (value: Record<F, string>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(
      () =>
        fail(
          new Error(`${options.what} did not announce itself in ${options.timeoutMs} ms\n${stderr}`)
        ),
      options.timeoutMs
    )
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (settled) return
      out += String(chunk)
      const nl = out.indexOf('\n')
      if (nl < 0) return
      const line = out.slice(0, nl)
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        for (const field of options.fields)
          if (typeof parsed?.[field] !== 'string')
            throw new Error(`${options.fields.join(' and ')} expected`)
        succeed(parsed as Record<F, string>)
      } catch (err) {
        fail(
          new Error(`unreadable ${options.what} announcement "${line}": ${(err as Error).message}`)
        )
      }
    })
    child.once('error', (err) => fail(new Error(`could not start ${options.cmd}: ${err.message}`)))
    child.once('exit', (code, signal) =>
      fail(
        new Error(`${options.what} exited (${code ?? signal}) before announcing itself\n${stderr}`)
      )
    )
  })
  return { child, announced, stderr: () => stderr }
}

/** SIGTERM a child and wait for it, SIGKILL after `killAfterMs`. Resolves
 *  at once for a child already gone. */
export function stopChild(child: ChildProcess, killAfterMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const hard = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, killAfterMs)
    child.once('exit', () => {
      clearTimeout(hard)
      resolve()
    })
    try {
      child.kill('SIGTERM')
    } catch {
      clearTimeout(hard)
      resolve()
    }
  })
}

/** Resolves with the exit code, or the signal, once the child ends. */
export function exitOf(child: ChildProcess): Promise<number | string | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  if (child.signalCode !== null) return Promise.resolve(child.signalCode)
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve(code ?? signal)))
}

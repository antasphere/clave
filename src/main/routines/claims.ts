/**
 * The occurrence claims (ADR 0004): one file per occurrence of a routine,
 * created exclusively, so two servers reading the same `.clave` file (the
 * installed app's child server and a dev app's in-process server on one Mac,
 * two user data directories) run one occurrence between them. The folder is
 * per user and outside every server's data directory,
 * `~/.clave/routines/claims/<hash of the routine key>/<occurrence>.json`, so
 * it holds across data directories; a manual run claims `manual-<run id>`.
 * Claims older than `KEEP_MS` are pruned at every sweep. A folder that
 * cannot be written is told to the caller: a server that cannot claim does
 * not run routines, and says so.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export const KEEP_MS = 7 * 86_400_000

export interface ClaimsOptions {
  /** `~/.clave/routines/claims` by default. */
  readonly dir?: string
  readonly now?: () => number
  /** Who claims: the server's own id, written into the claim for whoever reads it. */
  readonly holder: string
}

export type ClaimOutcome =
  | { kind: 'claimed'; file: string }
  | { kind: 'taken'; by: string | null }
  | { kind: 'unwritable'; reason: string }

export const defaultClaimsDir = (): string =>
  path.join(os.homedir(), '.clave', 'routines', 'claims')

export function hashKey(routineKey: string): string {
  return createHash('sha256').update(routineKey).digest('hex').slice(0, 24)
}

export class Claims {
  private readonly dir: string
  private readonly now: () => number
  constructor(private readonly options: ClaimsOptions) {
    this.dir = options.dir ?? defaultClaimsDir()
    this.now = options.now ?? ((): number => Date.now())
  }

  /** The folder a routine's claims live in. */
  folderOf(routineKey: string): string {
    return path.join(this.dir, hashKey(routineKey))
  }

  /** Claim one occurrence (an epoch ms, or `manual-<id>`) for this holder. */
  claim(routineKey: string, occurrence: number | string): ClaimOutcome {
    const folder = this.folderOf(routineKey)
    const file = path.join(folder, `${occurrence}.json`)
    try {
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
      const fd = fs.openSync(file, 'wx', 0o600)
      try {
        fs.writeSync(
          fd,
          JSON.stringify({
            routineKey,
            occurrence,
            holder: this.options.holder,
            at: this.now()
          })
        )
      } finally {
        fs.closeSync(fd)
      }
      return { kind: 'claimed', file }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        let by: string | null = null
        try {
          by = (JSON.parse(fs.readFileSync(file, 'utf8')) as { holder?: string }).holder ?? null
        } catch {
          /* a claim half written by another server: taken all the same */
        }
        return { kind: 'taken', by }
      }
      return { kind: 'unwritable', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Whether the folder can be written at all: tried once at start, so a
   *  server that cannot claim says so before its first tick. */
  probe(): { ok: true } | { ok: false; reason: string } {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const probe = path.join(this.dir, `.probe-${process.pid}-${this.now()}`)
      fs.writeFileSync(probe, '', { mode: 0o600 })
      fs.rmSync(probe, { force: true })
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Drop the claims older than `KEEP_MS`, and the folders left empty. */
  prune(): number {
    let dropped = 0
    const cutoff = this.now() - KEEP_MS
    let folders: string[]
    try {
      folders = fs.readdirSync(this.dir)
    } catch {
      return 0
    }
    for (const name of folders) {
      const folder = path.join(this.dir, name)
      let files: string[]
      try {
        files = fs.readdirSync(folder)
      } catch {
        continue
      }
      for (const file of files) {
        const full = path.join(folder, file)
        try {
          const at = (JSON.parse(fs.readFileSync(full, 'utf8')) as { at?: number }).at
          if (typeof at !== 'number' || at < cutoff) {
            fs.rmSync(full, { force: true })
            dropped++
          }
        } catch {
          // Unreadable: a claim nobody can read is dropped once old by mtime.
          try {
            if (fs.statSync(full).mtimeMs < cutoff) {
              fs.rmSync(full, { force: true })
              dropped++
            }
          } catch {
            /* gone meanwhile */
          }
        }
      }
      try {
        if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder)
      } catch {
        /* not empty, or gone */
      }
    }
    return dropped
  }
}

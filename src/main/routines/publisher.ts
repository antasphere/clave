/**
 * A routine's deck on Slideless (PRDCT-4149): the server that runs a routine
 * whose report says `publish: true` pushes every run's deck folder as a new
 * version of ONE deck per routine, through the Slideless CLI on the login
 * shell's path (the same way the viewer runs `slideless dev`), signed in as
 * the server's own user. The first push creates the deck and the service
 * keeps its id; the first push also mints ONE named share link for the
 * routine (follow-latest, forms, downloads and uploads off), whose URL is a
 * bearer: it lives in the server's own `routines.json` and is shown to the
 * person in the panel, never written on a record. A push that fails never
 * fails the run: the reason lands on the run as `publishError`.
 *
 * Pure over an injectable `exec`, so the arguments, the parsing and every
 * failure have tests of their own without a CLI on the machine.
 */
import { execFile } from 'node:child_process'
import type { RoutinePublishState } from './store'

export const CLI = 'slideless'
export const INSTALL_HINT = 'team tools install slideless'
export const PUSH_TIMEOUT_MS = 120_000
/** The share link's owner-facing label: the person sees it in Slideless, never the recipient. */
export const SHARE_NAME_PREFIX = 'Clave routine'

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
  /** `ENOENT` when the binary is not on the path. */
  errorCode?: string
}
export type ExecLike = (
  file: string,
  args: string[],
  options: { env: Record<string, string>; cwd: string; timeoutMs: number }
) => Promise<ExecResult>

export interface PublisherOptions {
  /** The environment the CLI runs in: the login shell's, where the CLI and its profile are. */
  env: () => Promise<Record<string, string>>
  exec?: ExecLike
  cli?: string
  timeoutMs?: number
  log?: (level: 'info' | 'warn', message: string) => void
}

export interface PublishInput {
  /** The run's deck folder on disk, as `writeDeck` left it. */
  folder: string
  /** The deck's title on Slideless: the routine's name. */
  title: string
  /** What the routine already has on Slideless, null before its first push. */
  state: RoutinePublishState | null
  /** The share link's owner-facing label. */
  shareName: string
}

export interface PublishOutcome {
  deckId: string
  version: number
  /** The routine's share link, null when none could be minted (the reason in `shareError`). */
  url: string | null
  /** What the service keeps for the next push. */
  state: RoutinePublishState
  shareError: string | null
}

/** The CLI did not publish; the message is what the run carries as `publishError`. */
export class PublishFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublishFailure'
  }
}

export interface RoutinePublisher {
  publish(input: PublishInput): Promise<PublishOutcome>
}

/** The push arguments: a new version of the routine's deck, or a new deck the first time. */
export function pushArgs(folder: string, title: string, deckId: string | null): string[] {
  return [
    'push',
    folder,
    '--title',
    title,
    '--no-open',
    '--json',
    ...(deckId ? ['--id', deckId] : ['--new'])
  ]
}

/** The share arguments: one named link that follows the latest version and lets the
 *  recipient submit nothing, download nothing and upload nothing. */
export function shareArgs(deckId: string, name: string): string[] {
  return ['share', deckId, '--name', name, '--no-forms', '--no-download', '--no-uploads', '--json']
}

/** The JSON object in the CLI's output: the whole output, else the first `{` to the end. */
export function parseJsonOutput(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim()
  const candidates = [text, text.slice(text.indexOf('{'))]
  for (const candidate of candidates) {
    if (!candidate.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>
    } catch {
      /* the next candidate */
    }
  }
  return null
}

/** The deck id and the version out of `slideless push --json`. */
export function parsePush(stdout: string): { deckId: string; version: number } | null {
  const raw = parseJsonOutput(stdout)
  if (!raw) return null
  const presentation = raw.presentation as { id?: unknown } | undefined
  const version = raw.version as { version?: unknown } | undefined
  const deckId = presentation?.id
  const n = version?.version
  if (typeof deckId !== 'string' || !deckId) return null
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return null
  return { deckId, version: n }
}

/** The link's URL and token id out of `slideless share --json`. */
export function parseShare(stdout: string): { tokenId: string; url: string } | null {
  const raw = parseJsonOutput(stdout)
  if (!raw) return null
  const url = raw.url
  const token = raw.shareToken as { id?: unknown } | undefined
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return null
  if (typeof token?.id !== 'string' || !token.id) return null
  return { tokenId: token.id, url }
}

/** Whether a refused push says the kept deck is gone (the instance's
 *  `not_found`, a 404, "no such deck"), the one refusal a new deck answers;
 *  a network error, a signed-out key or any other refusal is not that, and a
 *  new deck would orphan the link the person keeps (round 2, Minor 2). */
export const isGone = (result: ExecResult): boolean =>
  result.errorCode !== 'ENOENT' &&
  result.code !== null &&
  // The CLI's refusal is on stderr; stdout may carry the deck's own id.
  /\b(not_found|not found|404|no such|does not exist|deleted)\b/i.test(result.stderr)

const firstLine = (text: string): string =>
  (text.split('\n').find((l) => l.trim() !== '') ?? '').trim().slice(0, 300)

/** `child_process.execFile`, answering the exit code and both streams, never throwing. */
export const execFileLike: ExecLike = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        env: options.env,
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: string | number; killed?: boolean }) | null
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : err.killed ? null : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          ...(err && typeof err.code === 'string' ? { errorCode: err.code } : {})
        })
      }
    )
  })

export class SlidelessPublisher implements RoutinePublisher {
  private readonly exec: ExecLike
  private readonly cli: string
  private readonly timeoutMs: number
  private readonly log: (level: 'info' | 'warn', message: string) => void
  constructor(private readonly options: PublisherOptions) {
    this.exec = options.exec ?? execFileLike
    this.cli = options.cli ?? CLI
    this.timeoutMs = options.timeoutMs ?? PUSH_TIMEOUT_MS
    this.log = options.log ?? ((): void => {})
  }

  private async run(args: string[], cwd: string): Promise<ExecResult> {
    const env = await this.options.env()
    return this.exec(this.cli, args, { env, cwd, timeoutMs: this.timeoutMs })
  }

  /** Why a CLI call failed, in the words the run carries. */
  private failure(what: string, result: ExecResult): PublishFailure {
    if (result.errorCode === 'ENOENT')
      return new PublishFailure(
        `the Slideless CLI is not on this server's path (${INSTALL_HINT}), so the deck was not ${what}`
      )
    if (result.code === null)
      return new PublishFailure(
        `the Slideless CLI did not answer in time, so the deck was not ${what}`
      )
    const line = firstLine(result.stderr) || firstLine(result.stdout) || `exit code ${result.code}`
    return new PublishFailure(`the deck was not ${what}: ${line}`)
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    let pushed = await this.run(
      pushArgs(input.folder, input.title, input.state?.deckId ?? null),
      input.folder
    )
    // A kept deck the instance no longer has (deleted on Slideless): the push
    // under its id is refused, and the routine would fail on every run after
    // (round 1, Note 2). One new deck is made instead, and the state follows
    // it; a CLI missing or silent is not that case and stays a failure.
    if (pushed.code !== 0 && input.state?.deckId && isGone(pushed)) {
      this.log(
        'warn',
        `publish: the push to the kept deck was refused (${firstLine(pushed.stderr) || `exit code ${pushed.code}`}); making a new deck`
      )
      pushed = await this.run(pushArgs(input.folder, input.title, null), input.folder)
    }
    if (pushed.code !== 0) throw this.failure('pushed', pushed)
    const parsed = parsePush(pushed.stdout)
    if (!parsed)
      throw new PublishFailure(
        `the deck was pushed but the CLI's answer named no deck (${firstLine(pushed.stdout) || 'empty'})`
      )
    // A deck pushed under another id than asked (the CLI made a new one) is
    // the deck from now on: the share link, if any, belonged to the old one.
    const sameDeck = input.state?.deckId === parsed.deckId
    let share = sameDeck ? (input.state?.share ?? null) : null
    let shareError: string | null = null
    if (!share) {
      const shared = await this.run(shareArgs(parsed.deckId, input.shareName), input.folder)
      if (shared.code !== 0) shareError = this.failure('shared', shared).message
      else {
        share = parseShare(shared.stdout)
        if (!share)
          shareError = `the link was minted but the CLI's answer named no URL (${firstLine(shared.stdout) || 'empty'})`
      }
      if (shareError) this.log('warn', `publish: ${shareError}`)
    }
    return {
      deckId: parsed.deckId,
      version: parsed.version,
      url: share?.url ?? null,
      state: { deckId: parsed.deckId, share },
      shareError
    }
  }
}

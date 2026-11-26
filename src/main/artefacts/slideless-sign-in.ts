/**
 * A site's e-mail code sign-in with no terminal (PRDCT-4266). The command
 * asks its questions on stderr and reads each answer as one line of its
 * input; the server starts it with that input held open, answers the start
 * once the command asks for the code, and writes the code it is given later
 * on the same input. Three ends to a start: the code is asked
 * (`code_asked`), the command ends first (`done` on exit 0, else `failed`
 * with its first error line), or it asks nothing for a minute (killed,
 * `failed`). A command that asks anything else (an address, when none was
 * given) is killed: the address comes first.
 *
 * The sign-in is the fix a fresh listing gives the site (`hub_login`,
 * `email_code`, `pick_hub`, `pick_login`), run as the listing wrote it after
 * the global options. One sign-in runs per site: a second start lets go of
 * the first. Every command is killed after ten minutes, and when the service
 * stops. The code is written once, never logged, never put in a sentence,
 * and kept nowhere once written.
 */
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { SlidelessAccounts, SlidelessSignIn } from '@clave/contract/artefacts'
import { ArtefactRefusal } from './refusal'
import { notASite, profileAt, SIGN_IN_KINDS } from './slideless-accounts'
import { firstLine } from './slideless-json'
import { normalOrigin } from './slideless-settings'

/** How long a start waits for the command's question. */
export const QUESTION_TIMEOUT_MS = 60_000
/** How long an answer waits for the command's end. */
export const ANSWER_TIMEOUT_MS = 120_000
/** How long a sign-in's command lives, whatever it waits on. */
export const SIGN_IN_LIFE_MS = 10 * 60_000

export const ADDRESS_FIRST = "Give the account's address first."
export const SIGN_IN_OVER = 'This sign-in is over: start it again.'
export const NO_QUESTION = 'Slideless asked for no code in time: start the sign-in again.'
export const NO_END = 'Slideless did not finish the sign-in in time: start it again.'
export const NO_CODE_SIGN_IN = 'This site does not sign in with an e-mail code now.'
export const PICK_A_HUB = 'Choose the hub to sign in through.'

/** The sign-ins that ended, kept for an answer that comes after their end. */
const ENDED_KEPT = 20
/** What a command said on stderr, its tail. */
const SAID_KEPT = 8 * 1024
/** The line that says where the code went, and the address in it. */
const SENT_TO = /^.*sign-in code was sent to (\S+).*$/m

export interface SignInDeps {
  /** A fresh plain listing, or the refusal with the sentence why it cannot be made. */
  readonly listed: () => Promise<SlidelessAccounts>
  /** Clave's own copy started with these arguments, its input open (`startSlideless`). */
  readonly start: (args: readonly string[]) => ChildProcess
  readonly newId?: () => string
}

export interface SlidelessSignIns {
  start(
    origin: string,
    options: { readonly email?: string; readonly hub?: string }
  ): Promise<SlidelessSignIn>
  answer(id: string, code: string): Promise<SlidelessSignIn>
  cancel(id: string): void
  /** Ends every sign-in, its command killed. */
  stop(): void
}

type Stage = 'asking' | 'waiting' | 'answering' | 'ended'

interface Flight {
  readonly id: string
  readonly origin: string
  readonly child: ChildProcess
  email: string | null
  stage: Stage
  /** What the command said on stderr. */
  said: string
  /** What it said once the code was written. */
  saidAfter: string
  exited: boolean
  /** The call that waits: the start until the code is asked, then the answer. */
  waiter: ((signIn: SlidelessSignIn) => void) | null
  /** The answer's own promise, which a second answer joins rather than writing again. */
  answering: Promise<SlidelessSignIn> | null
  /** The question's minute, then the answer's two. */
  timer: ReturnType<typeof setTimeout> | null
  /** The ten minutes a command lives. */
  life: ReturnType<typeof setTimeout> | null
}

/** The question the command asks now: its last line, unended, ending like a prompt. */
const questionOf = (said: string): string | null => {
  const tail = said.slice(said.lastIndexOf('\n') + 1)
  if (!/[:?]\s+$/.test(tail) || /^\s*error\b/i.test(tail)) return null
  return tail.trim()
}

/** Its first error line, or how it ended. */
const failureOf = (said: string, code: number | null): string =>
  firstLine(said) || `Slideless stopped with exit code ${code ?? 'none'}.`

export function createSlidelessSignIns(deps: SignInDeps): SlidelessSignIns {
  const newId = deps.newId ?? randomUUID
  const flights = new Map<string, Flight>()
  const endedIds: string[] = []

  const signInOf = (flight: Flight, phase: string, message: string | null): SlidelessSignIn => ({
    id: flight.id,
    origin: flight.origin,
    phase,
    email: flight.email,
    message
  })

  /** Hands the call that waits its answer. */
  const tell = (flight: Flight, signIn: SlidelessSignIn): void => {
    const waiter = flight.waiter
    flight.waiter = null
    waiter?.(signIn)
  }

  const end = (flight: Flight, phase: string, message: string | null): void => {
    if (flight.stage === 'ended') return
    flight.stage = 'ended'
    if (flight.timer) clearTimeout(flight.timer)
    if (flight.life) clearTimeout(flight.life)
    flight.timer = flight.life = null
    if (!flight.exited) flight.child.kill('SIGKILL')
    tell(flight, signInOf(flight, phase, message))
    endedIds.push(flight.id)
    while (endedIds.length > ENDED_KEPT) flights.delete(endedIds.shift()!)
  }

  const heard = (flight: Flight, text: string): void => {
    flight.said = (flight.said + text).slice(-SAID_KEPT)
    if (flight.stage === 'answering') flight.saidAfter = (flight.saidAfter + text).slice(-SAID_KEPT)
    if (flight.stage !== 'asking') return
    const sent = SENT_TO.exec(flight.said)
    if (sent && flight.email === null) flight.email = sent[1]!.replace(/[.,;:)]+$/, '')
    const question = questionOf(flight.said)
    if (question === null) return
    if (!/(^|\s)Code:$/.test(question)) {
      // An address, asked because none was given: the command waits on what the window does not have.
      end(flight, 'failed', ADDRESS_FIRST)
      return
    }
    flight.stage = 'waiting'
    if (flight.timer) clearTimeout(flight.timer)
    flight.timer = null
    tell(flight, signInOf(flight, 'code_asked', sent ? sent[0].trim() : null))
  }

  const closed = (flight: Flight, code: number | null): void => {
    flight.exited = true
    if (flight.stage === 'asking')
      end(flight, code === 0 ? 'done' : 'failed', code === 0 ? null : failureOf(flight.said, code))
    else if (flight.stage === 'answering')
      end(
        flight,
        code === 0 ? 'done' : 'failed',
        code === 0 ? null : failureOf(flight.saidAfter, code)
      )
    // Gone while the code was awaited: the next answer hears it is over.
    else end(flight, 'failed', SIGN_IN_OVER)
  }

  return {
    start: async (origin, options) => {
      const accounts = await deps.listed()
      const profile = profileAt(accounts, origin)
      if (!profile) throw new ArtefactRefusal(notASite(origin))
      const site = normalOrigin(profile.site.origin)
      const fix = profile.signIn.fix
      if (!fix || !SIGN_IN_KINDS.includes(fix.kind) || fix.argv.length < 2)
        throw new ArtefactRefusal(NO_CODE_SIGN_IN)
      const email = options.email?.trim() || undefined
      // The fix's own command line, as the listing wrote it, after the global options.
      const args = ['--api-url', site, '--json', ...fix.argv.slice(1)]
      if (fix.kind === 'pick_hub') {
        const hub = options.hub?.trim()
        if (!hub) throw new ArtefactRefusal(PICK_A_HUB)
        if (!accounts.logins.some((login) => normalOrigin(login.hub) === normalOrigin(hub)))
          throw new ArtefactRefusal(`${normalOrigin(hub)} is not one of this machine's logins.`)
        if (fix.argv.at(-1) !== '--hub') throw new ArtefactRefusal(NO_CODE_SIGN_IN)
        args.push(normalOrigin(hub))
      } else if (fix.kind === 'pick_login') {
        if (!email) throw new ArtefactRefusal(ADDRESS_FIRST)
        if (fix.argv.at(-1) !== '--email') throw new ArtefactRefusal(NO_CODE_SIGN_IN)
        args.push(email)
      } else if (email) args.push('--email', email)

      const child = deps.start(args)
      // One sign-in per site: the one that ran before lets go.
      for (const other of flights.values())
        if (other.origin === site && other.stage !== 'ended') end(other, 'cancelled', null)
      const flight: Flight = {
        id: newId(),
        origin: site,
        child,
        email: email ?? null,
        stage: 'asking',
        said: '',
        saidAfter: '',
        exited: false,
        waiter: null,
        answering: null,
        timer: null,
        life: null
      }
      flights.set(flight.id, flight)
      const asked = new Promise<SlidelessSignIn>((resolve) => {
        flight.waiter = resolve
      })
      flight.timer = setTimeout(() => end(flight, 'failed', NO_QUESTION), QUESTION_TIMEOUT_MS)
      flight.life = setTimeout(() => end(flight, 'failed', SIGN_IN_OVER), SIGN_IN_LIFE_MS)
      flight.life.unref?.()
      // Its answer on stdout is not needed, only drained.
      child.stdout?.on('data', () => {})
      child.stderr?.on('data', (chunk: Buffer) => heard(flight, chunk.toString('utf8')))
      child.stdin?.on('error', () => {})
      child.once('error', (error) => end(flight, 'failed', error.message))
      child.once('close', (code: number | null) => closed(flight, code))
      return asked
    },
    answer: async (id, code) => {
      const flight = flights.get(id)
      if (!flight) return { id, origin: '', phase: 'failed', email: null, message: SIGN_IN_OVER }
      // A second answer to the same question (a double submit) waits on the first.
      if (flight.stage === 'answering' && flight.answering) return flight.answering
      if (flight.stage !== 'waiting') return signInOf(flight, 'failed', SIGN_IN_OVER)
      flight.stage = 'answering'
      flight.answering = new Promise<SlidelessSignIn>((resolve) => {
        flight.waiter = resolve
      })
      flight.timer = setTimeout(() => end(flight, 'failed', NO_END), ANSWER_TIMEOUT_MS)
      // Written once with its newline, and the input closed. Nothing here holds
      // the code after this line: no closure, no field, no sentence.
      flight.child.stdin?.end(`${code}\n`)
      return flight.answering
    },
    cancel: (id) => {
      const flight = flights.get(id)
      if (flight) end(flight, 'cancelled', null)
    },
    stop: () => {
      for (const flight of flights.values()) end(flight, 'cancelled', null)
    }
  }
}

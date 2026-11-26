import { jevBaseUrl, jevIntegration, JEV_UNREACHABLE } from '../integrations/jev'
import { DECISIONS_NEED_KEY } from '../../shared/decision-preferences'
import { askJev, type AskJevOptions, type JevOutcome, type JevRequest } from './jev-client'
import { decisionConfig, type DecisionDefinition } from './registry'

/**
 * The one runner every decision goes through (README.md beside this file),
 * the mirror of the helpers' (`../helpers/runner.ts`): the switch and the key
 * read first, one queue with a cap on the requests in flight, one more
 * request on the fallback model when the service says the model is gone, one
 * retry after a rate limit, and every request ended on the quit. A request is
 * an HTTP call, not a child process, so an `AbortController` per request is
 * what `cancelAll` ends; the door `shutdown` shuts is the helpers' PRDCT-3375
 * rule: nothing asked during the quit starts a request nothing would end.
 *
 * The switch is read again before each request, and the key opened again
 * before each request but the first of a decision that did not wait its
 * turn (that key was opened a moment before): a decision switched off, or a
 * key removed, while it waited its turn or a retry's pause, sends nothing
 * more, and a request carries the key read just before it.
 */

/** Requests in flight at once, all decisions together; the rest wait in turn. */
export const MAX_RUNNING_DECISIONS = 4
/** The wait before the one retry after a rate limit: the service's own
 *  `retry-after`, else this, never more than `LIMIT_RETRY_CAP_MS`. */
export const LIMIT_RETRY_DEFAULT_MS = 500
export const LIMIT_RETRY_CAP_MS = 1500
/** The pause before the declared model is asked once more after the service
 *  said it does not know it (see `execute`). */
export const MODEL_RETRY_MS = 250

export type DecisionFailureReason =
  | 'no-key'
  | 'disabled'
  | 'nothing'
  | 'refused'
  | 'unreachable'
  | 'limit'
  | 'unreadable'
  | 'failed'
  | 'cancelled'

export type DecisionOutcome<Outcome> =
  | { ok: true; value: Outcome; model: string; ms: number; inputTokens: number | null }
  | { ok: false; reason: DecisionFailureReason; detail: string }

export interface RunDecisionOptions {
  /** The Jev key; this process's sealed one (`jevIntegration.openKey`) by default. */
  openKey?: () => Promise<string | null>
  /** Where TypeSafe is; `jevBaseUrl` by default. */
  baseUrl?: () => string
  /** The request itself; `askJev` by default (a test's stub). */
  ask?: (options: AskJevOptions) => Promise<JevOutcome>
}

interface Job {
  definition: DecisionDefinition<unknown, unknown>
  input: unknown
  request: JevRequest
  /** The key `runDecision` read; its first request carries it only when the
   *  job did not wait its turn. */
  key: string
  /** Where the key is opened again (a waiting job's turn, a retry). */
  openKey: () => Promise<string | null>
  /** It waited behind the cap: at its turn the key is opened again. */
  waited: boolean
  baseUrl: string
  ask: (options: AskJevOptions) => Promise<JevOutcome>
  controller: AbortController
  cancelled: boolean
  resolve: (outcome: DecisionOutcome<unknown>) => void
}

const queue: Job[] = []
const running = new Set<Job>()
let closed = false

function failure(
  reason: DecisionFailureReason,
  detail: string
): { ok: false; reason: DecisionFailureReason; detail: string } {
  return { ok: false, reason, detail }
}

const CANCELLED = (): { ok: false; reason: DecisionFailureReason; detail: string } =>
  failure('cancelled', 'Cancelled')

/** The decision's switch as `decisionConfig` says it now: the refusal, or
 *  null when it may run. */
function refusalOf(
  definition: DecisionDefinition<unknown, unknown>
): { ok: false; reason: DecisionFailureReason; detail: string } | null {
  const config = decisionConfig(definition)
  // A process that runs no decision refuses them all, before the key is read.
  if (config.refused) return failure('disabled', config.refused)
  if (!config.enabled)
    return failure('disabled', `Switched off in Settings › Helpers (${definition.label}).`)
  return null
}

async function readKey(openKey: () => Promise<string | null>): Promise<string | null> {
  try {
    return (await openKey()) || null
  } catch {
    return null
  }
}

/** Ask a decision in its turn. Never rejects: every way it can end is an
 *  outcome, in the order the README gives. */
export async function runDecision<Input, Outcome>(
  definition: DecisionDefinition<Input, Outcome>,
  input: Input,
  options: RunDecisionOptions = {}
): Promise<DecisionOutcome<Outcome>> {
  if (closed) return CANCELLED()
  // The early checks: a refusal costs no queue.
  const refusal = refusalOf(definition as DecisionDefinition<unknown, unknown>)
  if (refusal) return refusal
  const openKey = options.openKey ?? (() => jevIntegration.openKey())
  const key = await readKey(openKey)
  if (!key) return failure('no-key', DECISIONS_NEED_KEY)
  // The key was read across an await: the quit may have come meanwhile.
  if (closed) return CANCELLED()
  let request: JevRequest | null
  try {
    request = definition.build(input)
  } catch (error) {
    return failure('failed', error instanceof Error ? error.message : String(error))
  }
  if (!request) return failure('nothing', 'Nothing to ask.')
  let baseUrl: string
  try {
    baseUrl = (options.baseUrl ?? jevBaseUrl)()
  } catch (error) {
    return failure('failed', error instanceof Error ? error.message : String(error))
  }
  const job: Job = {
    definition: definition as DecisionDefinition<unknown, unknown>,
    input,
    request,
    key,
    openKey,
    waited: false,
    baseUrl,
    ask: options.ask ?? askJev,
    controller: new AbortController(),
    cancelled: false,
    resolve: () => undefined
  }
  return new Promise<DecisionOutcome<Outcome>>((resolve) => {
    job.resolve = resolve as (outcome: DecisionOutcome<unknown>) => void
    queue.push(job)
    pump()
    // Not started at once: it waits behind the cap, and its turn reads the
    // switch and the key again.
    if (queue.includes(job)) job.waited = true
  })
}

function pump(): void {
  while (running.size < MAX_RUNNING_DECISIONS && queue.length > 0) {
    const job = queue.shift()!
    running.add(job)
    void execute(job)
      .catch((error: unknown) =>
        failure('failed', error instanceof Error ? error.message : String(error))
      )
      .then((outcome) => {
        running.delete(job)
        job.resolve(job.cancelled ? CANCELLED() : outcome)
        pump()
      })
  }
}

/** A wait that a cancel ends at once. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

async function execute(job: Job): Promise<DecisionOutcome<unknown>> {
  const { definition } = job
  let model = definition.model
  let triedFallback = false
  let retriedModel = false
  let retried = false
  let outcome: JevOutcome
  // The key `runDecision` opened a moment ago serves the first request of a
  // job that did not wait; every other request opens it again.
  let key: string | null = job.waited ? null : job.key
  for (;;) {
    if (job.cancelled) return CANCELLED()
    // Before each request, the switch and the key as they are now: switched
    // off, or the key removed, while this one waited, it sends nothing.
    const refusal = refusalOf(definition)
    if (refusal) return refusal
    if (key === null) {
      key = await readKey(job.openKey)
      // Read across an await: a cancel or the quit may have come meanwhile.
      if (job.cancelled) return CANCELLED()
      if (!key) return failure('no-key', DECISIONS_NEED_KEY)
    }
    outcome = await job.ask({
      baseUrl: job.baseUrl,
      key,
      model,
      request: job.request,
      timeoutMs: definition.timeoutMs,
      signal: job.controller.signal
    })
    if (job.cancelled) return CANCELLED()
    key = null
    // A version the service retired: once on the fallback, so a decision
    // does not end everywhere until the next release.
    if (
      outcome.kind === 'model-gone' &&
      !triedFallback &&
      definition.fallbackModel &&
      definition.fallbackModel !== model
    ) {
      triedFallback = true
      model = definition.fallbackModel
      continue
    }
    // The service also refuses, now and then, a model it serves: measured on
    // 26 November 2026, 3 of 16 requests on jev-1.14.0 answered « Unknown
    // model », the alias once too, and each was answered on a later try. So
    // once the fallback is refused as well (or there is none), the declared
    // model is asked once more after a pause: three requests at most, and a
    // refused request costs no token.
    if (outcome.kind === 'model-gone' && !retriedModel) {
      retriedModel = true
      model = definition.model
      await pause(MODEL_RETRY_MS, job.controller.signal)
      continue
    }
    if (outcome.kind === 'limit' && !retried) {
      retried = true
      await pause(
        Math.min(outcome.retryAfterMs ?? LIMIT_RETRY_DEFAULT_MS, LIMIT_RETRY_CAP_MS),
        job.controller.signal
      )
      continue
    }
    break
  }
  switch (outcome.kind) {
    case 'ok': {
      let value: unknown = null
      try {
        value = definition.read(outcome.answers, job.input)
      } catch {
        value = null
      }
      if (value === null || value === undefined)
        return failure('unreadable', 'Jev answered something other than what was asked.')
      return {
        ok: true,
        value,
        model: outcome.model,
        ms: outcome.ms,
        inputTokens: outcome.inputTokens
      }
    }
    case 'refused':
      return failure('refused', outcome.sentence)
    case 'limit':
      return failure('limit', 'TypeSafe asked to wait: too many requests, or overloaded.')
    case 'model-gone':
      return failure('failed', `TypeSafe does not serve the model ${model}.`)
    case 'failed':
      return failure(
        'failed',
        `TypeSafe answered ${outcome.status}.${outcome.detail ? ` ${outcome.detail}` : ''}`
      )
    case 'unreachable':
      return failure('unreachable', JEV_UNREACHABLE)
  }
}

/** End every decision: the waiting ones answered `cancelled`, the running
 *  requests aborted and their answers, if one still comes, dropped. The door
 *  stays open: the sessions' shutdown also runs when the last window closes
 *  on macOS, which is not a quit. */
export function cancelAll(): void {
  for (const job of queue.splice(0)) job.resolve(CANCELLED())
  for (const job of running) {
    job.cancelled = true
    job.controller.abort()
  }
}

/** The quit's call: every decision ended as `cancelAll` does, and the door
 *  shut, so nothing asked during the quit sends a request. */
export function shutdown(): void {
  closed = true
  cancelAll()
}

export function isShutDown(): boolean {
  return closed
}

/** The requests in flight right now (test seam). */
export function runningDecisions(): number {
  return running.size
}

/** The decisions waiting their turn, by id (test seam). */
export function queuedDecisions(): string[] {
  return queue.map((job) => job.definition.id)
}

/** Open the door again (test seam: the module is one per process). */
export function resetShutdownForTests(): void {
  closed = false
}

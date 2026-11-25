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
 */

/** Requests in flight at once, all decisions together; the rest wait in turn. */
export const MAX_RUNNING_DECISIONS = 4
/** The wait before the one retry after a rate limit: the service's own
 *  `retry-after`, else this, never more than `LIMIT_RETRY_CAP_MS`. */
export const LIMIT_RETRY_DEFAULT_MS = 500
export const LIMIT_RETRY_CAP_MS = 1500

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
  key: string
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

/** Ask a decision in its turn. Never rejects: every way it can end is an
 *  outcome, in the order the README gives. */
export async function runDecision<Input, Outcome>(
  definition: DecisionDefinition<Input, Outcome>,
  input: Input,
  options: RunDecisionOptions = {}
): Promise<DecisionOutcome<Outcome>> {
  if (closed) return CANCELLED()
  const config = decisionConfig(definition)
  // A process that runs no decision refuses them all, before the key is read.
  if (config.refused) return failure('disabled', config.refused)
  if (!config.enabled)
    return failure('disabled', `Switched off in Settings › Helpers (${definition.label}).`)
  let key: string | null
  try {
    key = await (options.openKey ?? (() => jevIntegration.openKey()))()
  } catch {
    key = null
  }
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
  let retried = false
  let outcome: JevOutcome
  for (;;) {
    if (job.cancelled) return CANCELLED()
    outcome = await job.ask({
      baseUrl: job.baseUrl,
      key: job.key,
      model,
      request: job.request,
      timeoutMs: definition.timeoutMs,
      signal: job.controller.signal
    })
    if (job.cancelled) return CANCELLED()
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

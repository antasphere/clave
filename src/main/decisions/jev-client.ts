import { cleanReason } from '../integrations/elevenlabs'
import { jevDetailText, jevRefusedSentence } from '../integrations/jev'

/**
 * One request to Jev, TypeSafe's decision model (PRDCT-5179): `POST
 * /v1/systemone` with a `state` and typed questions, answered by a
 * probability per answer and never prose. `askJev` never throws: every way a
 * request ends is an outcome the runner (`runner.ts`) turns into one of its
 * own. Pure over `fetch`, no Electron.
 *
 * Only the two question types the decisions ask are typed here, a choice and
 * a noul (yes or no). An answer that is not the documented shape of one of
 * them is dropped, never guessed at: a decision reads only what it asked.
 */

export type JevQuestion =
  | {
      type: 'choice'
      instructions: string | Record<string, unknown>
      /** Each option's name and the sentence that says when it applies. */
      criteria: Record<string, string>
    }
  | { type: 'noul'; instructions: string | Record<string, unknown> }

export interface JevRequest {
  /** What the questions are about: data, never instructions. */
  state: unknown
  questions: Record<string, JevQuestion>
}

export type JevAnswer =
  | {
      type: 'choice'
      choice: string
      confidence: number
      probabilities: Record<string, number>
    }
  | { type: 'noul'; noul: number }

export type JevAnswers = Record<string, JevAnswer>

export type JevOutcome =
  | { kind: 'ok'; answers: JevAnswers; model: string; inputTokens: number | null; ms: number }
  /** 401 or 403: the key is turned away, in TypeSafe's words when it gave some. */
  | { kind: 'refused'; sentence: string }
  /** 429 or 529: back off; `retryAfterMs` from the `retry-after` header. */
  | { kind: 'limit'; retryAfterMs: number | null }
  /** The service says the model asked does not exist (any more). */
  | { kind: 'model-gone' }
  | { kind: 'failed'; status: number; detail: string }
  /** No answer: the network, the deadline or the caller's abort. */
  | { kind: 'unreachable' }

export interface AskJevOptions {
  baseUrl: string
  key: string
  model: string
  request: JevRequest
  timeoutMs: number
  signal?: AbortSignal
}

/** The longest error body read. */
const BODY_MAX = 64 * 1024

const isProbability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/** One answer read as far as it is the documented shape of a choice or a
 *  noul; null otherwise. Pure. */
export function readJevAnswer(raw: unknown): JevAnswer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.type === 'noul') return isProbability(r.noul) ? { type: 'noul', noul: r.noul } : null
  if (r.type !== 'choice') return null
  if (typeof r.choice !== 'string' || !isProbability(r.confidence)) return null
  const p = r.probabilities
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null
  const probabilities: Record<string, number> = {}
  for (const [name, value] of Object.entries(p as Record<string, unknown>)) {
    if (!isProbability(value)) return null
    probabilities[name] = value
  }
  return { type: 'choice', choice: r.choice, confidence: r.confidence, probabilities }
}

/** Every answer of a body that is its documented shape; the rest dropped. */
export function readJevAnswers(raw: unknown): JevAnswers {
  const answers: JevAnswers = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return answers
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const answer = readJevAnswer(value)
    if (answer) answers[id] = answer
  }
  return answers
}

/** The `retry-after` header in milliseconds: seconds, or an HTTP date. Null
 *  when absent or unreadable. Pure. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (header === null) return null
  const text = header.trim()
  if (!text) return null
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000)
  const at = Date.parse(text)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

/**
 * Whether an error says the MODEL asked does not exist. TypeSafe's
 * documentation (`errors.md`, `openapi.json`, read on 25 November 2026) does
 * not say how it answers an unknown model, so the rule is the brief's: a 400,
 * 404 or 422 whose detail names `model`. Read narrowly, so that the
 * documented 400 `max_tokens_exceeded` ("longer than the model's context
 * length") is never taken for it: a validation entry whose location ends at
 * `model`, or a sentence naming the model field with a word of absence.
 * Pure.
 */
export function namesModelGone(status: number, body: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422) return false
  let detail: unknown = null
  try {
    detail = (JSON.parse(body) as { detail?: unknown } | null)?.detail ?? null
  } catch {
    return false
  }
  if (Array.isArray(detail)) {
    return detail.some((item) => {
      const loc = (item as { loc?: unknown } | null)?.loc
      return Array.isArray(loc) && loc[loc.length - 1] === 'model'
    })
  }
  const text = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : ''
  if (!/\bmodel\b/i.test(text) || /max_tokens_exceeded|context length/i.test(text)) return false
  return (
    status === 404 ||
    /not (?:be )?found|does not exist|doesn't exist|unknown|no such|not available|unavailable|invalid|unsupported|retired|deprecated/i.test(
      text
    )
  )
}

/** Ask Jev once. Never throws. */
export async function askJev(options: AskJevOptions): Promise<JevOutcome> {
  const { key, model, request, timeoutMs, signal } = options
  const base = options.baseUrl.replace(/\/+$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = (): void => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  const started = Date.now()
  try {
    const res = await fetch(`${base}/v1/systemone`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({ model, state: request.state, questions: request.questions }),
      signal: controller.signal
    })
    if (res.ok) {
      const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null
      const ms = Date.now() - started
      const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      const usage = body.usage as { input_tokens?: unknown } | undefined
      const inputTokens =
        usage && typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)
          ? usage.input_tokens
          : null
      return {
        kind: 'ok',
        answers: readJevAnswers(body.answers),
        model: typeof body.model === 'string' && body.model ? body.model : model,
        inputTokens,
        ms
      }
    }
    const text = (await res.text().catch(() => '')).slice(0, BODY_MAX)
    if (res.status === 401 || res.status === 403)
      return { kind: 'refused', sentence: jevRefusedSentence(text, key) }
    if (res.status === 429 || res.status === 529)
      return { kind: 'limit', retryAfterMs: retryAfterMs(res.headers.get('retry-after')) }
    if (namesModelGone(res.status, text)) return { kind: 'model-gone' }
    const said = jevDetailText(text)
    return { kind: 'failed', status: res.status, detail: said ? cleanReason(said, key) : '' }
  } catch {
    return { kind: 'unreachable' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

import type { LimitReport, LimitScope } from '../../shared/limit-report'

/**
 * A provider's own frame read for the cap it hit (ADR 0002, PRDCT-4302):
 * what turns a chat stream frame into a proposal or a switch, and which
 * rung the policy offers first. Pure, for the tests; every other frame is
 * nothing.
 *
 * Claude's `rate_limit_event` with a rejected status carries `rateLimitType`
 * (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`,
 * `seven_day_overage_included`), `resetsAt` and `unifiedWindows`; the enum
 * has no Fable value, so a Fable cap types itself as a plain week and the
 * renderer resolves a shared scope against the forced read. The synthetic
 * reply the CLI writes in the model's place ("You're out of usage credits…")
 * is the org's or the seat's credits, the account as a whole, unless it names
 * a family ("Fable limit reached"); the CLI in `-p` mode ends its process
 * right after that reply, and the reply is the only word some limits get.
 * Codex's `account/rateLimits/updated` at the cap or with a reached type
 * names its bucket the way the usage read does (`codex-usage.ts`): a bucket
 * with a `limitName` (Spark) or an id other than `codex` is that model's
 * family, the general allowance is shared (integration round 1, F7).
 */

/** The text of a synthetic reply that says the account, not the model,
 *  cannot take the turn: out of credits, the cap of the org or the seat, the
 *  usage limit of the plan. Read on a `<synthetic>` reply only. */
const CLAUDE_LIMIT_NOTICE =
  /out of usage credits|out of usage\b|usage credit cap|usage limit|hit your limit|limit reached/i

/** "Fable limit reached", "Opus limit reached": the family the text names. */
const CLAUDE_FAMILY_NOTICE = /\b(fable|opus|sonnet|haiku)\b\s+(?:weekly\s+)?limit\s+reached/i

/** The service's own window types, and whether each is shared or a family's. */
const SHARED_TYPES = new Set(['five_hour', 'seven_day', 'seven_day_overage_included'])
const FAMILY_TYPE = /^seven_day_(oi|[a-z]+)$/

/** The family a window type or code names: `seven_day_opus` → `Opus`, the
 *  service's `oi` code → `Fable` (the usage manager's own mapping). */
function familyOfType(type: string): string | null {
  const m = FAMILY_TYPE.exec(type)
  if (!m) return null
  if (m[1] === 'oi') return 'Fable'
  return m[1].charAt(0).toUpperCase() + m[1].slice(1)
}

function scopeOfType(type: unknown): LimitScope | null {
  if (typeof type !== 'string' || !type) return null
  if (SHARED_TYPES.has(type)) return 'shared'
  const family = familyOfType(type)
  return family ? { family } : null
}

/** A reset the service gives in seconds since the epoch is carried in
 *  milliseconds, the unit every read uses. */
function resetMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value < 1e12 ? value * 1000 : value
}

function claudeRateLimitReport(info: Record<string, unknown>): LimitReport {
  const resetsAt = resetMs(info.resetsAt)
  const typed = scopeOfType(info.rateLimitType)
  if (typed) return resetsAt !== undefined ? { scope: typed, resetsAt } : { scope: typed }
  // No type: the window the service shows spent names the scope.
  const windows = info.unifiedWindows
  if (windows && typeof windows === 'object') {
    for (const [key, value] of Object.entries(windows as Record<string, unknown>)) {
      const w = value as Record<string, unknown> | undefined
      if (!w || typeof w.utilization !== 'number' || w.utilization < 1) continue
      const scope = scopeOfType(key)
      if (!scope) continue
      const back = resetMs(w.resetsAt) ?? resetsAt
      return back !== undefined ? { scope, resetsAt: back } : { scope }
    }
  }
  return resetsAt !== undefined ? { scope: 'unknown', resetsAt } : { scope: 'unknown' }
}

function claudeSyntheticReport(message: Record<string, unknown>): LimitReport | null {
  if (message.model !== '<synthetic>' || !Array.isArray(message.content)) return null
  const texts = message.content
    .filter(
      (block): block is Record<string, unknown> =>
        !!block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text'
    )
    .map((block) => String(block.text ?? ''))
  const text = texts.find((t) => CLAUDE_LIMIT_NOTICE.test(t))
  if (text === undefined) return null
  const family = CLAUDE_FAMILY_NOTICE.exec(text)?.[1]
  if (family) return { scope: { family: family.charAt(0).toUpperCase() + family.slice(1) } }
  return { scope: 'credits' }
}

/** The report a provider's frame carries, or null when the frame says
 *  nothing of a limit. */
export function limitReportOf(provider: string, payload: unknown): LimitReport | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (provider === 'claude') {
    if (p.type === 'assistant') {
      const message = p.message as Record<string, unknown> | undefined
      return message ? claudeSyntheticReport(message) : null
    }
    if (p.type !== 'rate_limit_event') return null
    const info = p.rate_limit_info as Record<string, unknown> | undefined
    if (info?.status !== 'rejected') return null
    return claudeRateLimitReport(info)
  }
  if (provider === 'codex') {
    if (p.method !== 'account/rateLimits/updated') return null
    const params = p.params as Record<string, unknown> | undefined
    if (!params) return null
    // The multi-bucket shape owns the list; the legacy single bucket is the
    // fallback, as the usage read takes them.
    const multi = params.rateLimitsByLimitId as Record<string, unknown> | undefined
    const legacy = params.rateLimits as Record<string, unknown> | undefined
    const buckets: [string, Record<string, unknown>][] =
      multi && typeof multi === 'object' && Object.keys(multi).length > 0
        ? Object.entries(multi).filter(
            (e): e is [string, Record<string, unknown>] => !!e[1] && typeof e[1] === 'object'
          )
        : legacy && typeof legacy === 'object'
          ? [[typeof legacy.limitId === 'string' ? legacy.limitId : 'codex', legacy]]
          : []
    for (const [id, bucket] of buckets) {
      const report = codexBucketReport(id, bucket)
      if (report) return report
    }
  }
  return null
}

/** A Codex bucket at its cap: the service's own reached type, or a window
 *  with about five percent left (the pool's EXHAUSTED_LEFT_PERCENT), named
 *  by its `limitName` or its id, the general `codex` allowance shared. */
function codexBucketReport(id: string, bucket: Record<string, unknown>): LimitReport | null {
  const name = typeof bucket.limitName === 'string' ? bucket.limitName.trim() : ''
  const family = name ? name : id !== 'codex' ? id : null
  const scope: LimitScope = family ? { family } : 'shared'
  let reached = !!bucket.rateLimitReachedType
  let resetsAt: number | undefined
  for (const slot of ['primary', 'secondary']) {
    const w = bucket[slot] as Record<string, unknown> | undefined
    if (w && typeof w.usedPercent === 'number' && w.usedPercent >= 95) {
      reached = true
      resetsAt ??= resetMs(w.resetsAt)
    }
  }
  if (!reached) return null
  return resetsAt !== undefined ? { scope, resetsAt } : { scope }
}

/** Whether a provider's own frame says the account is out: the yes the
 *  policy read before the report carried its scope. */
export function providerEventReportsLimit(provider: string, payload: unknown): boolean {
  return limitReportOf(provider, payload) !== null
}

/** Whether a provider's own frame says the account serves the session again,
 *  which closes a limit report still open on it (PRDCT-4415). Claude: a reply
 *  the model wrote, any frame of type `assistant` that is not the CLI's
 *  `<synthetic>` stand-in (the refusal itself is one). Codex: a rate-limits
 *  update with buckets and none of them at its cap, the same frame that
 *  reported the cap now saying it is gone (the app-server's `turn/completed`
 *  never reaches the provider stream). A turn refused again reports again. */
export function limitLiftedBy(provider: string, payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  if (provider === 'claude') {
    if (p.type !== 'assistant') return false
    // A subagent's reply runs on its own model: a family cap the session's
    // model hit may still stand (PRDCT-4422).
    if (p.parent_tool_use_id != null) return false
    const message = p.message as Record<string, unknown> | undefined
    return !!message && typeof message === 'object' && message.model !== '<synthetic>'
  }
  if (provider === 'codex') {
    if (p.method !== 'account/rateLimits/updated') return false
    const params = p.params as Record<string, unknown> | undefined
    if (!params) return false
    const multi = params.rateLimitsByLimitId as Record<string, unknown> | undefined
    const legacy = params.rateLimits as Record<string, unknown> | undefined
    const hasBuckets =
      (multi && typeof multi === 'object' && Object.keys(multi).length > 0) ||
      (legacy && typeof legacy === 'object')
    return !!hasBuckets && limitReportOf(provider, payload) === null
  }
  return false
}

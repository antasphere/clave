/**
 * What a Pi or an OpenCode tab used, counted per connection (PRDCT-4551):
 * each stored connection's own requests, tokens and cost, and the harness's
 * own sign-in's for a tab on no connection. The host that runs the tabs (this
 * Mac's main, or a Clave server) reads the harnesses' own records and answers
 * this shape on both roads, IPC and the server's `ReadHarnessUsage`.
 *
 * ZERO imports, on its own subpath (`@clave/contract/settings/harness-usage-view`):
 * the window loads this module at value level, and a module that reaches
 * `@structure-ai/cqrs` or Effect breaks the renderer's build. The Effect
 * schemas are built from these constants in `harness-usage.ts`.
 */

/** The harnesses whose usage Clave counts from their own records. */
export const USAGE_HARNESSES = ['pi', 'opencode'] as const
export type UsageHarness = (typeof USAGE_HARNESSES)[number]

/** The ranges a usage read covers. */
export const HARNESS_USAGE_RANGES = ['today', '7d', '30d', 'all'] as const
export type HarnessUsageRange = (typeof HARNESS_USAGE_RANGES)[number]

/**
 * How what a row counted is paid for, which decides what its line says:
 * a coding plan (`plan`) or a local model (`local`) bills nothing per token,
 * so its line says requests and tokens and never a cost; a connection that
 * pays per use (`payPerUse`) says tokens and the cost the harness computed;
 * the harness's own sign-in (`signIn`) says the same, as its own figure.
 */
export const HARNESS_USAGE_BILLINGS = ['plan', 'local', 'payPerUse', 'signIn'] as const
export type HarnessUsageBilling = (typeof HARNESS_USAGE_BILLINGS)[number]

export interface HarnessUsageFigures {
  /** One per usage record the harness wrote (a model call). */
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  /** What the harness itself computed, in USD; 0 where it computed none. */
  cost: number
  /** The harness's sessions that wrote at least one counted record. */
  sessions: number
}

export interface HarnessUsageRow extends HarnessUsageFigures {
  harness: UsageHarness
  /** The stored connection, or null for the harness's own sign-in. */
  connectionId: string | null
  /** The connection's label (the one the ledger recorded, once removed), or
   *  the sign-in's name ("Pi sign-in"). */
  label: string
  billing: HarnessUsageBilling
  /** A connection removed since: its past usage, shown in Settings → Usage
   *  alone. */
  removed: boolean
}

export interface HarnessUsageView {
  range: HarnessUsageRange
  /** Per harness: every current connection that serves it (zeros included),
   *  its own sign-in, then each removed connection with usage in the range. */
  rows: readonly HarnessUsageRow[]
  /** A harness whose records could not be read, with why, in the person's
   *  words. */
  unavailable: readonly { harness: UsageHarness; reason: string }[]
  /** A harness whose records are still being read (OpenCode's first read is
   *  a process per session): its rows hold what was read before, and the
   *  window asks again. */
  reading?: readonly UsageHarness[]
}

export const EMPTY_FIGURES: Readonly<HarnessUsageFigures> = Object.freeze({
  requests: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
  sessions: 0
})

/** The figures of several rows added up (a connection's Pi and OpenCode). */
export function sumFigures(rows: readonly HarnessUsageFigures[]): HarnessUsageFigures {
  const out = { ...EMPTY_FIGURES }
  for (const row of rows) {
    out.requests += row.requests
    out.input += row.input
    out.output += row.output
    out.cacheRead += row.cacheRead
    out.cacheWrite += row.cacheWrite
    out.totalTokens += row.totalTokens
    out.cost += row.cost
    out.sessions += row.sessions
  }
  return out
}

/** A current connection's figures over both harnesses, with its billing;
 *  undefined when the view lists no current row of it (a removed
 *  connection is Settings → Usage's alone). */
export function connectionUsageOf(
  view: Pick<HarnessUsageView, 'rows'> | null | undefined,
  connectionId: string
): { figures: HarnessUsageFigures; billing: HarnessUsageBilling } | undefined {
  const rows = (view?.rows ?? []).filter((row) => row.connectionId === connectionId && !row.removed)
  if (rows.length === 0) return undefined
  return { figures: sumFigures(rows), billing: rows[0].billing }
}

/** A harness's own sign-in row; undefined when the view lists none. */
export function signInUsageOf(
  view: Pick<HarnessUsageView, 'rows'> | null | undefined,
  harness: UsageHarness
): HarnessUsageRow | undefined {
  return (view?.rows ?? []).find((row) => row.harness === harness && row.connectionId === null)
}

/** "today", "in the last 7 days", … : the range as the end of a line. */
export function rangeWords(range: HarnessUsageRange): string {
  switch (range) {
    case 'today':
      return 'today'
    case '7d':
      return 'in the last 7 days'
    case '30d':
      return 'in the last 30 days'
    case 'all':
      return 'in all'
  }
}

/** A token count as a line says it: 950, 10.4K, 1.2M. */
export function formatTokens(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value
  )
}

/** A cost as a line says it: $0.01, $12.40. */
export function formatCost(value: number): string {
  return `$${value.toFixed(2)}`
}

/**
 * The ONE line of a connection's (or a sign-in's) usage, as every place
 * says it: the launcher's row, the sidebar's foot, Settings → Usage, the
 * Connections card and `clave_launch_options`. A plan or a local model:
 * "12 requests · 10.4K tokens today", never a cost (a plan bills nothing per
 * token, so a dollar figure there would be false). Pay per use and the
 * harness's own sign-in: "10.4K tokens · $0.01 today".
 */
export function harnessUsageText(
  figures: Pick<HarnessUsageFigures, 'requests' | 'totalTokens' | 'cost'>,
  billing: HarnessUsageBilling,
  range: HarnessUsageRange
): string {
  const tokens = `${formatTokens(figures.totalTokens)} tokens`
  if (billing === 'plan' || billing === 'local') {
    const requests = `${figures.requests} ${figures.requests === 1 ? 'request' : 'requests'}`
    return `${requests} · ${tokens} ${rangeWords(range)}`
  }
  return `${tokens} · ${formatCost(figures.cost)} ${rangeWords(range)}`
}

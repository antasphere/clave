import type { PluginSessionState } from './host'
import type { FileCursor } from './reader'
import { cost, type PriceTable } from './prices'

/**
 * The ledger: one row per session Clave has shown the plugin, each with the tally of its
 * root transcript and of every subagent transcript beside it, and the pure views the pages
 * draw from it. Everything here is JSON-serialisable and free of I/O.
 */

export interface Tokens {
  input: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheWriteUnsplit: number
  cacheRead: number
  output: number
}

/** A model's share of a tally: its tokens, and how many distinct messages it answered. */
export interface ModelTokens extends Tokens {
  messages: number
}

/** One local day of a tally. `byModel` and `prompts` let a range clip cost and prompts too. */
export interface DayBucket extends Tokens {
  messages: number
  toolCalls: number
  prompts: number
  byModel: Record<string, Tokens>
}

export interface Tally {
  tokens: Tokens
  byModel: Record<string, ModelTokens>
  days: Record<string, DayBucket>
  messages: number
  toolCalls: number
  prompts: number
  firstAt: string | null
  lastAt: string | null
  promptFirstAt: string | null
  promptLastAt: string | null
  stamps: string[]
  skipped: number
}

export interface SubagentRow {
  id: string
  type: string | null
  description: string | null
  model: string | null
  finished: boolean | null
  tally: Tally
  file: FileCursor
}

export interface StateSpan {
  state: PluginSessionState
  from: string
  to: string | null
}

export interface SessionRow {
  id: string
  provider: string
  providerSessionId: string | null
  cwd: string
  name: string
  model: string | null
  state: PluginSessionState
  group: { id: string; name: string } | null
  workspaceId: string | null
  createdAt: number
  seenAt: string
  root: { tally: Tally; file: FileCursor } | null
  subagents: SubagentRow[]
  stateSpans: StateSpan[]
}

export interface Ledger {
  v: 1
  gapMinutes: number
  sessions: Record<string, SessionRow>
  updatedAt: string
}

export type Range = 'all' | 'today' | '7d' | '30d'
export const RANGES: readonly Range[] = ['today', '7d', '30d', 'all']

export function isRange(value: unknown): value is Range {
  return typeof value === 'string' && (RANGES as readonly string[]).includes(value)
}

// ─── Tokens and tallies ──────────────────────────────────────────────────────

export function emptyTokens(): Tokens {
  return {
    input: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWriteUnsplit: 0,
    cacheRead: 0,
    output: 0
  }
}

/** Adds `add` into `into` (mutating it) and returns `into`. */
export function addTokens<T extends Tokens>(into: T, add: Tokens): T {
  into.input += add.input
  into.cacheWrite5m += add.cacheWrite5m
  into.cacheWrite1h += add.cacheWrite1h
  into.cacheWriteUnsplit += add.cacheWriteUnsplit
  into.cacheRead += add.cacheRead
  into.output += add.output
  return into
}

export function emptyTally(): Tally {
  return {
    tokens: emptyTokens(),
    byModel: {},
    days: {},
    messages: 0,
    toolCalls: 0,
    prompts: 0,
    firstAt: null,
    lastAt: null,
    promptFirstAt: null,
    promptLastAt: null,
    stamps: [],
    skipped: 0
  }
}

export function emptyLedger(gapMinutes = 15, now: Date = new Date()): Ledger {
  return { v: 1, gapMinutes, sessions: {}, updatedAt: now.toISOString() }
}

/** Everything the model was given: fresh input, both cache writes and the cache reads. */
export function tokensRead(t: Tokens): number {
  return t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheWriteUnsplit + t.cacheRead
}

export function tokensWritten(t: Tokens): number {
  return t.output
}

// ─── Time ────────────────────────────────────────────────────────────────────

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** `YYYY-MM-DD` of a date in the machine's local time zone. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The local day of an ISO timestamp, or null when it does not parse. */
export function localDay(iso: string): string | null {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : dayKey(new Date(ms))
}

/** The local days a range covers, today included; null for `all`. */
export function rangeDays(range: Range, now: Date = new Date()): Set<string> | null {
  if (range === 'all') return null
  const count = range === 'today' ? 1 : range === '7d' ? 7 : 30
  const days = new Set<string>()
  for (let i = 0; i < count; i++) {
    days.add(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)))
  }
  return days
}

export interface Block {
  start: string
  end: string
  minutes: number
  messages: number
}

/**
 * Activity blocks: consecutive timestamps less than `gapMinutes` apart belong to one block
 * of work; a longer silence is the agent waiting. `messages` counts the messages a block
 * holds (one timestamp per counted message).
 */
export function blocks(stamps: readonly string[], gapMinutes: number): Block[] {
  const times = [...new Set(stamps)]
    .map((s) => Date.parse(s))
    .filter((ms) => !Number.isNaN(ms))
    .sort((a, b) => a - b)
  const gap = gapMinutes * 60_000
  const out: { start: number; end: number; messages: number }[] = []
  for (const t of times) {
    const last = out[out.length - 1]
    if (last && t - last.end < gap) {
      last.end = t
      last.messages++
    } else {
      out.push({ start: t, end: t, messages: 1 })
    }
  }
  return out.map((b) => ({
    start: new Date(b.start).toISOString(),
    end: new Date(b.end).toISOString(),
    minutes: (b.end - b.start) / 60_000,
    messages: b.messages
  }))
}

export function activeMinutes(list: readonly Block[]): number {
  return list.reduce((sum, b) => sum + b.minutes, 0)
}

export function wallMinutes(firstAt: string | null, lastAt: string | null): number {
  if (!firstAt || !lastAt) return 0
  const a = Date.parse(firstAt)
  const b = Date.parse(lastAt)
  return Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.max(0, (b - a) / 60_000)
}

// ─── Views ───────────────────────────────────────────────────────────────────

export interface Figures {
  usd: number
  unpriced: { model: string; tokens: number }[]
  activeMinutes: number
  wallMinutes: number
  tokensRead: number
  tokensWritten: number
  toolCalls: number
  prompts: number
  messages: number
}

export interface ViewRow {
  id: string
  kind: 'session' | 'subagent'
  name: string
  type: string | null
  description: string | null
  model: string | null
  state: PluginSessionState | null
  figures: Figures
  children: ViewRow[]
}

export interface StateCounts {
  working: number
  idle: number
  blocked: number
  ended: number
}

export interface GroupCard {
  id: string | null
  name: string
  sessions: number
  counts: StateCounts
  figures: Figures
}

export interface ViewHeader {
  provider: string | null
  model: string | null
  folder: string | null
  state: PluginSessionState | null
  sessions: number
}

export interface ViewFooter {
  files: number
  pricesDate: string
  gapMinutes: number
  measuredAt: string
}

export interface ScopeView {
  kind: 'session' | 'group' | 'workspace'
  id: string | null
  name: string
  range: Range
  header: ViewHeader
  figures: Figures
  rows: ViewRow[]
  cards: GroupCard[]
  blocks: Block[]
  footer: ViewFooter
}

export function emptyFigures(): Figures {
  return {
    usd: 0,
    unpriced: [],
    activeMinutes: 0,
    wallMinutes: 0,
    tokensRead: 0,
    tokensWritten: 0,
    toolCalls: 0,
    prompts: 0,
    messages: 0
  }
}

/** The part of a tally a range keeps: tokens, cost and counts by day, blocks by start. */
interface Clipped {
  byModel: Record<string, Tokens>
  tokens: Tokens
  messages: number
  toolCalls: number
  prompts: number
}

function clip(tally: Tally, days: Set<string> | null): Clipped {
  if (!days) {
    return {
      byModel: tally.byModel,
      tokens: tally.tokens,
      messages: tally.messages,
      toolCalls: tally.toolCalls,
      prompts: tally.prompts
    }
  }
  const out: Clipped = { byModel: {}, tokens: emptyTokens(), messages: 0, toolCalls: 0, prompts: 0 }
  for (const [day, bucket] of Object.entries(tally.days)) {
    if (!days.has(day)) continue
    addTokens(out.tokens, bucket)
    out.messages += bucket.messages
    out.toolCalls += bucket.toolCalls
    out.prompts += bucket.prompts ?? 0
    for (const [model, t] of Object.entries(bucket.byModel ?? {})) {
      addTokens((out.byModel[model] ??= emptyTokens()), t)
    }
  }
  return out
}

function clipBlocks(list: Block[], days: Set<string> | null): Block[] {
  if (!days) return list
  return list.filter((b) => {
    const day = localDay(b.start)
    return day !== null && days.has(day)
  })
}

function mergeUnpriced(into: Figures['unpriced'], add: Figures['unpriced']): void {
  for (const u of add) {
    const found = into.find((x) => x.model === u.model)
    if (found) found.tokens += u.tokens
    else into.push({ ...u })
  }
}

function spanOf(list: Block[]): number {
  if (list.length === 0) return 0
  return wallMinutes(list[0]!.start, list[list.length - 1]!.end)
}

/** The figures of tallies that run together (a session and its subagents). */
function figuresOf(
  tallies: Tally[],
  prices: PriceTable,
  days: Set<string> | null,
  gapMinutes: number
): { figures: Figures; blocks: Block[] } {
  const byModel: Record<string, Tokens> = {}
  const tokens = emptyTokens()
  const figures = emptyFigures()
  const stamps: string[] = []
  for (const tally of tallies) {
    const part = clip(tally, days)
    addTokens(tokens, part.tokens)
    for (const [model, t] of Object.entries(part.byModel)) {
      addTokens((byModel[model] ??= emptyTokens()), t)
    }
    figures.messages += part.messages
    figures.toolCalls += part.toolCalls
    figures.prompts += part.prompts
    for (const s of tally.stamps) stamps.push(s)
  }
  const priced = cost(byModel, prices)
  figures.usd = priced.usd
  figures.unpriced = priced.unpriced
  figures.tokensRead = tokensRead(tokens)
  figures.tokensWritten = tokensWritten(tokens)
  const list = clipBlocks(blocks(stamps, gapMinutes), days)
  figures.activeMinutes = activeMinutes(list)
  figures.wallMinutes = spanOf(list)
  return { figures, blocks: list }
}

/** Sums figures of rows that run side by side: active minutes add up, wall is the span. */
function sumFigures(list: Figures[], span: number): Figures {
  const out = emptyFigures()
  for (const f of list) {
    out.usd += f.usd
    mergeUnpriced(out.unpriced, f.unpriced)
    out.activeMinutes += f.activeMinutes
    out.tokensRead += f.tokensRead
    out.tokensWritten += f.tokensWritten
    out.toolCalls += f.toolCalls
    out.prompts += f.prompts
    out.messages += f.messages
  }
  out.wallMinutes = span
  return out
}

/** The model with the most messages in a tally, or null. */
export function topModel(tally: Tally | null | undefined): string | null {
  if (!tally) return null
  let best: string | null = null
  let most = -1
  for (const [model, t] of Object.entries(tally.byModel)) {
    if (t.messages > most) {
      best = model
      most = t.messages
    }
  }
  return best
}

function sessionTallies(row: SessionRow): Tally[] {
  return [...(row.root ? [row.root.tally] : []), ...row.subagents.map((s) => s.tally)]
}

function filesOf(row: SessionRow): number {
  return (row.root && row.root.file.offset > 0 ? 1 : 0) + row.subagents.length
}

function subagentRow(
  sub: SubagentRow,
  prices: PriceTable,
  days: Set<string> | null,
  gap: number
): ViewRow {
  return {
    id: `${sub.id}`,
    kind: 'subagent',
    name: sub.type ?? 'Subagent',
    type: sub.type,
    description: sub.description,
    model: topModel(sub.tally) ?? sub.model,
    state: null,
    figures: figuresOf([sub.tally], prices, days, gap).figures,
    children: []
  }
}

function sessionModel(row: SessionRow): string | null {
  return topModel(row.root?.tally) ?? row.model
}

function sessionViewRow(
  row: SessionRow,
  prices: PriceTable,
  days: Set<string> | null,
  gap: number
): ViewRow {
  return {
    id: row.id,
    kind: 'session',
    name: row.name,
    type: null,
    description: null,
    model: sessionModel(row),
    state: row.state,
    figures: figuresOf(sessionTallies(row), prices, days, gap).figures,
    children: row.subagents.map((s) => subagentRow(s, prices, days, gap))
  }
}

function folderOf(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

function footer(ledger: Ledger, prices: PriceTable, files: number): ViewFooter {
  return {
    files,
    pricesDate: prices.date,
    gapMinutes: ledger.gapMinutes,
    measuredAt: ledger.updatedAt
  }
}

/** One session: its own row (the root transcript) above one row per subagent. */
export function sessionView(ledger: Ledger, id: string, prices: PriceTable): ScopeView | null {
  const row = ledger.sessions[id]
  if (!row) return null
  const gap = ledger.gapMinutes
  const total = figuresOf(sessionTallies(row), prices, null, gap)
  const own: ViewRow = {
    id: row.id,
    kind: 'session',
    name: row.name,
    type: null,
    description: null,
    model: sessionModel(row),
    state: row.state,
    figures: figuresOf(row.root ? [row.root.tally] : [], prices, null, gap).figures,
    children: []
  }
  return {
    kind: 'session',
    id: row.id,
    name: row.name,
    range: 'all',
    header: {
      provider: row.provider,
      model: sessionModel(row),
      folder: folderOf(row.cwd),
      state: row.state,
      sessions: 1
    },
    figures: total.figures,
    rows: [own, ...row.subagents.map((s) => subagentRow(s, prices, null, gap))],
    cards: [],
    blocks: total.blocks,
    footer: footer(ledger, prices, filesOf(row))
  }
}

function newestFirst(a: SessionRow, b: SessionRow): number {
  return b.createdAt - a.createdAt
}

/** Sessions side by side: their rows, the summed figures, the blocks of their union. */
function sideBySide(
  rows: SessionRow[],
  prices: PriceTable,
  days: Set<string> | null,
  gap: number
): { viewRows: ViewRow[]; figures: Figures; blocks: Block[]; files: number } {
  const viewRows = rows.map((r) => sessionViewRow(r, prices, days, gap))
  const union = figuresOf(rows.flatMap(sessionTallies), prices, days, gap)
  const figures = sumFigures(
    viewRows.map((r) => r.figures),
    union.figures.wallMinutes
  )
  return {
    viewRows,
    figures,
    blocks: union.blocks,
    files: rows.reduce((n, r) => n + filesOf(r), 0)
  }
}

/** The name a group's sessions carry: the most recently seen one's. */
function groupName(rows: SessionRow[]): string {
  const latest = [...rows].sort((a, b) => b.seenAt.localeCompare(a.seenAt))[0]
  return latest?.group?.name ?? 'Group'
}

export function groupView(
  ledger: Ledger,
  groupId: string,
  prices: PriceTable,
  range: Range,
  now: Date = new Date()
): ScopeView {
  const members = Object.values(ledger.sessions)
    .filter((s) => s.group?.id === groupId)
    .sort(newestFirst)
  // A group with no session in the ledger still has a page: empty, never a 404.
  const days = rangeDays(range, now)
  const all = sideBySide(members, prices, days, ledger.gapMinutes)
  return {
    kind: 'group',
    id: groupId,
    name: members.length ? groupName(members) : 'Group',
    range,
    header: { provider: null, model: null, folder: null, state: null, sessions: members.length },
    figures: all.figures,
    rows: all.viewRows,
    cards: [],
    blocks: all.blocks,
    footer: footer(ledger, prices, all.files)
  }
}

function countStates(rows: SessionRow[]): StateCounts {
  const counts: StateCounts = { working: 0, idle: 0, blocked: 0, ended: 0 }
  for (const r of rows) {
    if (r.state === 'working') counts.working++
    else if (r.state === 'blocked') counts.blocked++
    else if (r.state === 'ended') counts.ended++
    else counts.idle++
  }
  return counts
}

/** One card per group (and `Ungrouped` when needed) over the sessions of a workspace. */
export function workspaceView(
  ledger: Ledger,
  workspaceId: string | null,
  prices: PriceTable,
  range: Range,
  now: Date = new Date()
): ScopeView {
  // A session with no workspace stamp belongs to every workspace, the sidebar's own rule.
  const members = Object.values(ledger.sessions)
    .filter((s) => workspaceId === null || s.workspaceId === null || s.workspaceId === workspaceId)
    .sort(newestFirst)
  const days = rangeDays(range, now)
  const gap = ledger.gapMinutes
  const byGroup = new Map<string | null, SessionRow[]>()
  for (const s of members) {
    const key = s.group?.id ?? null
    const list = byGroup.get(key) ?? []
    list.push(s)
    byGroup.set(key, list)
  }
  const cards: GroupCard[] = []
  for (const [id, rows] of byGroup) {
    const part = sideBySide(rows, prices, days, gap)
    cards.push({
      id,
      name: id === null ? 'Ungrouped' : groupName(rows),
      sessions: rows.length,
      counts: countStates(rows),
      figures: part.figures
    })
  }
  // Grouped cards first, by cost, the ungrouped one last.
  cards.sort((a, b) =>
    a.id === null
      ? 1
      : b.id === null
        ? -1
        : b.figures.usd - a.figures.usd || a.name.localeCompare(b.name)
  )
  const all = sideBySide(members, prices, days, gap)
  return {
    kind: 'workspace',
    id: workspaceId,
    name: 'Workspace',
    range,
    header: { provider: null, model: null, folder: null, state: null, sessions: members.length },
    figures: all.figures,
    rows: [],
    cards,
    blocks: all.blocks,
    footer: footer(ledger, prices, all.files)
  }
}

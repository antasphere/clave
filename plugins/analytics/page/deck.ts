import type { Figures, GroupCard, Range, ScopeView, ViewRow } from '../src/ledger'
import {
  formatCount,
  formatMillions,
  formatMinutes,
  formatThousands,
  formatTokens,
  formatUsd
} from '../src/format'

/**
 * One renderer for the three pages. It draws the view in the `slideless-data` block, then
 * follows the `analytics-events` stream and patches the page in place on each update:
 * table rows and cards are keyed by id, so an open fold and the row under the pointer
 * survive a redraw.
 */

/** Heroicons 24/outline ChevronRightIcon. */
const CHEVRON_D = 'm8.25 4.5 7.5 7.5-7.5 7.5'
const SVG_NS = 'http://www.w3.org/2000/svg'
const RANGE_LABELS: [Range, string][] = [
  ['today', 'Today'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['all', 'All']
]

const params = new URLSearchParams(location.search)
const openFolds = new Set<string>()
let view: ScopeView | null = null

function applyTheme(): void {
  if (params.has('theme')) return
  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    document.documentElement.dataset['theme'] = 'light'
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function chevron(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  path.setAttribute('d', CHEVRON_D)
  svg.appendChild(path)
  return svg
}

function dot(state: string | null): HTMLSpanElement {
  const node = el('span', `dot state-${state ?? 'idle'}`)
  node.title = state ?? ''
  return node
}

/** The token root of the page's own URL: `/<token>/`. */
function base(): string {
  const first = location.pathname.split('/')[1] ?? ''
  return `/${first}/`
}

function linkWith(path: string, changes: Record<string, string | null>): string {
  const query = new URLSearchParams(params)
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) query.delete(key)
    else query.set(key, value)
  }
  const q = query.toString()
  return `${path}${q ? `?${q}` : ''}`
}

function readData(): ScopeView | null {
  const block = document.getElementById('slideless-data')
  if (!block?.textContent) return null
  try {
    return JSON.parse(block.textContent) as ScopeView
  } catch {
    return null
  }
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

interface Parts {
  title: HTMLHeadingElement
  dot: HTMLSpanElement
  meta: HTMLDivElement
  ranges: HTMLElement
  tiles: Record<string, { value: HTMLDivElement; note: HTMLDivElement }>
  body: HTMLElement
  foot: HTMLElement
}

let parts: Parts | null = null

function skeleton(root: HTMLElement): Parts {
  root.textContent = ''
  const head = el('header', 'deck-head')
  const left = el('div')
  const titleRow = el('div', 'deck-title-row')
  const stateDot = dot(null)
  const title = el('h1', 'deck-title')
  titleRow.append(stateDot, title)
  const meta = el('div', 'deck-meta')
  left.append(titleRow, meta)
  const ranges = el('nav', 'ranges')
  ranges.setAttribute('aria-label', 'Range')
  head.append(left, ranges)

  const kpis = el('section', 'kpis')
  const tiles: Parts['tiles'] = {}
  for (const [key, label] of [
    ['cost', 'Cost'],
    ['active', 'Active time'],
    ['read', 'Tokens read'],
    ['written', 'Tokens written'],
    ['tools', 'Tool calls']
  ] as const) {
    const tile = el('div', key === 'cost' ? 'tile hero' : 'tile')
    const value = el('div', 'tile-value')
    const note = el('div', 'tile-note')
    tile.append(el('div', 'tile-label', label), value, note)
    kpis.append(tile)
    tiles[key] = { value, note }
  }

  const body = el('section', 'deck-body')
  const foot = el('footer', 'deck-foot')
  root.append(head, kpis, body, foot)
  return { title, dot: stateDot, meta, ranges, tiles, body, foot }
}

// ─── Header, tiles, footer ───────────────────────────────────────────────────

function drawHeader(p: Parts, v: ScopeView): void {
  p.title.textContent = v.name
  document.title = v.name
  p.dot.className = `dot state-${v.header.state ?? 'idle'}`
  p.dot.hidden = v.kind !== 'session'
  const meta: string[] = []
  if (v.kind === 'session') {
    for (const item of [v.header.provider, v.header.model, v.header.folder])
      if (item) meta.push(item)
  } else {
    meta.push(
      `${formatCount(v.header.sessions)} ${v.header.sessions === 1 ? 'session' : 'sessions'}`
    )
  }
  p.meta.replaceChildren(...meta.map((m) => el('span', undefined, m)))

  if (v.kind === 'session') {
    p.ranges.replaceChildren()
    return
  }
  p.ranges.replaceChildren(
    ...RANGE_LABELS.map(([range, label]) => {
      const a = el('a', range === v.range ? 'chip selected' : 'chip', label)
      a.href = linkWith(location.pathname, { range })
      if (range === v.range) a.setAttribute('aria-current', 'true')
      return a
    })
  )
}

function drawTiles(p: Parts, f: Figures): void {
  const set = (key: string, value: string, note: string): void => {
    p.tiles[key]!.value.textContent = value
    p.tiles[key]!.note.textContent = note
  }
  const unpriced = f.unpriced.reduce((n, u) => n + u.tokens, 0)
  set(
    'cost',
    formatUsd(f.usd),
    unpriced > 0
      ? `+ ${formatTokens(unpriced)} tokens unpriced`
      : `${formatCount(f.messages)} messages`
  )
  set('active', formatMinutes(f.activeMinutes), `over ${formatMinutes(f.wallMinutes)} wall`)
  set('read', formatTokens(f.tokensRead), 'input and cache')
  set('written', formatTokens(f.tokensWritten), 'output')
  set(
    'tools',
    formatCount(f.toolCalls),
    `${formatCount(f.prompts)} ${f.prompts === 1 ? 'prompt' : 'prompts'}`
  )
}

function drawFooter(p: Parts, v: ScopeView): void {
  const files = v.footer.files
  p.foot.textContent =
    `Measured from ${formatCount(files)} transcript ${files === 1 ? 'file' : 'files'} on this Mac` +
    ` · list prices of ${v.footer.pricesDate}, a value, not an invoice` +
    ` · active time counts messages less than ${v.footer.gapMinutes} minutes apart`
}

// ─── Keyed patching ──────────────────────────────────────────────────────────

interface Keyed<E extends HTMLElement> {
  key: string
  create: () => E
  fill: (node: E) => void
}

function patch<E extends HTMLElement>(parent: HTMLElement, items: Keyed<E>[]): void {
  const existing = new Map<string, E>()
  for (const child of Array.from(parent.children) as E[]) {
    const key = child.dataset['key']
    if (key) existing.set(key, child)
  }
  let previous: Element | null = null
  for (const item of items) {
    let node = existing.get(item.key)
    if (node) existing.delete(item.key)
    else {
      node = item.create()
      node.dataset['key'] = item.key
    }
    item.fill(node)
    const wanted: ChildNode | null = previous ? previous.nextSibling : parent.firstChild
    if (wanted !== node) parent.insertBefore(node, wanted)
    previous = node
  }
  for (const node of existing.values()) node.remove()
}

// ─── Table ───────────────────────────────────────────────────────────────────

const COLUMNS = ['Name', 'Model', 'Tool calls', 'Active', 'Read', 'Written', 'Cost']

function figureCells(f: Figures): HTMLTableCellElement[] {
  return [
    el('td', undefined, formatCount(f.toolCalls)),
    el('td', undefined, formatMinutes(f.activeMinutes)),
    el('td', undefined, formatMillions(f.tokensRead)),
    el('td', undefined, formatThousands(f.tokensWritten)),
    el('td', undefined, formatUsd(f.usd))
  ]
}

function nameCell(row: ViewRow, fold: 'open' | 'closed' | 'none' | 'indent'): HTMLTableCellElement {
  const td = el('td', 'name left')
  const cell = el('div', 'name-cell')
  if (fold === 'open' || fold === 'closed') {
    const button = el('button', fold === 'open' ? 'fold open' : 'fold')
    button.type = 'button'
    button.setAttribute('aria-expanded', String(fold === 'open'))
    button.setAttribute('aria-label', fold === 'open' ? 'Hide subagents' : 'Show subagents')
    button.append(chevron())
    button.addEventListener('click', () => {
      if (openFolds.has(row.id)) openFolds.delete(row.id)
      else openFolds.add(row.id)
      draw()
    })
    cell.append(button)
  } else if (fold === 'none') {
    cell.append(el('span', 'fold-spacer'))
  }
  if (row.kind === 'session') {
    cell.append(dot(row.state), el('span', 'name-text', row.name))
  } else {
    cell.append(el('span', 'name-text', row.type ?? 'Subagent'))
    if (row.description) cell.append(el('span', 'name-detail', row.description))
  }
  td.append(cell)
  td.title = row.kind === 'subagent' && row.description ? row.description : row.name
  return td
}

function rowItem(
  row: ViewRow,
  key: string,
  fold: 'open' | 'closed' | 'none' | 'indent'
): Keyed<HTMLTableRowElement> {
  return {
    key,
    create: () => el('tr'),
    fill: (tr) => {
      tr.className = row.kind === 'subagent' ? 'sub' : ''
      tr.replaceChildren(
        nameCell(row, fold),
        el('td', 'left muted', row.model ?? '—'),
        ...figureCells(row.figures)
      )
    }
  }
}

function drawTable(body: HTMLElement, v: ScopeView): void {
  let frame = body.querySelector<HTMLDivElement>(':scope > .table-frame')
  if (!frame) {
    body.replaceChildren()
    frame = el('div', 'table-frame')
    const table = el('table')
    const head = el('thead')
    const tr = el('tr')
    COLUMNS.forEach((c, i) => tr.append(el('th', i < 2 ? 'left' : undefined, c)))
    head.append(tr)
    table.append(head, el('tbody'), el('tfoot'))
    frame.append(table)
    body.append(frame)
  }
  const tbody = frame.querySelector('tbody')!
  const tfoot = frame.querySelector('tfoot')!
  const items: Keyed<HTMLTableRowElement>[] = []
  const anyFold = v.rows.some((r) => r.children.length > 0)
  for (const row of v.rows) {
    if (row.kind === 'subagent') {
      items.push(rowItem(row, `sub:${row.id}`, 'indent'))
      continue
    }
    const has = row.children.length > 0
    const open = has && openFolds.has(row.id)
    items.push(
      rowItem(
        row,
        `session:${row.id}`,
        has ? (open ? 'open' : 'closed') : anyFold ? 'none' : 'indent'
      )
    )
    if (open)
      for (const child of row.children)
        items.push(rowItem(child, `sub:${row.id}:${child.id}`, 'indent'))
  }
  patch(tbody, items)
  const total = el('tr')
  const label = el('td', 'left', 'Total')
  total.append(label, el('td', 'left muted', ''), ...figureCells(v.figures))
  tfoot.replaceChildren(total)
}

// ─── Cards ───────────────────────────────────────────────────────────────────

function stateChips(card: GroupCard): HTMLElement[] {
  const chips: HTMLElement[] = []
  for (const [state, count] of [
    ['working', card.counts.working],
    ['blocked', card.counts.blocked],
    ['idle', card.counts.idle],
    ['ended', card.counts.ended]
  ] as const) {
    if (count === 0) continue
    const chip = el('span', 'state-chip')
    chip.title = state
    chip.append(dot(state), document.createTextNode(`${formatCount(count)} ${state}`))
    chips.push(chip)
  }
  return chips
}

function drawCards(body: HTMLElement, v: ScopeView): void {
  let grid = body.querySelector<HTMLDivElement>(':scope > .cards')
  if (v.cards.length === 0) {
    body.replaceChildren(el('div', 'empty', 'No sessions in this range yet.'))
    return
  }
  if (!grid) {
    body.replaceChildren()
    grid = el('div', 'cards')
    body.append(grid)
  }
  patch<HTMLElement>(
    grid,
    v.cards.map((card) => ({
      key: `${card.id === null ? 'ungrouped' : `group:${card.id}`}`,
      create: () => (card.id === null ? el('div', 'card') : el('a', 'card')),
      fill: (node) => {
        if (node instanceof HTMLAnchorElement && card.id !== null) {
          node.href = linkWith(`${base()}group/${encodeURIComponent(card.id)}`, { ws: null })
        }
        const states = el('div', 'card-states')
        states.append(...stateChips(card))
        const figures = el('div', 'card-figures')
        figures.append(
          el('span', 'card-cost', formatUsd(card.figures.usd)),
          el('span', 'card-active', formatMinutes(card.figures.activeMinutes))
        )
        node.replaceChildren(el('div', 'card-name', card.name), states, figures)
      }
    }))
  )
}

// ─── Draw ────────────────────────────────────────────────────────────────────

function draw(): void {
  const root = document.getElementById('deck')
  if (!root) return
  if (!view) {
    root.replaceChildren(el('div', 'empty', 'Nothing measured yet.'))
    parts = null
    return
  }
  if (!parts || !root.contains(parts.title)) parts = skeleton(root)
  drawHeader(parts, view)
  drawTiles(parts, view.figures)
  if (view.kind === 'workspace') drawCards(parts.body, view)
  else drawTable(parts.body, view)
  drawFooter(parts, view)
}

function follow(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="analytics-events"]')
  const url = meta?.content
  if (!url || typeof EventSource === 'undefined') return
  const source = new EventSource(url)
  source.addEventListener('data', (event) => {
    try {
      const next = JSON.parse((event as MessageEvent<string>).data) as ScopeView | null
      if (next) {
        view = next
        draw()
      }
    } catch {
      /* a malformed frame: keep the last good page */
    }
  })
}

applyTheme()
view = readData()
draw()
follow()

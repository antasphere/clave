import type {
  Block,
  Figures,
  GroupCard,
  PublishedDeck,
  Range,
  ScopeView,
  ViewRow
} from '../src/ledger'
import { scopeKey } from '../src/scope'
import {
  activeNote,
  formatCount,
  formatMillions,
  formatMinutes,
  formatThousands,
  formatTokens,
  formatUsd
} from '../src/format'
import {
  blockRect,
  blockWords,
  formatClock,
  formatDay,
  laneRows,
  spanOf,
  spanOfAll,
  timeScale,
  waitWords,
  waits,
  type Lane,
  type TimeScale,
  type Wait
} from '../src/timeline'
import { mountLive, type Live } from './live'

/**
 * One renderer for the three pages. It draws the view in the `slideless-data` block, then
 * follows the `analytics-events` stream and patches the page in place on each update:
 * table rows and cards are keyed by id, so an open fold and the row under the pointer
 * survive a redraw. Between the figures and the table sits the drawing of the page: the
 * session's timeline, the group's swimlane, the workspace's animation on the brand field.
 * In `deck` mode (a copy published to Slideless) the page is a still: the hover stays,
 * the chips, the links, the stream and the footer's actions are gone.
 */

/** Heroicons 24/outline: ChevronRightIcon, Cog6ToothIcon, ArrowUpTrayIcon. */
const CHEVRON_D = 'm8.25 4.5 7.5 7.5-7.5 7.5'
const COG_D = [
  'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z',
  'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'
]
const UPLOAD_D =
  'M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5'
const SVG_NS = 'http://www.w3.org/2000/svg'
const RANGE_LABELS: [Range, string][] = [
  ['today', 'Today'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['all', 'All']
]

/** The timeline's geometry, in CSS pixels. */
const TIMELINE = {
  height: 64,
  laneY: 20,
  barH: 10,
  axisY: 46,
  labelY: 60,
  hitTop: 6,
  hitBottom: 44
}
/** The swimlane's: one row per lane, the axis under them. */
const SWIMLANE = { rowH: 28, barH: 10, axisPad: 24 }

const params = new URLSearchParams(location.search)
const mode: 'live' | 'deck' =
  document.querySelector<HTMLMetaElement>('meta[name="analytics-mode"]')?.content === 'deck'
    ? 'deck'
    : 'live'
const still = mode === 'deck'
const openFolds = new Set<string>()
let view: ScopeView | null = null
let live: Live | null = null
let publishing = false
let publishWord: { text: string; error: boolean; url?: string } | null = null

function applyTheme(): void {
  // A deck wears the theme it was published with; a served page takes the URL's, else the system's.
  if (still || params.has('theme')) return
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

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  className?: string
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  if (className) node.setAttribute('class', className)
  return node
}

function icon(paths: string[], className = 'icon'): SVGSVGElement {
  const svg = svgEl(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' },
    className
  )
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    svg.append(svgEl('path', { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d }))
  }
  return svg
}

function chevron(): SVGSVGElement {
  return icon([CHEVRON_D])
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
  figure: HTMLElement
  body: HTMLElement
  footText: HTMLDivElement
  footActions: HTMLDivElement
}

let parts: Parts | null = null

function skeleton(root: HTMLElement): Parts {
  root.textContent = ''
  live?.destroy()
  live = null
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

  const figure = el('section', 'deck-figure')
  const body = el('section', 'deck-body')
  const foot = el('footer', 'deck-foot')
  const footText = el('div', 'foot-text')
  const footActions = el('div', 'foot-actions')
  foot.append(footText, footActions)
  root.append(head, kpis, figure, body, foot)
  return { title, dot: stateDot, meta, ranges, tiles, figure, body, footText, footActions }
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
  if (still) {
    // A deck is a still of one range: the chip names it and leads nowhere.
    const label = RANGE_LABELS.find(([range]) => range === v.range)?.[1] ?? v.range
    const chip = el('span', 'chip selected', label)
    chip.setAttribute('aria-current', 'true')
    p.ranges.replaceChildren(chip)
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

function drawTiles(p: Parts, f: Figures, kind: ScopeView['kind']): void {
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
  set('active', formatMinutes(f.activeMinutes), activeNote(kind, f.wallMinutes))
  set('read', formatTokens(f.tokensRead), 'input and cache')
  set('written', formatTokens(f.tokensWritten), 'output')
  set(
    'tools',
    formatCount(f.toolCalls),
    `${formatCount(f.prompts)} ${f.prompts === 1 ? 'prompt' : 'prompts'}`
  )
}

function footerText(v: ScopeView): string {
  const files = v.footer.files
  return (
    `Measured from ${formatCount(files)} transcript ${files === 1 ? 'file' : 'files'} on this Mac` +
    ` · list prices of ${v.footer.pricesDate}, a value, not an invoice` +
    ` · active time counts messages less than ${v.footer.gapMinutes} minutes apart`
  )
}

function publishedWords(deck: PublishedDeck): string {
  return `Published as version ${deck.version} on ${formatDay(deck.at)} at ${formatClock(deck.at)}`
}

function drawFooter(p: Parts, v: ScopeView): void {
  p.footText.textContent = footerText(v)
  if (still) {
    p.footActions.replaceChildren()
    return
  }
  let bar = p.footActions.querySelector<HTMLDivElement>(':scope > .publish')
  if (!bar) {
    bar = el('div', 'publish')
    const names = el('label', 'publish-names')
    const box = el('input')
    box.type = 'checkbox'
    box.className = 'publish-names-box'
    names.append(box, document.createTextNode('Include session names and folders'))
    const button = el('button', 'foot-btn publish-button')
    button.type = 'button'
    button.append(icon([UPLOAD_D]), el('span', 'publish-label', 'Publish'))
    button.addEventListener('click', () => void publish(box.checked))
    const status = el('span', 'publish-status')
    bar.append(names, button, status)
    const gear = el('a', 'gear')
    gear.href = `${base()}settings`
    gear.setAttribute('aria-label', 'Analytics settings')
    gear.title = 'Analytics settings'
    gear.append(icon(COG_D))
    p.footActions.replaceChildren(bar, gear)
  }
  const button = bar.querySelector<HTMLButtonElement>('.publish-button')!
  const label = bar.querySelector<HTMLSpanElement>('.publish-label')!
  const status = bar.querySelector<HTMLSpanElement>('.publish-status')!
  const deck = v.published
  button.disabled = publishing
  label.textContent = deck ? 'Update' : 'Publish'
  status.classList.toggle('error', !!publishWord?.error)
  if (publishing) {
    status.replaceChildren(document.createTextNode('Publishing…'))
  } else if (publishWord) {
    status.replaceChildren(document.createTextNode(publishWord.text))
    if (publishWord.url) status.append(document.createTextNode(' · '), openLink(publishWord.url))
  } else if (deck) {
    status.replaceChildren(
      document.createTextNode(publishedWords(deck)),
      document.createTextNode(' · '),
      openLink(deck.url)
    )
  } else {
    status.replaceChildren(document.createTextNode('Not published yet'))
  }
}

function openLink(url: string): HTMLAnchorElement {
  const a = el('a', 'publish-link', 'Open on Slideless')
  a.href = url
  a.rel = 'noreferrer'
  return a
}

/** Every token the page's own stylesheets name, with the value painted now: inside Clave
 *  the app's inserted theme wins the cascade, so these are the app's live colours. */
function liveTokens(): Record<string, string> {
  const names = new Set<string>()
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue
      for (const name of Array.from(rule.style)) if (name.startsWith('--')) names.add(name)
    }
  }
  const computed = getComputedStyle(document.documentElement)
  const out: Record<string, string> = {}
  for (const name of names) {
    const value = computed.getPropertyValue(name).trim()
    if (value) out[name] = value
  }
  return out
}

async function publish(names: boolean): Promise<void> {
  if (!view || publishing) return
  publishing = true
  publishWord = null
  draw()
  try {
    const response = await fetch(`${base()}publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: scopeKey(view.kind, view.id),
        range: view.range,
        names,
        theme: document.documentElement.dataset['theme'] ?? 'dark',
        tokens: liveTokens()
      })
    })
    const outcome = (await response.json()) as
      | { ok: true; deck: PublishedDeck }
      | { ok: false; message?: string; error?: string }
    if (outcome.ok) {
      publishWord = { text: publishedWords(outcome.deck), error: false, url: outcome.deck.url }
      // The page knows its deck now; the next frame of the stream says the same.
      if (view) view.published = outcome.deck
    } else {
      publishWord = { text: outcome.message ?? outcome.error ?? 'The publish failed.', error: true }
    }
  } catch (error) {
    publishWord = {
      text: `The publish could not reach the plugin: ${error instanceof Error ? error.message : String(error)}.`,
      error: true
    }
  } finally {
    publishing = false
    draw()
  }
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

/** What a hover over a card tells: the figures its face does not show. */
function cardWords(card: GroupCard): string {
  const f = card.figures
  return [
    `${formatCount(card.sessions)} ${card.sessions === 1 ? 'session' : 'sessions'}`,
    `${formatTokens(f.tokensRead)} read`,
    `${formatTokens(f.tokensWritten)} written`,
    `${formatCount(f.toolCalls)} tool calls`,
    `${formatCount(f.prompts)} ${f.prompts === 1 ? 'prompt' : 'prompts'}`,
    `${formatCount(f.messages)} messages`
  ].join(' · ')
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
      create: () => (card.id === null || still ? el('div', 'card') : el('a', 'card')),
      fill: (node) => {
        if (node instanceof HTMLAnchorElement && card.id !== null) {
          node.href = linkWith(`${base()}group/${encodeURIComponent(card.id)}`, { ws: null })
        }
        node.title = cardWords(card)
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

// ─── The drawings ────────────────────────────────────────────────────────────

/** The one hover card of a figure, placed by the pointer; its text is set by the mark. */
function tipOf(figure: HTMLElement): HTMLDivElement {
  let tip = figure.querySelector<HTMLDivElement>(':scope > .tip')
  if (!tip) {
    tip = el('div', 'tip')
    tip.setAttribute('role', 'tooltip')
    tip.hidden = true
    figure.append(tip)
  }
  return tip
}

function showTip(figure: HTMLElement, lines: string[], clientX: number, clientY: number): void {
  const tip = tipOf(figure)
  tip.replaceChildren(...lines.map((line, i) => el('div', i === 0 ? 'tip-head' : 'tip-line', line)))
  tip.hidden = false
  const box = figure.getBoundingClientRect()
  const width = tip.offsetWidth
  const x = Math.min(Math.max(8, clientX - box.left + 12), Math.max(8, box.width - width - 8))
  const y = Math.max(0, clientY - box.top - tip.offsetHeight - 14)
  tip.style.left = `${x}px`
  tip.style.top = `${y}px`
}

function hideTip(figure: HTMLElement): void {
  tipOf(figure).hidden = true
}

/** A mark's invisible hit area, taller than the mark, carrying its hover words. */
function hit(
  figure: HTMLElement,
  attrs: Record<string, string | number>,
  lines: () => string[],
  lit?: SVGElement
): SVGRectElement {
  const rect = svgEl('rect', { ...attrs, fill: 'transparent' }, 'hit')
  rect.setAttribute('tabindex', '0')
  rect.setAttribute('role', 'img')
  rect.setAttribute('aria-label', lines().join('. '))
  const over = (event: PointerEvent): void => {
    lit?.classList.add('lit')
    showTip(figure, lines(), event.clientX, event.clientY)
  }
  const out = (): void => {
    lit?.classList.remove('lit')
    hideTip(figure)
  }
  rect.addEventListener('pointerenter', over)
  rect.addEventListener('pointermove', over)
  rect.addEventListener('pointerleave', out)
  rect.addEventListener('focus', () => {
    lit?.classList.add('lit')
    const box = rect.getBoundingClientRect()
    showTip(figure, lines(), box.left + box.width / 2, box.top)
  })
  rect.addEventListener('blur', out)
  return rect
}

function axis(svg: SVGSVGElement, scale: TimeScale, y: number, labelY: number): void {
  svg.append(svgEl('line', { x1: 0, x2: scale.width, y1: y, y2: y }, 'axis'))
  for (const tick of scale.ticks) {
    const x = scale.x(tick.t)
    svg.append(svgEl('line', { x1: x, x2: x, y1: y, y2: y + 4 }, 'axis'))
    const label = svgEl(
      'text',
      { x, y: labelY, 'text-anchor': 'middle' },
      tick.day ? 'tick-label day' : 'tick-label'
    )
    label.textContent = tick.label
    svg.append(label)
  }
  // The day the clock starts on, when the ticks are hours: once, at the left.
  const first = scale.ticks[0]
  if (first && !first.day) {
    const day = svgEl('text', { x: 0, y: labelY, 'text-anchor': 'start' }, 'tick-label day')
    day.textContent = formatDay(scale.start)
    if (scale.x(first.t) > 56) svg.append(day)
  }
}

/** One lane of blocks and the waits between them, at `top`, on `scale`. */
function laneMarks(
  figure: HTMLElement,
  svg: SVGSVGElement,
  scale: TimeScale,
  blocks: Block[],
  top: number,
  barH: number,
  hitTop: number,
  hitH: number,
  prefix: string[]
): void {
  const mid = top + barH / 2
  for (const wait of waits(blocks)) {
    const x0 = scale.x(Date.parse(wait.from))
    const x1 = scale.x(Date.parse(wait.to))
    if (x1 - x0 < 1) continue
    const line = svgEl('line', { x1: x0, x2: x1, y1: mid, y2: mid }, 'wait')
    svg.append(line)
    const words = (w: Wait): string[] => [...prefix, ...waitWords(w)]
    svg.append(
      hit(figure, { x: x0, y: hitTop, width: x1 - x0, height: hitH }, () => words(wait), line)
    )
  }
  for (const block of blocks) {
    const { x, w } = blockRect(scale, block)
    const rect = svgEl('rect', { x, y: top, width: w, height: barH, rx: 3 }, 'block')
    svg.append(rect)
    svg.append(
      hit(
        figure,
        { x: x - 2, y: hitTop, width: w + 4, height: hitH },
        () => [...prefix, ...blockWords(block)],
        rect
      )
    )
  }
}

function plotWidth(plot: HTMLElement): number {
  return Math.max(120, Math.floor(plot.getBoundingClientRect().width))
}

/** The session page's timeline: its blocks on the wall clock, the waits between them. */
function drawTimeline(slot: HTMLElement, blocks: Block[]): void {
  let figure = slot.querySelector<HTMLElement>(':scope > figure.timeline')
  if (!figure) {
    slot.replaceChildren()
    figure = el('figure', 'timeline')
    figure.append(el('figcaption', 'figure-title', 'Activity on the wall clock'), el('div', 'plot'))
    slot.append(figure)
    watchWidth(figure)
  }
  const plot = figure.querySelector<HTMLElement>('.plot')!
  const span = spanOf(blocks)
  if (!span) {
    plot.replaceChildren(el('div', 'figure-empty', 'No activity measured yet.'))
    return
  }
  const width = plotWidth(plot)
  const scale = timeScale(span, width)
  const svg = svgEl(
    'svg',
    { viewBox: `0 0 ${width} ${TIMELINE.height}`, width, height: TIMELINE.height },
    'chart'
  )
  svg.setAttribute('role', 'img')
  svg.setAttribute(
    'aria-label',
    `${blocks.length} ${blocks.length === 1 ? 'block' : 'blocks'} of activity`
  )
  axis(svg, scale, TIMELINE.axisY, TIMELINE.labelY)
  laneMarks(
    figure,
    svg,
    scale,
    blocks,
    TIMELINE.laneY,
    TIMELINE.barH,
    TIMELINE.hitTop,
    TIMELINE.hitBottom - TIMELINE.hitTop,
    []
  )
  plot.replaceChildren(svg)
}

/** The group page's swimlane: one lane per session on one wall clock, its state dot by its name. */
function drawSwimlane(slot: HTMLElement, lanes: Lane[]): void {
  let figure = slot.querySelector<HTMLElement>(':scope > figure.swimlane')
  if (!figure) {
    slot.replaceChildren()
    figure = el('figure', 'swimlane')
    const grid = el('div', 'lanes')
    grid.append(el('div', 'lane-labels'), el('div', 'plot'))
    figure.append(el('figcaption', 'figure-title', 'The sessions on one wall clock'), grid)
    slot.append(figure)
    watchWidth(figure)
  }
  const labels = figure.querySelector<HTMLElement>('.lane-labels')!
  const plot = figure.querySelector<HTMLElement>('.plot')!
  const span = spanOfAll(lanes.map((lane) => lane.blocks))
  if (!span || lanes.length === 0) {
    labels.replaceChildren()
    plot.replaceChildren(el('div', 'figure-empty', 'No activity measured in this range yet.'))
    return
  }
  labels.replaceChildren(
    ...lanes.map((lane) => {
      const row = el('div', 'lane-label')
      row.append(dot(lane.state), el('span', 'lane-name', lane.label))
      row.title = lane.label
      return row
    })
  )
  const width = plotWidth(plot)
  const scale = timeScale(span, width)
  const height = lanes.length * SWIMLANE.rowH + SWIMLANE.axisPad
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height }, 'chart')
  svg.setAttribute('role', 'img')
  svg.setAttribute(
    'aria-label',
    `${lanes.length} ${lanes.length === 1 ? 'session' : 'sessions'} on one wall clock`
  )
  lanes.forEach((lane, i) => {
    const top = i * SWIMLANE.rowH + (SWIMLANE.rowH - SWIMLANE.barH) / 2
    if (i > 0) {
      const y = i * SWIMLANE.rowH
      svg.append(svgEl('line', { x1: 0, x2: width, y1: y, y2: y }, 'rule'))
    }
    laneMarks(
      figure,
      svg,
      scale,
      lane.blocks,
      top,
      SWIMLANE.barH,
      i * SWIMLANE.rowH + 2,
      SWIMLANE.rowH - 4,
      [lane.label]
    )
  })
  axis(svg, scale, lanes.length * SWIMLANE.rowH + 2, lanes.length * SWIMLANE.rowH + 18)
  plot.replaceChildren(svg)
}

/** The workspace home's animation, mounted once and fed every frame. */
function drawLive(slot: HTMLElement, v: ScopeView): void {
  let figure = slot.querySelector<HTMLElement>(':scope > figure.live-figure')
  if (!figure) {
    slot.replaceChildren()
    figure = el('figure', 'live-figure')
    figure.append(el('figcaption', 'figure-title', 'What happens now'), el('div', 'live-host'))
    slot.append(figure)
    live?.destroy()
    live = mountLive(figure.querySelector<HTMLElement>('.live-host')!, v, still)
  }
  live?.update(v)
}

/** A figure redraws when its width changes: the scale is in pixels. */
const watched = new WeakSet<HTMLElement>()
function watchWidth(figure: HTMLElement): void {
  if (watched.has(figure) || typeof ResizeObserver === 'undefined') return
  watched.add(figure)
  let last = 0
  const observer = new ResizeObserver(() => {
    const width = Math.floor(figure.getBoundingClientRect().width)
    if (width === last) return
    last = width
    draw()
  })
  observer.observe(figure)
}

function drawFigure(p: Parts, v: ScopeView): void {
  if (v.kind === 'session') drawTimeline(p.figure, v.blocks)
  else if (v.kind === 'group') drawSwimlane(p.figure, laneRows(v.rows))
  else drawLive(p.figure, v)
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
  drawTiles(parts, view.figures, view.kind)
  drawFigure(parts, view)
  if (view.kind === 'workspace') drawCards(parts.body, view)
  else drawTable(parts.body, view)
  drawFooter(parts, view)
}

function follow(): void {
  if (still) return
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

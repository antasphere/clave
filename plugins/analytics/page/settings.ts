import type { SettingsData, SettingsPatch } from '../src/server'
import {
  FIELD_LABELS,
  gapPatch,
  PRICE_INPUTS,
  rowsFromTable,
  tableFromRows,
  type PriceRow
} from '../src/settings-form'

/**
 * The settings page. It draws the `settings-data` block, posts each save to the server and
 * draws again from the data the server answers. The rows of the price table live in memory
 * between saves, so a refused save keeps what the person typed.
 */

/** Heroicons 24/outline ArrowLeftIcon. */
const ARROW_LEFT_D = 'M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18'
/** Heroicons 24/outline XMarkIcon. */
const X_MARK_D = 'M6 18 18 6M6 6l12 12'
const SVG_NS = 'http://www.w3.org/2000/svg'
const COLUMNS: { field: keyof PriceRow; label: string }[] = [
  { field: 'id', label: 'Model id' },
  { field: 'name', label: FIELD_LABELS.name },
  ...PRICE_INPUTS.map((field) => ({ field, label: FIELD_LABELS[field] }))
]

type Status = { kind: 'ok' | 'error'; text: string } | null
type Invalid = { model: number; field: keyof PriceRow } | 'gap' | null

const params = new URLSearchParams(location.search)
let data: SettingsData | null = null
let rows: PriceRow[] = []
let gapValue = ''
let status: Status = null
let invalid: Invalid = null
let busy = false

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

function icon(d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  path.setAttribute('d', d)
  svg.appendChild(path)
  return svg
}

function button(className: string, text: string, action?: string): HTMLButtonElement {
  const node = el('button', className, text)
  node.type = 'button'
  if (action) node.dataset['action'] = action
  node.disabled = busy
  return node
}

/** The token root of the page's own URL: `/<token>/`. */
function base(): string {
  const first = location.pathname.split('/')[1] ?? ''
  return `/${first}/`
}

function readData(): SettingsData | null {
  const block = document.getElementById('settings-data')
  if (!block?.textContent) return null
  try {
    return JSON.parse(block.textContent) as SettingsData
  } catch {
    return null
  }
}

/** Takes the data in force: the rows and the gap are drawn from it again. */
function take(next: SettingsData): void {
  data = next
  rows = rowsFromTable(next.prices)
  gapValue = String(next.gapMinutes)
}

// ─── Saving ──────────────────────────────────────────────────────────────────

function refuse(text: string, at: Invalid): void {
  status = { kind: 'error', text }
  invalid = at
  draw()
  document.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus()
}

async function save(patch: SettingsPatch): Promise<void> {
  busy = true
  status = null
  invalid = null
  draw()
  let next: SettingsData | null = null
  let error: string | null = null
  try {
    const res = await fetch(base() + 'settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    })
    const body = (await res.json().catch(() => null)) as unknown
    if (res.ok && body && typeof body === 'object') next = body as SettingsData
    else {
      const said = body && typeof body === 'object' ? (body as { error?: unknown }).error : null
      error =
        typeof said === 'string' ? said : `The settings could not be saved: status ${res.status}.`
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    error = `The settings could not be saved: ${message}.`
  }
  busy = false
  if (next) {
    take(next)
    status = { kind: 'ok', text: 'Saved' }
  } else {
    status = { kind: 'error', text: error ?? 'The settings could not be saved.' }
  }
  draw()
}

function saveGap(): void {
  if (!data) return
  const result = gapPatch(gapValue, data.gapBounds)
  if ('error' in result) return refuse(result.error, 'gap')
  void save(result.patch)
}

function savePrices(): void {
  const result = tableFromRows(rows, new Date())
  if ('error' in result) return refuse(result.error, { model: result.row, field: result.field })
  void save({ prices: result.table })
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

function drawHeader(): HTMLElement {
  const head = el('header', 'deck-head settings-head')
  const back = button('btn settings-back', '')
  back.setAttribute('aria-label', 'Back to the page')
  back.append(icon(ARROW_LEFT_D), el('span', undefined, 'Back'))
  back.addEventListener('click', () => {
    if (history.length > 1) history.back()
    else location.assign(base() + 'workspace')
  })
  back.disabled = false
  const titles = el('div')
  const titleRow = el('div', 'deck-title-row')
  titleRow.append(el('h1', 'deck-title', 'Analytics settings'))
  const meta = el('div', 'deck-meta')
  meta.append(el('span', undefined, "Kept in the plugin's data folder on this Mac"))
  titles.append(titleRow, meta)
  head.append(back, titles)
  return head
}

function drawActivity(d: SettingsData): HTMLElement {
  const section = el('section', 'settings-section')
  section.append(el('h2', 'settings-section-title', 'Activity'))
  const line = el('div', 'settings-line')
  const label = el('label', 'settings-label', 'Active time counts messages less than')
  label.htmlFor = 'gap'
  const input = el('input', 'settings-input settings-number settings-gap')
  input.id = 'gap'
  input.type = 'number'
  input.min = String(d.gapBounds.min)
  input.max = String(d.gapBounds.max)
  input.step = '1'
  input.value = gapValue
  if (invalid === 'gap') input.setAttribute('aria-invalid', 'true')
  input.addEventListener('input', () => {
    gapValue = input.value
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !busy) saveGap()
  })
  const save = button('btn btn-primary', 'Save', 'save-gap')
  save.addEventListener('click', saveGap)
  line.append(label, input, el('span', 'settings-label', 'minutes apart'), save)
  section.append(
    line,
    el(
      'p',
      'settings-note',
      'The WAT report used 90 minutes over a night of unattended lanes; 15 fits a day of attended work.'
    )
  )
  return section
}

function cellInput(model: number, field: keyof PriceRow): HTMLInputElement {
  const price = field !== 'id' && field !== 'name'
  const input = el('input', price ? 'settings-input settings-number' : 'settings-input')
  input.type = price ? 'number' : 'text'
  if (price) {
    input.min = '0'
    input.step = 'any'
  }
  input.dataset['field'] = field
  input.dataset['model'] = String(model)
  input.value = rows[model]![field]
  input.setAttribute('aria-label', `${field === 'id' ? 'Model id' : FIELD_LABELS[field]}`)
  if (invalid && invalid !== 'gap' && invalid.model === model && invalid.field === field)
    input.setAttribute('aria-invalid', 'true')
  input.addEventListener('input', () => {
    const r = rows[model]
    if (r) r[field] = input.value
  })
  return input
}

function drawPrices(d: SettingsData): HTMLElement {
  const section = el('section', 'settings-section')
  section.append(el('h2', 'settings-section-title', 'Prices'))
  const meta = el('div', 'deck-meta')
  meta.append(
    el(
      'span',
      undefined,
      `${d.override ? 'Your own table' : 'The shipped table'} · ${d.prices.date} · USD per million tokens`
    )
  )
  section.append(meta)

  const frame = el('div', 'table-frame settings-table')
  const table = el('table')
  const head = el('tr')
  for (const c of COLUMNS)
    head.append(el('th', c.field === 'id' || c.field === 'name' ? 'left' : undefined, c.label))
  const removeHead = el('th', 'settings-remove-col')
  removeHead.setAttribute('aria-label', 'Remove')
  head.append(removeHead)
  const thead = el('thead')
  thead.append(head)
  const tbody = el('tbody')
  rows.forEach((r, model) => {
    const tr = el('tr')
    for (const c of COLUMNS) {
      const td = el('td', 'settings-cell')
      td.append(cellInput(model, c.field))
      tr.append(td)
    }
    const td = el('td', 'settings-cell settings-remove-col')
    const remove = button('btn settings-icon-btn', '')
    remove.setAttribute('aria-label', `Remove ${r.id.trim() || 'this model'}`)
    remove.append(icon(X_MARK_D))
    remove.addEventListener('click', () => {
      rows.splice(model, 1)
      status = null
      invalid = null
      draw()
    })
    td.append(remove)
    tr.append(td)
    tbody.append(tr)
  })
  if (rows.length === 0) {
    const tr = el('tr')
    const td = el('td', 'settings-empty', 'No model has a price. Add one to price its tokens.')
    td.colSpan = COLUMNS.length + 1
    tr.append(td)
    tbody.append(tr)
  }
  table.append(thead, tbody)
  frame.append(table)

  const actions = el('div', 'settings-actions')
  const add = button('btn', 'Add a model', 'add-model')
  add.addEventListener('click', () => {
    rows.push({
      id: '',
      name: '',
      input: '',
      output: '',
      cacheRead: '',
      cacheWrite5m: '',
      cacheWrite1h: ''
    })
    status = null
    invalid = null
    draw()
    document
      .querySelector<HTMLInputElement>(`input[data-model="${rows.length - 1}"][data-field="id"]`)
      ?.focus()
  })
  const savePricesButton = button('btn btn-primary', 'Save prices', 'save-prices')
  savePricesButton.addEventListener('click', savePrices)
  actions.append(add, savePricesButton)
  if (d.override) {
    const reset = button('btn', 'Use the shipped table', 'reset-prices')
    reset.addEventListener('click', () => void save({ resetPrices: true }))
    actions.append(reset)
  }
  section.append(frame, actions)
  return section
}

function drawStatus(): HTMLElement {
  const line = el('div', 'settings-status', status?.text ?? '')
  line.setAttribute('role', 'status')
  line.setAttribute('aria-live', 'polite')
  if (status) line.dataset['status'] = status.kind
  return line
}

function draw(): void {
  const root = document.getElementById('settings')
  if (!root) return
  if (!data) {
    root.replaceChildren(el('div', 'empty', 'The settings could not be read.'))
    return
  }
  // A redraw keeps the focus on the same input, so typing is never interrupted by a status.
  const focused = document.activeElement
  const focusKey =
    focused instanceof HTMLElement
      ? focused.id ||
        `${focused.dataset['model'] ?? ''}:${focused.dataset['field'] ?? ''}:${focused.dataset['action'] ?? ''}`
      : null
  const foot = el(
    'footer',
    'deck-foot',
    `A cost is the list-price value of the tokens, not an invoice. Source of the table in force: ${data.prices.source}.`
  )
  root.replaceChildren(drawHeader(), drawActivity(data), drawPrices(data), drawStatus(), foot)
  if (focusKey) {
    for (const node of root.querySelectorAll<HTMLElement>('input, button')) {
      const key =
        node.id ||
        `${node.dataset['model'] ?? ''}:${node.dataset['field'] ?? ''}:${node.dataset['action'] ?? ''}`
      if (key === focusKey && key !== '::') {
        node.focus()
        break
      }
    }
  }
}

applyTheme()
const initial = readData()
if (initial) take(initial)
draw()

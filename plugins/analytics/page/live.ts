import type { LiveSession, ScopeView } from '../src/ledger'
import { mountGround, type Ground } from './field'

/**
 * The workspace home's one animation: what happens now. One lane per group that has a live
 * session, three columns for the three states the host reports (working, idle, needs you),
 * and every session a dot in its group's lane at the column of its state. When the host's
 * session list says a state changed, the dot moves to its new column along one eased path,
 * nothing bouncing; a session that ended fades away. The ground is the brand field.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
const COLUMNS = ['working', 'idle', 'blocked'] as const
type Column = (typeof COLUMNS)[number]
const COLUMN_LABELS: Record<Column, string> = {
  working: 'Working',
  idle: 'Idle',
  blocked: 'Needs you'
}
/** The lane's height is the lane label's, a token of the sheet, measured once drawn. */
const LANE_FALLBACK_H = 42
const DOT_R = 5
const DOT_GAP = 14
const EASE_MS = 700
const FADE_MS = 400

interface Lane {
  id: string | null
  name: string
}

interface Dot {
  id: string
  el: SVGCircleElement
  title: SVGTitleElement
  x: number
  y: number
  fromX: number
  fromY: number
  toX: number
  toY: number
  movedAt: number
  opacity: number
  fromOpacity: number
  toOpacity: number
  fadedAt: number
  gone: boolean
}

export interface Live {
  update(view: ScopeView): void
  destroy(): void
}

function columnOf(state: LiveSession['state']): Column | null {
  if (state === 'working') return 'working'
  if (state === 'blocked') return 'blocked'
  if (state === 'idle' || state === 'done') return 'idle'
  return null
}

function easeOut(t: number): number {
  return 1 - (1 - t) ** 3
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  className?: string
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  if (className) node.setAttribute('class', className)
  return node
}

function div(className: string, text?: string): HTMLDivElement {
  const node = document.createElement('div')
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** The lanes of a view: its cards' order, only those with a session still here. */
function lanesOf(view: ScopeView): Lane[] {
  const alive = new Set(
    view.live.filter((s) => columnOf(s.state) !== null).map((s) => s.groupId ?? '')
  )
  return view.cards
    .filter((card) => alive.has(card.id ?? ''))
    .map((card) => ({ id: card.id, name: card.name }))
}

export function mountLive(host: HTMLElement, first: ScopeView, still: boolean): Live {
  host.replaceChildren()
  host.classList.add('live')
  const canvas = document.createElement('canvas')
  canvas.className = 'live-ground'
  canvas.setAttribute('aria-hidden', 'true')
  const head = div('live-head')
  for (const column of COLUMNS) head.append(div('live-col', COLUMN_LABELS[column]))
  const labels = div('live-labels')
  const plot = svg('svg', 'live-plot')
  plot.setAttribute('role', 'img')
  plot.setAttribute(
    'aria-label',
    'The sessions of this workspace, one dot each, by group and state'
  )
  const empty = div('live-empty', 'Nothing is happening right now.')
  empty.hidden = true
  host.append(canvas, labels, head, plot, empty)

  const reduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const instant = still || reduced
  const ground: Ground = mountGround(host, canvas, `${first.id ?? 'workspace'}`)
  const dots = new Map<string, Dot>()
  let lanes: Lane[] = []
  let frame: number | null = null
  let width = 0
  let LANE_H = LANE_FALLBACK_H

  const measure = (): void => {
    width = Math.max(120, plot.getBoundingClientRect().width)
    LANE_H = labels.firstElementChild?.getBoundingClientRect().height || LANE_FALLBACK_H
  }

  /** Where each live session's dot belongs: its lane's row, its state's column, spread
   *  sideways when several share the cell. */
  const targets = (view: ScopeView): Map<string, { x: number; y: number; title: string }> => {
    const out = new Map<string, { x: number; y: number; title: string }>()
    const laneIndex = new Map(lanes.map((lane, i) => [lane.id ?? '', i]))
    const cells = new Map<string, LiveSession[]>()
    for (const s of view.live) {
      const column = columnOf(s.state)
      const row = laneIndex.get(s.groupId ?? '')
      if (column === null || row === undefined) continue
      const key = `${row}:${column}`
      const list = cells.get(key) ?? []
      list.push(s)
      cells.set(key, list)
    }
    const colW = width / COLUMNS.length
    for (const [key, list] of cells) {
      const [rowText, column] = key.split(':') as [string, Column]
      const row = Number(rowText)
      const gap = Math.min(DOT_GAP, (colW * 0.8) / Math.max(1, list.length))
      list.forEach((s, i) => {
        const x = colW * (COLUMNS.indexOf(column) + 0.5) + (i - (list.length - 1) / 2) * gap
        const y = row * LANE_H + LANE_H / 2
        out.set(s.id, {
          x,
          y,
          title: `${s.name} · ${COLUMN_LABELS[column].toLowerCase()}${
            s.provider === 'terminal' ? ' · a terminal' : ''
          }`
        })
      })
    }
    return out
  }

  const paint = (): void => {
    for (const dot of dots.values()) {
      dot.el.setAttribute('cx', dot.x.toFixed(1))
      dot.el.setAttribute('cy', dot.y.toFixed(1))
      dot.el.setAttribute('opacity', dot.opacity.toFixed(3))
    }
  }

  const step = (now: number): void => {
    frame = null
    let moving = false
    for (const dot of [...dots.values()]) {
      const t = Math.min(1, (now - dot.movedAt) / EASE_MS)
      const f = Math.min(1, (now - dot.fadedAt) / FADE_MS)
      const e = easeOut(t)
      dot.x = dot.fromX + (dot.toX - dot.fromX) * e
      dot.y = dot.fromY + (dot.toY - dot.fromY) * e
      dot.opacity = dot.fromOpacity + (dot.toOpacity - dot.fromOpacity) * f
      if (t < 1 || f < 1) moving = true
      else if (dot.gone) {
        dot.el.remove()
        dots.delete(dot.id)
      }
    }
    paint()
    if (moving) frame = requestAnimationFrame(step)
  }

  const schedule = (): void => {
    if (instant) {
      for (const dot of [...dots.values()]) {
        dot.x = dot.toX
        dot.y = dot.toY
        dot.opacity = dot.toOpacity
        if (dot.gone) {
          dot.el.remove()
          dots.delete(dot.id)
        }
      }
      paint()
      return
    }
    if (frame === null) frame = requestAnimationFrame(step)
  }

  const update = (view: ScopeView): void => {
    lanes = lanesOf(view)
    labels.replaceChildren(
      ...lanes.map((lane) => {
        const label = div('live-lane-label', lane.name)
        label.title = lane.name
        return label
      })
    )
    measure()
    const height = Math.max(LANE_H, lanes.length * LANE_H)
    plot.setAttribute('viewBox', `0 0 ${width} ${height}`)
    plot.setAttribute('width', String(width))
    plot.setAttribute('height', String(height))
    plot.replaceChildren(...[...plot.querySelectorAll('circle')])
    for (let i = 1; i < lanes.length; i++) {
      const rule = svg('line', 'live-rule')
      rule.setAttribute('x1', '0')
      rule.setAttribute('x2', String(width))
      rule.setAttribute('y1', String(i * LANE_H))
      rule.setAttribute('y2', String(i * LANE_H))
      plot.prepend(rule)
    }
    empty.hidden = lanes.length > 0
    head.hidden = lanes.length === 0
    const now = performance.now()
    const wanted = targets(view)
    const states = new Map(view.live.map((s) => [s.id, s.state]))
    const providers = new Map(view.live.map((s) => [s.id, s.provider]))
    for (const [id, target] of wanted) {
      let dot = dots.get(id)
      if (!dot) {
        const el = svg('circle', 'live-dot')
        el.setAttribute('r', String(DOT_R))
        el.dataset['session'] = id
        const title = svg('title')
        el.append(title)
        plot.append(el)
        dot = {
          id,
          el,
          title,
          x: target.x,
          y: target.y,
          fromX: target.x,
          fromY: target.y,
          toX: target.x,
          toY: target.y,
          movedAt: now - EASE_MS,
          opacity: 0,
          fromOpacity: 0,
          toOpacity: 1,
          fadedAt: now,
          gone: false
        }
        dots.set(id, dot)
      } else {
        if (dot.toX !== target.x || dot.toY !== target.y) {
          dot.fromX = dot.x
          dot.fromY = dot.y
          dot.toX = target.x
          dot.toY = target.y
          dot.movedAt = now
        }
        if (dot.gone || dot.toOpacity !== 1) {
          dot.gone = false
          dot.fromOpacity = dot.opacity
          dot.toOpacity = 1
          dot.fadedAt = now
        }
      }
      const state = states.get(id) ?? 'idle'
      const terminal = providers.get(id) === 'terminal' ? ' kind-terminal' : ''
      dot.el.setAttribute('class', `live-dot state-${columnOf(state) ?? 'idle'}${terminal}`)
      dot.el.dataset['state'] = state
      dot.el.dataset['lane'] = String(Math.round((target.y - LANE_H / 2) / LANE_H))
      dot.el.dataset['column'] = columnOf(state) ?? ''
      dot.title.textContent = target.title
    }
    for (const dot of dots.values()) {
      if (wanted.has(dot.id) || dot.gone) continue
      dot.gone = true
      dot.fromOpacity = dot.opacity
      dot.toOpacity = 0
      dot.fadedAt = now
    }
    schedule()
  }

  const observer =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          const before = width
          measure()
          if (before !== width && lastView) update(lastView)
        })
  observer?.observe(plot)
  let lastView: ScopeView | null = null

  return {
    update(view: ScopeView): void {
      lastView = view
      update(view)
    },
    destroy(): void {
      observer?.disconnect()
      ground.destroy()
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      dots.clear()
      host.replaceChildren()
    }
  }
}

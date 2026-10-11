import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline'
import type { DayActivity, DaySession } from '../../../../shared/activity-fold'
import { SettingsCallout, SettingsSection } from '../settings/primitives'
import { StatTile } from '../usage/UsagePanel'
import { useActivity } from './use-activity'
import {
  MINUTES_PER_DAY,
  OTHER_PROJECTS,
  activitySummary,
  busiestDay,
  byProject,
  byProvider,
  fmtClock,
  fmtDayLong,
  fmtDayMonth,
  fmtDayShort,
  fmtLeverage,
  fmtMinutes,
  fmtMonthShort,
  fmtPct,
  fmtSeconds,
  heatmapCells,
  hourProfile,
  laneDetails,
  laneOrder,
  localDayKey,
  minuteOfDay,
  modelLabel,
  mondayOf,
  nextDay,
  plural,
  providerLabel,
  rangeTotals,
  streak,
  weeklyTrend,
  type ActivityRange,
  type HeatCell
} from './activity-shape'

// ── The Activity page (PRDCT-3385) ─────────────────────────────────────────
//
// Read top to bottom in the order the questions get asked: the range in six
// numbers, one day in full (the tape of how many sessions worked minute by
// minute, then a lane per session), the year as a heatmap, the hours of the
// day you work in, the range day by day, and where the time went. Every
// colour is a token; no chart library.

const RANGES: { key: ActivityRange; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'year', label: 'Year' }
]

/** The range switch, in the page's header: the Usage page's provider switch. */
export function ActivityRangeChips({
  range,
  onChange
}: {
  range: ActivityRange
  onChange: (range: ActivityRange) => void
}): ReactElement {
  return (
    <div className="launcher-panel" data-activity-range={range}>
      <div className="launcher-row">
        {RANGES.map(({ key, label }, index) => {
          const active = key === range
          return (
            <div key={key} className="contents">
              {index > 0 && <span className="launcher-sep" />}
              <button
                onClick={() => onChange(key)}
                className="panel-tab flex-1 justify-center"
                data-selected={active ? 'true' : undefined}
                aria-pressed={active}
                data-activity-range-chip={key}
              >
                {label}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Small pieces shared by the charts ─────────────────────────────────────

/** An element's width, kept current. The ref'd element must always render. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

interface TipState {
  /** The pointer, in the host's own coordinates. */
  x: number
  y: number
  /** The first line is the value, the rest what it is about. */
  lines: string[]
}

/** The pointer in a host's own coordinates, as a tip. */
function tipAt(e: ReactPointerEvent<Element>, host: HTMLElement | null, lines: string[]): TipState {
  const rect = host?.getBoundingClientRect()
  return {
    x: rect ? e.clientX - rect.left : 0,
    y: rect ? e.clientY - rect.top : 0,
    lines
  }
}

const TIP_GAP = 12

/** The tip itself, placed beside the pointer and held inside its host: it
 *  opens up and to the right, flips where that would leave the host, and is
 *  clamped to the host's box on both axes, so no edge ever cuts it. */
function TipBox({ tip }: { tip: TipState }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const host = el?.offsetParent
    if (!el || !(host instanceof HTMLElement)) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = tip.x + TIP_GAP
    if (left + w > host.clientWidth) left = tip.x - TIP_GAP - w
    left = Math.max(0, Math.min(host.clientWidth - w, left))
    let top = tip.y - TIP_GAP - h
    if (top < 0) top = tip.y + TIP_GAP
    top = Math.max(0, Math.min(host.clientHeight - h, top))
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  })
  return (
    <motion.div
      ref={ref}
      className="menu-surface activity-tip"
      data-activity-tip
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.14, ease: 'easeOut' }}
    >
      {tip.lines.map((line, i) => (
        <span key={i} className={i === 0 ? 'activity-tip-lead' : 'activity-tip-line'}>
          {line}
        </span>
      ))}
    </motion.div>
  )
}

/** The hover readout: a menu surface over the chart, fading in and out. */
function Tip({ tip }: { tip: TipState | null }): ReactElement {
  return <AnimatePresence>{tip && <TipBox key="tip" tip={tip} />}</AnimatePresence>
}

/** A column with its top corners rounded and its foot square on the baseline. */
function columnPath(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0 || w <= 0) return ''
  const k = Math.min(r, w / 2, h)
  return `M${x},${y + h}V${y + k}Q${x},${y} ${x + k},${y}H${x + w - k}Q${x + w},${y} ${x + w},${y + k}V${y + h}Z`
}

/** A section whose content follows the range: it fades when the range changes. */
function RangeFade({ range, children }: { range: string; children: ReactNode }): ReactElement {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={range}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}

/** The day's drawing comes in with the day: a short fade keyed on it, so a
 *  refresh of the same day never flickers. */
const DAY_FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { duration: 0.14, ease: 'easeOut' }
} as const

function Skeleton(): ReactElement {
  return (
    <div className="settings-card activity-skeleton" aria-label="Reading the record">
      <div className="activity-skeleton-block animate-pulse" />
    </div>
  )
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

// ── a. The range in numbers ───────────────────────────────────────────────

function Headlines({ days }: { days: DayActivity[] }): ReactElement {
  const t = rangeTotals(days)
  const n = days.length
  return (
    <>
      <div className="usage-tiles activity-tiles" data-activity-headlines>
        <StatTile
          label="Coverage"
          value={fmtPct(n > 0 ? t.coverageMin / (n * MINUTES_PER_DAY) : 0)}
          detail={`${fmtMinutes(t.coverageMin)} of ${plural(n, 'day')}`}
          hint="The share of the range's time with at least one session working."
        />
        <StatTile
          label="At once"
          value={plural(t.peak, 'session')}
          detail="most working in one minute"
          hint="The most sessions working in the same minute."
        />
        <StatTile
          label="Agent time"
          value={fmtMinutes(t.agentMin)}
          detail={`across ${plural(t.sessionsWorked, 'session')}`}
          hint="The sum of every session's working time."
        />
        <StatTile
          label="Leverage"
          value={fmtLeverage(t.leverage)}
          detail="agent time per hour with a session working"
          hint="Agent time divided by the time with at least one session working: how many sessions worked at once on average."
        />
        <StatTile
          label="Waited on you"
          value={fmtMinutes(t.blockedMin)}
          detail={`median wait ${fmtSeconds(t.medianBlockedS)}`}
          hint="Time a session sat on a question or a permission."
        />
        <StatTile
          label="Sessions"
          value={String(t.sessionsOpened)}
          detail={`median burst ${fmtSeconds(t.medianBurstS)}`}
          hint="Sessions opened in the range."
        />
      </div>
      <p className="activity-summary" data-activity-summary>
        {activitySummary(days)}
      </p>
    </>
  )
}

// ── b. The day: the tape and the lanes ────────────────────────────────────

const TAPE_H = 96
const LANE_H = 28
const MAX_LANES = 40
const MAX_CHIPS = 8
const TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24]
/** The narrowest a burst is drawn, and a wait, in pixels. */
const MIN_BURST_PX = 3
const MIN_WAIT_PX = 2

/** Contiguous runs of minutes where `keep(m)` holds, as [start, end). */
function runs(keep: (m: number) => boolean, limit = MINUTES_PER_DAY): [number, number][] {
  const out: [number, number][] = []
  let start = -1
  for (let m = 0; m <= limit; m++) {
    const on = m < limit && keep(m)
    if (on && start < 0) start = m
    if (!on && start >= 0) {
      out.push([start, m])
      start = -1
    }
  }
  return out
}

/** A step area between two per-minute series, as one path per run. */
function stepArea(top: number[], bottom: number[], y: (v: number) => number): string {
  let d = ''
  for (const [a, b] of runs((m) => top[m] > bottom[m])) {
    d += `M${a},${y(bottom[a])}V${y(top[a])}`
    for (let m = a + 1; m < b; m++) if (top[m] !== top[m - 1]) d += `H${m}V${y(top[m])}`
    d += `H${b}V${y(bottom[b - 1])}`
    for (let m = b - 1; m > a; m--)
      if (bottom[m - 1] !== bottom[m]) d += `H${m}V${y(bottom[m - 1])}`
    d += `H${a}Z`
  }
  return d
}

/** The top edge of a step series, run by run, down to the baseline at each end. */
function stepLine(top: number[], y: (v: number) => number): string {
  let d = ''
  for (const [a, b] of runs((m) => top[m] > 0)) {
    d += `M${a},${y(0)}V${y(top[a])}`
    for (let m = a + 1; m < b; m++) if (top[m] !== top[m - 1]) d += `H${m}V${y(top[m])}`
    d += `H${b}V${y(0)}`
  }
  return d
}

/** An interval widened to `minW` and kept inside the day, as [x, width]. */
function span([a, b]: [number, number], minW: number): [number, number] {
  const w = Math.max(minW, b - a)
  return [Math.max(0, Math.min(a, MINUTES_PER_DAY - w)), w]
}

/** One session's bursts on the tape: a strip on the baseline as tall as the
 *  one session it adds, and a faint band over the height of the tape. */
function focusPaths(
  s: DaySession,
  unit: number,
  y: (v: number) => number
): { strip: string; band: string } {
  const h = Math.max(MIN_BURST_PX, TAPE_H - y(1))
  let strip = ''
  let band = ''
  for (const iv of s.working) {
    const [x, w] = span(iv, MIN_BURST_PX * unit)
    strip += `M${x},${TAPE_H}V${TAPE_H - h}H${x + w}V${TAPE_H}Z`
    band += `M${x},0V${TAPE_H}H${x + w}V0Z`
  }
  return { strip, band }
}

function workingAt(s: DaySession, m: number): boolean {
  return s.working.some(([a, b]) => a < m + 1 && b > m)
}

function namesLine(names: string[]): string | null {
  if (names.length === 0) return null
  const shown = names.slice(0, 6).join(', ')
  return names.length > 6 ? `${shown} +${names.length - 6}` : shown
}

function sessionName(s: DaySession): string {
  return s.name || providerLabel(s.provider)
}

/** The minute of the day under the pointer. */
function minuteAt(e: ReactPointerEvent<Element> | ReactMouseEvent<Element>): number | null {
  const rect = e.currentTarget.getBoundingClientRect()
  if (rect.width <= 0) return null
  return Math.max(
    0,
    Math.min(
      MINUTES_PER_DAY - 1,
      Math.floor(((e.clientX - rect.left) / rect.width) * MINUTES_PER_DAY)
    )
  )
}

interface LaneLink {
  /** The lane drawn over the tape: the one hovered, else the one selected. */
  focus: DaySession | null
  selectedId: string | null
  onHoverLane: (id: string | null) => void
  onSelectLane: (id: string) => void
}

function Tape({
  day,
  nowMin,
  unit,
  pin,
  onPin,
  link
}: {
  day: DayActivity
  nowMin: number | null
  /** viewBox units per pixel of the plot. */
  unit: number
  pin: number | null
  onPin: (minute: number | null) => void
  link: LaneLink
}): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<TipState | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const empty = new Array<number>(MINUTES_PER_DAY).fill(0)
  const working = day.working.length === MINUTES_PER_DAY ? day.working : empty
  const blocked = day.blocked.length === MINUTES_PER_DAY ? day.blocked : empty
  const open = day.open.length === MINUTES_PER_DAY ? day.open : empty
  const app = day.app.length === MINUTES_PER_DAY ? day.app : empty
  const stacked = working.map((w, m) => w + blocked[m])
  const max = Math.max(1, ...stacked)
  const y = (v: number): number => TAPE_H - (v / max) * (TAPE_H - 4)
  // The app closed, hatched: only on a day the record has the app's own rows
  // for (a backfilled day has none, and is not known to be closed), never
  // under an open session, and never in the part of today still to come.
  const closed =
    day.totals.appMin > 0
      ? runs(
          (m) => app[m] === 0 && open[m] === 0,
          nowMin === null ? MINUTES_PER_DAY : Math.ceil(nowMin)
        )
      : []
  const focus = link.focus ? focusPaths(link.focus, unit, y) : null
  const pinnedNames = pin === null ? [] : laneOrder(day.sessions.filter((s) => workingAt(s, pin)))

  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const m = minuteAt(e)
    if (m === null) return
    setHover(m)
    // A held minute keeps its readout under the tape: no tip over it.
    if (pin !== null) {
      setTip(null)
      return
    }
    const names = day.sessions.filter((s) => workingAt(s, m)).map(sessionName)
    const lines = [`${fmtClock(m)} · ${working[m]} working · ${open[m]} open`]
    const who = namesLine(names)
    if (who) lines.push(who)
    setTip(tipAt(e, hostRef.current, lines))
  }
  const onLeave = (): void => {
    setHover(null)
    setTip(null)
  }
  const onClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const at = minuteAt(e)
    if (at === null) return
    // On today a click past the present holds the present minute, read off
    // the clock at the click (the data's `now` is the last fetch's); a click
    // there never lets go of a held minute, it holds the present again.
    const present = nowMin !== null ? Math.floor(minuteOfDay(Date.now())) : null
    const m = present !== null ? Math.min(at, Math.max(0, present)) : at
    onPin(pin === m && at === m ? null : m)
    setTip(null)
  }

  return (
    <div className="activity-day-row">
      <div className="activity-tape-scale" aria-hidden>
        <span>{max}</span>
        <span>at once</span>
        <span>0</span>
      </div>
      <div className="activity-tape" ref={hostRef}>
        <div
          className="activity-tape-plot"
          onPointerMove={onMove}
          onPointerLeave={onLeave}
          onClick={onClick}
          data-activity-tape
        >
          {closed.map(([a, b]) => (
            <span
              key={a}
              className="activity-tape-closed"
              style={{ left: `${(a / 1440) * 100}%`, width: `${((b - a) / 1440) * 100}%` }}
            />
          ))}
          <svg
            viewBox={`0 0 ${MINUTES_PER_DAY} ${TAPE_H}`}
            preserveAspectRatio="none"
            className="activity-tape-svg"
            role="img"
            aria-label="Sessions working, minute by minute"
          >
            {TICKS.slice(1, -1).map((h) => (
              <line
                key={h}
                x1={h * 60}
                x2={h * 60}
                y1={0}
                y2={TAPE_H}
                className="activity-grid"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <line
              x1={0}
              x2={MINUTES_PER_DAY}
              y1={TAPE_H}
              y2={TAPE_H}
              className="activity-baseline"
              vectorEffect="non-scaling-stroke"
            />
            <motion.g key={day.day} {...DAY_FADE}>
              <path d={stepArea(working, empty, y)} className="activity-tape-working" />
              <path
                d={stepLine(working, y)}
                className="activity-tape-working-edge"
                vectorEffect="non-scaling-stroke"
              />
              <path d={stepArea(stacked, working, y)} className="activity-tape-blocked" />
            </motion.g>
            {focus && (
              <g data-activity-tape-focus={link.focus?.id}>
                <path d={focus.band} className="activity-tape-focus-band" />
                <path d={focus.strip} className="activity-tape-focus" />
              </g>
            )}
          </svg>
          {pin !== null && (
            <span
              className="activity-hairline"
              data-pinned="true"
              style={{ left: `${((pin + 0.5) / 1440) * 100}%` }}
            />
          )}
          {hover !== null && hover !== pin && (
            <span
              className="activity-hairline"
              data-light={pin !== null ? 'true' : undefined}
              style={{ left: `${((hover + 0.5) / 1440) * 100}%` }}
            />
          )}
        </div>
        <div className="activity-tape-axis" aria-hidden>
          {TICKS.map((h) => (
            <span
              key={h}
              data-edge={h === 0 ? 'start' : h === 24 ? 'end' : undefined}
              style={{ left: `${(h / 24) * 100}%` }}
            >
              {String(h).padStart(2, '0')}
            </span>
          ))}
        </div>
        <div className="activity-readout-row">
          {pin !== null ? (
            <div className="activity-readout" data-activity-readout>
              <span className="activity-readout-lead">
                {`${fmtClock(pin)} · ${working[pin]} working · ${open[pin]} open`}
              </span>
              {pinnedNames.slice(0, MAX_CHIPS).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="badge badge-muted activity-readout-chip"
                  data-selected={link.selectedId === s.id ? 'true' : undefined}
                  title={[sessionName(s), basename(s.cwd)].filter(Boolean).join(' · ')}
                  onPointerEnter={() => link.onHoverLane(s.id)}
                  onPointerLeave={() => link.onHoverLane(null)}
                  onClick={() => link.onSelectLane(s.id)}
                >
                  {sessionName(s)}
                </button>
              ))}
              {pinnedNames.length > MAX_CHIPS && (
                <span className="activity-readout-more">+{pinnedNames.length - MAX_CHIPS}</span>
              )}
            </div>
          ) : (
            <p className="activity-readout-hint">
              Click the tape to hold a minute, a lane to follow one session.
            </p>
          )}
        </div>
        <Tip tip={tip} />
      </div>
    </div>
  )
}

function Lane({
  session,
  unit,
  dim,
  selected,
  onHover,
  onLeave,
  onSelect
}: {
  session: DaySession
  /** viewBox units per pixel of the track. */
  unit: number
  dim: boolean
  selected: boolean
  onHover: (e: ReactPointerEvent<HTMLDivElement>, s: DaySession) => void
  onLeave: () => void
  onSelect: (s: DaySession) => void
}): ReactElement {
  const bar = (
    iv: [number, number],
    minPx: number,
    className: string,
    attrs: Record<string, string> = {}
  ): ReactElement => {
    const [x, w] = span(iv, minPx * unit)
    return (
      <rect
        key={`${className}-${iv[0]}`}
        x={x}
        y={7}
        width={w}
        height={LANE_H - 14}
        rx={2 * unit}
        ry={2}
        className={className}
        {...attrs}
      />
    )
  }
  // The project, unless the name already is it (a terminal named for its folder).
  const project = basename(session.cwd)
  const sub = [
    project !== sessionName(session) ? project : null,
    session.model ? modelLabel(session.model, session.provider) : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      className="activity-lane"
      data-activity-lane
      data-session-id={session.id}
      data-tracked={session.tracked ? 'true' : 'false'}
      data-selected={selected ? 'true' : undefined}
      data-dim={dim ? 'true' : undefined}
      onPointerMove={(e) => onHover(e, session)}
      onPointerLeave={onLeave}
      onClick={() => onSelect(session)}
    >
      <div
        className="activity-lane-label"
        title={[sessionName(session), session.cwd, session.model].filter(Boolean).join(' · ')}
      >
        <span className="activity-lane-dot" />
        <span className="activity-lane-text">
          <span className="activity-lane-name">{sessionName(session)}</span>
          {sub && <span className="activity-lane-sub">{sub}</span>}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${MINUTES_PER_DAY} ${LANE_H}`}
        preserveAspectRatio="none"
        className="activity-lane-track"
      >
        {session.opens.map((iv) => {
          const [x, w] = span(iv, MIN_WAIT_PX * unit)
          return (
            <rect
              key={`open-${iv[0]}`}
              x={x}
              y={12}
              width={w}
              height={4}
              rx={2 * unit}
              ry={2}
              className="activity-lane-open"
            />
          )
        })}
        {session.working.map((iv) =>
          bar(iv, MIN_BURST_PX, 'activity-lane-burst', { 'data-activity-burst': '' })
        )}
        {session.blocked.map((iv) => bar(iv, MIN_WAIT_PX, 'activity-lane-wait'))}
        {session.live && (
          <rect
            x={Math.max(0, session.open[1] - MIN_BURST_PX * unit)}
            y={7}
            width={MIN_BURST_PX * unit}
            height={LANE_H - 14}
            className="activity-lane-live"
          />
        )}
      </svg>
    </div>
  )
}

function Lanes({
  day,
  shown,
  width,
  link,
  focusId
}: {
  day: DayActivity
  shown: DaySession[]
  width: number
  link: LaneLink
  focusId: string | null
}): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<TipState | null>(null)
  const unit = width > 0 ? MINUTES_PER_DAY / width : 1
  const selected = shown.find((s) => s.id === link.selectedId) ?? null
  const onHover = (e: ReactPointerEvent<HTMLDivElement>, s: DaySession): void => {
    link.onHoverLane(s.id)
    setTip(
      tipAt(e, hostRef.current, [
        sessionName(s),
        s.tracked
          ? `${fmtMinutes(s.workingMin)} working · ${fmtMinutes(s.blockedMin)} waiting`
          : `open ${fmtMinutes(s.open[1] - s.open[0])}, run state not known`,
        link.selectedId === s.id ? 'Click to let go' : 'Click to follow on the tape'
      ])
    )
  }
  const onLeave = (): void => {
    link.onHoverLane(null)
    setTip(null)
  }
  return (
    <>
      <motion.div className="activity-lanes" ref={hostRef} data-activity-lanes {...DAY_FADE}>
        {shown.map((s) => (
          <Lane
            key={s.id}
            session={s}
            unit={unit}
            dim={focusId !== null && focusId !== s.id}
            selected={link.selectedId === s.id}
            onHover={onHover}
            onLeave={onLeave}
            onSelect={(lane) => link.onSelectLane(lane.id)}
          />
        ))}
        {day.sessions.length > MAX_LANES && (
          <p className="activity-lanes-more">and {day.sessions.length - MAX_LANES} more</p>
        )}
        <Tip tip={tip} />
      </motion.div>
      <AnimatePresence initial={false}>
        {selected && (
          <motion.p
            key={selected.id}
            className="activity-lane-details"
            data-activity-lane-details
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
          >
            {laneDetails(selected).map((part, i) => (
              <span key={i} className={i === 0 ? 'activity-lane-details-lead' : undefined}>
                {part}
              </span>
            ))}
          </motion.p>
        )}
      </AnimatePresence>
    </>
  )
}

/** The page's keys, live while the Activity page is on screen and the focus
 *  is not in a field: ← and → step a day, T comes back to today, Esc lets
 *  go of what is held. The settings view stays mounted when hidden, so the
 *  page's own box being laid out is the test that it is on screen. */
const NOT_OURS =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"], [role="listbox"]'

function useDayKeys(
  rootRef: React.RefObject<HTMLElement | null>,
  handle: (key: 'prev' | 'next' | 'today' | 'escape') => boolean
): void {
  const handleRef = useRef(handle)
  useLayoutEffect(() => {
    handleRef.current = handle
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      const root = rootRef.current
      if (!root || root.offsetParent === null) return
      if (e.target instanceof Element && e.target.closest(NOT_OURS)) return
      const key =
        e.key === 'ArrowLeft'
          ? 'prev'
          : e.key === 'ArrowRight'
            ? 'next'
            : (e.key === 't' || e.key === 'T') && !e.shiftKey
              ? 'today'
              : e.key === 'Escape'
                ? 'escape'
                : null
      if (key && handleRef.current(key)) e.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [rootRef])
}

function DayCard({
  day,
  selectedDay,
  today,
  now,
  onSelect
}: {
  day: DayActivity | null
  selectedDay: string
  today: string
  now: number
  onSelect: (day: string) => void
}): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  const [measureRef, plotWidth] = useWidth<HTMLDivElement>()
  const [pin, setPin] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  // Another day lets go of the minute and the lane held on this one, however
  // the day changed (the arrows, the heatmap, the trend).
  const [heldDay, setHeldDay] = useState(selectedDay)
  if (heldDay !== selectedDay) {
    setHeldDay(selectedDay)
    setPin(null)
    setSelectedId(null)
    setHoverId(null)
  }
  const stale = !day || day.day !== selectedDay
  const isToday = selectedDay === today
  const isYesterday = selectedDay === nextDay(today, -1)
  const nowMin = day && day.day === today ? minuteOfDay(now) : null
  const unit = plotWidth > 0 ? MINUTES_PER_DAY / plotWidth : 1

  const sessions = day?.sessions ?? []
  const chosen =
    sessions.length > MAX_LANES
      ? [...sessions].sort((a, b) => b.workingMin - a.workingMin).slice(0, MAX_LANES)
      : sessions
  const shown = laneOrder(chosen)
  const focusId = hoverId ?? selectedId
  const link: LaneLink = {
    focus: shown.find((s) => s.id === focusId) ?? null,
    selectedId,
    onHoverLane: setHoverId,
    onSelectLane: (id) => setSelectedId((cur) => (cur === id ? null : id))
  }

  useDayKeys(rootRef, (key) => {
    if (key === 'prev') onSelect(nextDay(selectedDay, -1))
    else if (key === 'next') {
      if (selectedDay < today) onSelect(nextDay(selectedDay, 1))
    } else if (key === 'today') {
      if (!isToday) onSelect(today)
    } else {
      if (pin === null && selectedId === null) return false
      setPin(null)
      setSelectedId(null)
    }
    return true
  })

  return (
    <div className="settings-card activity-card" data-activity-day={selectedDay} ref={rootRef}>
      <div className="activity-day-head">
        <button
          className="btn-icon btn-icon-md"
          aria-label="Previous day"
          title="Previous day (←)"
          data-activity-day-prev
          onClick={() => onSelect(nextDay(selectedDay, -1))}
        >
          <ChevronLeftIcon className="w-4 h-4" />
        </button>
        <span className="activity-day-title" data-activity-day-title>
          {isToday ? 'Today' : fmtDayLong(selectedDay)}
        </span>
        {isYesterday && <span className="activity-day-suffix">yesterday</span>}
        <button
          className="btn-icon btn-icon-md"
          aria-label="Next day"
          title="Next day (→)"
          data-activity-day-next
          disabled={selectedDay >= today}
          onClick={() => onSelect(nextDay(selectedDay, 1))}
        >
          <ChevronRightIcon className="w-4 h-4" />
        </button>
        {!isToday && (
          <button
            className="panel-tab"
            title="Back to today (T)"
            data-activity-day-today
            onClick={() => onSelect(today)}
          >
            Today
          </button>
        )}
        {day && !stale && day.sessions.length > 0 && (
          <span className="activity-day-sum">
            {fmtMinutes(day.totals.agentMin)} agent time ·{' '}
            {fmtPct(day.totals.coverageMin / MINUTES_PER_DAY)} covered
          </span>
        )}
      </div>
      <div className="activity-day-body" data-refreshing={stale ? 'true' : undefined}>
        {/* The time column's width, measured once for the tape and the lanes. */}
        <div className="activity-day-row" aria-hidden>
          <span />
          <div ref={measureRef} className="activity-day-measure" />
        </div>
        {!day ? (
          <div className="activity-skeleton-block animate-pulse" />
        ) : day.sessions.length === 0 ? (
          <p className="activity-empty">No session ran that day.</p>
        ) : (
          <>
            <Tape day={day} nowMin={nowMin} unit={unit} pin={pin} onPin={setPin} link={link} />
            <Lanes
              key={day.day}
              day={day}
              shown={shown}
              width={plotWidth}
              link={link}
              focusId={link.focus?.id ?? null}
            />
          </>
        )}
      </div>
    </div>
  )
}

// ── c. The year ───────────────────────────────────────────────────────────

const CELL = 10
const PITCH = 12
const HEAT_LEFT = 28
const HEAT_TOP = 14
const WEEKDAY_LABELS: [number, string][] = [
  [0, 'Mon'],
  [2, 'Wed'],
  [4, 'Fri']
]

function YearCard({
  year,
  now,
  selectedDay,
  onSelect
}: {
  year: DayActivity[]
  now: number
  selectedDay: string
  onSelect: (day: string) => void
}): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<TipState | null>(null)
  const { weeks } = heatmapCells(year, now)
  const width = HEAT_LEFT + weeks.length * PITCH - (PITCH - CELL)
  const height = HEAT_TOP + 7 * PITCH - (PITCH - CELL)
  const months: { x: number; label: string }[] = []
  weeks.forEach((week, w) => {
    const first = week.find((c) => c.day.endsWith('-01'))
    if (!first) return
    const x = HEAT_LEFT + w * PITCH
    if (months.length > 0 && x - months[months.length - 1].x < PITCH * 3) return
    months.push({ x, label: fmtMonthShort(first.day) })
  })
  const today = localDayKey(now)
  const best = busiestDay(year)
  const run = streak(year, today)
  const describe = (c: HeatCell): string[] => [
    `${c.day === today ? 'Today' : fmtDayLong(c.day)} · ${fmtMinutes(c.agentMin)} agent time · ${fmtPct(c.coverageMin / MINUTES_PER_DAY)} coverage`
  ]
  return (
    <div className="settings-card activity-card">
      <div className="activity-year">
        <div className="activity-heatmap" ref={hostRef} onPointerLeave={() => setTip(null)}>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            style={{ maxWidth: width }}
            role="img"
            aria-label="Agent time per day over the last year"
            data-activity-heatmap
          >
            {months.map((m) => (
              <text key={m.x} x={m.x} y={HEAT_TOP - 4} className="activity-axis-text">
                {m.label}
              </text>
            ))}
            {WEEKDAY_LABELS.map(([row, label]) => (
              <text
                key={label}
                x={0}
                y={HEAT_TOP + row * PITCH + CELL - 1}
                className="activity-axis-text"
              >
                {label}
              </text>
            ))}
            {weeks.map((week, w) =>
              week.map((c, d) => (
                <rect
                  key={c.day}
                  x={HEAT_LEFT + w * PITCH}
                  y={HEAT_TOP + d * PITCH}
                  width={CELL}
                  height={CELL}
                  rx={2}
                  className="activity-cell"
                  data-activity-cell={c.day}
                  data-level={c.level}
                  data-in-range={c.inRange ? 'true' : 'false'}
                  data-selected={c.day === selectedDay ? 'true' : undefined}
                  onPointerMove={(e) => c.inRange && setTip(tipAt(e, hostRef.current, describe(c)))}
                  onPointerLeave={() => setTip(null)}
                  onClick={() => c.inRange && onSelect(c.day)}
                />
              ))
            )}
          </svg>
          <Tip tip={tip} />
        </div>
        <p className="activity-captions">
          <span>
            {best
              ? `Busiest day: ${fmtDayLong(best.day)} · ${fmtMinutes(best.agentMin)}`
              : 'Busiest day: none yet'}
          </span>
          <span>Current streak: {plural(run, 'day')}</span>
        </p>
      </div>
    </div>
  )
}

// ── d. When you work ──────────────────────────────────────────────────────

const BARS_H = 96
const BAR_LABEL_H = 18

function HourCard({ days }: { days: DayActivity[] }): ReactElement {
  const [hostRef, width] = useWidth<HTMLDivElement>()
  const [tip, setTip] = useState<TipState | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const { coverageMin, agentMin } = hourProfile(days)
  const max = Math.max(1, ...coverageMin)
  const slot = width / 24
  const barW = Math.min(24, Math.max(1, slot - 2))
  return (
    <div className="settings-card activity-card">
      <div
        className="activity-bars"
        ref={hostRef}
        onPointerLeave={() => {
          setTip(null)
          setHover(null)
        }}
        data-activity-hours
      >
        {width > 0 && (
          <svg
            width={width}
            height={BARS_H + BAR_LABEL_H}
            role="img"
            aria-label="Time with a session working, per hour of the day"
          >
            <line x1={0} x2={width} y1={BARS_H} y2={BARS_H} className="activity-baseline" />
            {coverageMin.map((v, h) => {
              const bh = (v / max) * (BARS_H - 4)
              const x = h * slot + (slot - barW) / 2
              return (
                <g key={h}>
                  <rect
                    x={h * slot}
                    y={0}
                    width={slot}
                    height={BARS_H}
                    className="activity-hit"
                    data-hover={hover === h ? 'true' : undefined}
                    onPointerMove={(e) => {
                      setHover(h)
                      const hh = String(h).padStart(2, '0')
                      setTip(
                        tipAt(e, hostRef.current, [
                          `${fmtMinutes(v)} with a session working`,
                          `${fmtMinutes(agentMin[h])} agent time`,
                          `${hh}:00–${hh}:59`
                        ])
                      )
                    }}
                  />
                  <path d={columnPath(x, BARS_H - bh, barW, bh)} className="activity-bar" />
                  {h % 6 === 0 && (
                    <text x={x} y={BARS_H + BAR_LABEL_H - 4} className="activity-axis-text">
                      {String(h).padStart(2, '0')}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        )}
        <Tip tip={tip} />
      </div>
    </div>
  )
}

// ── e. Day by day, or week by week over the year ──────────────────────────

const DOTS_H = 28

interface TrendBar {
  key: string
  pct: number
  peak: number
  /** The day a click opens. */
  target: string
  selected: boolean
  /** The axis label this bar may carry, before the spacing rule. */
  label: string | null
  tip: string[]
  attrs: Record<string, string>
}

function dayBars(days: DayActivity[], selectedDay: string): TrendBar[] {
  const n = days.length
  return days.map((d, i) => {
    const pct = d.totals.coverageMin / MINUTES_PER_DAY
    // The first of each month, and every seventh day back from the last when
    // the range is short enough for them.
    const weekly = n <= 7 || (n <= 31 && (n - 1 - i) % 7 === 0)
    return {
      key: d.day,
      pct,
      peak: d.totals.peak,
      target: d.day,
      selected: d.day === selectedDay,
      label: d.day.endsWith('-01') || weekly ? fmtDayShort(d.day) : null,
      tip: [
        `${fmtPct(pct)} covered · ${plural(d.totals.peak, 'session')} at once`,
        `${fmtMinutes(d.totals.agentMin)} agent time`,
        fmtDayLong(d.day)
      ],
      attrs: { 'data-activity-trend-day': d.day }
    }
  })
}

function weekBars(days: DayActivity[], selectedDay: string): TrendBar[] {
  const selectedWeek = mondayOf(selectedDay)
  return weeklyTrend(days).map((w) => ({
    key: w.monday,
    pct: w.avgCoveragePct,
    peak: w.peak,
    target: w.target,
    selected: w.monday === selectedWeek,
    label: w.monthLabel,
    tip: [
      `Week of ${fmtDayMonth(w.monday)}`,
      `${fmtPct(w.avgCoveragePct)} covered on average · up to ${w.peak} at once · ${fmtMinutes(w.agentMin)} agent time`
    ],
    attrs: { 'data-activity-trend-week': w.monday }
  }))
}

function TrendCard({
  days,
  range,
  selectedDay,
  onSelect
}: {
  days: DayActivity[]
  range: ActivityRange
  selectedDay: string
  onSelect: (day: string) => void
}): ReactElement {
  const [hostRef, width] = useWidth<HTMLDivElement>()
  const [tip, setTip] = useState<TipState | null>(null)
  const weekly = range === 'year'
  const bars = weekly ? weekBars(days, selectedDay) : dayBars(days, selectedDay)
  const n = bars.length
  const maxPct = Math.max(0.0001, ...bars.map((b) => b.pct))
  const maxPeak = Math.max(1, ...bars.map((b) => b.peak))
  const slot = n > 0 ? width / n : 0
  const barW = Math.min(24, Math.max(1, slot >= 6 ? slot - 2 : slot * 0.75))
  const dotR = Math.max(1.25, Math.min(4, slot * 0.3))
  const top = DOTS_H + 6
  const plotH = BARS_H
  const base = top + plotH
  // Never two labels too close.
  const labels: { i: number; text: string }[] = []
  bars.forEach((b, i) => {
    if (!b.label) return
    const x = i * slot + slot / 2
    if (labels.length > 0 && x - (labels[labels.length - 1].i * slot + slot / 2) < 44) return
    labels.push({ i, text: b.label })
  })
  return (
    <div className="settings-card activity-card">
      <div className="activity-legend" aria-hidden>
        <span className="activity-legend-item">
          <span className="activity-legend-bar" />
          {weekly ? 'Share of the day covered, the week’s average' : 'Share of the day covered'}
        </span>
        <span className="activity-legend-item">
          <span className="activity-legend-dot" />
          Most at once (up to {maxPeak})
        </span>
      </div>
      <div
        className="activity-bars"
        ref={hostRef}
        onPointerLeave={() => setTip(null)}
        data-activity-trend={weekly ? 'week' : 'day'}
      >
        {width > 0 && n > 0 && (
          <svg
            width={width}
            height={base + BAR_LABEL_H}
            role="img"
            aria-label={
              weekly
                ? 'Coverage and most at once, week by week'
                : 'Coverage and most at once, day by day'
            }
          >
            <line x1={0} x2={width} y1={top} y2={top} className="activity-grid" />
            <text x={0} y={top - 3} className="activity-axis-text">
              {fmtPct(maxPct)}
            </text>
            <line x1={0} x2={width} y1={base} y2={base} className="activity-baseline" />
            {bars.map((b, i) => {
              const bh = (b.pct / maxPct) * (plotH - 2)
              const x = i * slot + (slot - barW) / 2
              const cx = i * slot + slot / 2
              const cy = DOTS_H - 2 - (b.peak / maxPeak) * (DOTS_H - 2 * dotR - 4) - dotR
              return (
                <g key={b.key}>
                  <rect
                    x={i * slot}
                    y={0}
                    width={slot}
                    height={base}
                    className="activity-hit"
                    data-selected={b.selected ? 'true' : undefined}
                    {...b.attrs}
                    onClick={() => onSelect(b.target)}
                    onPointerMove={(e) => setTip(tipAt(e, hostRef.current, b.tip))}
                  />
                  <path d={columnPath(x, base - bh, barW, bh)} className="activity-bar" />
                  {b.peak > 0 && <circle cx={cx} cy={cy} r={dotR} className="activity-dot" />}
                </g>
              )
            })}
            {labels.map(({ i, text }) => (
              <text
                key={i}
                x={i * slot + slot / 2}
                y={base + BAR_LABEL_H - 4}
                textAnchor="middle"
                className="activity-axis-text"
              >
                {text}
              </text>
            ))}
          </svg>
        )}
        <Tip tip={tip} />
      </div>
    </div>
  )
}

// ── f. Where the time went ────────────────────────────────────────────────

interface ShareRow {
  key: string
  label: string
  title: string
  /** The bar's length, against the list's largest. */
  amount: number
  value: string
  quiet: boolean
}

function ShareList({
  title,
  rows,
  kind
}: {
  title: string
  rows: ShareRow[]
  kind: string
}): ReactElement {
  const max = Math.max(0.0001, ...rows.map((r) => r.amount))
  return (
    <div className="settings-card activity-card" data-activity-breakdown={kind}>
      <div className="activity-share">
        <p className="activity-share-title">{title}</p>
        {rows.length === 0 ? (
          <p className="activity-empty">No session in this range.</p>
        ) : (
          <ul className="activity-share-list">
            {rows.map((r) => (
              <li key={r.key} className="activity-share-row" title={r.title}>
                <span className="activity-share-label">{r.label}</span>
                <span className="activity-share-track">
                  {r.amount > 0 && (
                    <span
                      className="activity-share-bar"
                      style={{ width: `${(r.amount / max) * 100}%` }}
                    />
                  )}
                </span>
                <span className="activity-share-value" data-quiet={r.quiet ? 'true' : undefined}>
                  {r.value}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function Breakdown({ days }: { days: DayActivity[] }): ReactElement {
  const projects: ShareRow[] = byProject(days).map((p) => ({
    key: p.cwd,
    label: p.label,
    title:
      p.cwd === OTHER_PROJECTS
        ? `${plural(p.sessions, 'session')}`
        : `${p.cwd} · ${plural(p.sessions, 'session')}`,
    amount: p.agentMin,
    value: fmtMinutes(p.agentMin),
    quiet: false
  }))
  const agents: ShareRow[] = byProvider(days).map((p) => ({
    key: `${p.provider}:${p.model ?? ''}`,
    label: modelLabel(p.model, p.provider),
    title: `${providerLabel(p.provider)}${p.model ? ` · ${p.model}` : ''} · ${plural(p.sessions, 'session')}`,
    amount: p.agentMin,
    value: p.tracked ? fmtMinutes(p.agentMin) : `open ${fmtMinutes(p.openMin)}`,
    quiet: !p.tracked
  }))
  return (
    <div className="activity-breakdown">
      <ShareList title="By project" rows={projects} kind="project" />
      <ShareList title="By agent" rows={agents} kind="agent" />
    </div>
  )
}

// ── The page ──────────────────────────────────────────────────────────────

/** The Activity page's body, under its header. */
export function ActivityPanel({ range }: { range: ActivityRange }): ReactElement {
  const a = useActivity(range)
  const today = localDayKey(a.now)
  const ready = a.summary !== null && a.summaryRange !== null
  const shownRange = a.summaryRange ?? range

  if (a.error && !ready)
    return (
      <div className="space-y-8" data-activity-page>
        <SettingsCallout
          tone="danger"
          title="The activity record could not be read"
          text={a.error}
        />
      </div>
    )

  return (
    // Focusable so the page's keys have somewhere to land (useDayKeys).
    <div
      className="space-y-8 activity-page"
      data-activity-page
      tabIndex={-1}
      data-loading={a.loading ? 'true' : undefined}
    >
      {a.error && (
        <SettingsCallout
          tone="danger"
          title="The activity record could not be read"
          text={a.error}
        />
      )}
      <SettingsSection
        title="The range in numbers"
        description="How much of the time a session was working, how many at once, and how long they waited on you."
      >
        {ready ? (
          <RangeFade range={shownRange}>
            <Headlines days={a.summary ?? []} />
          </RangeFade>
        ) : (
          <Skeleton />
        )}
      </SettingsSection>

      <SettingsSection
        title="The day"
        description="Every session of one day: when it was open, when it worked, when it waited on you."
      >
        <DayCard
          day={a.day}
          selectedDay={a.selectedDay}
          today={today}
          now={a.now}
          onSelect={a.setSelectedDay}
        />
      </SettingsSection>

      <SettingsSection
        title="The year"
        description="Agent time per day over the last twelve months. Pick a day to see it above."
      >
        {a.year ? (
          <YearCard
            year={a.year}
            now={a.now}
            selectedDay={a.selectedDay}
            onSelect={a.setSelectedDay}
          />
        ) : (
          <Skeleton />
        )}
      </SettingsSection>

      <SettingsSection
        title="When you work"
        description="Time with a session working, per hour of the day, over the range."
      >
        {ready ? (
          <RangeFade range={shownRange}>
            <HourCard days={a.summary ?? []} />
          </RangeFade>
        ) : (
          <Skeleton />
        )}
      </SettingsSection>

      {shownRange !== 'today' && (
        <SettingsSection
          title={shownRange === 'year' ? 'Week by week' : 'Day by day'}
          description={
            shownRange === 'year'
              ? 'How much of the day a session was working, on average over each week, and the most that worked at once. Pick a week to open its busiest day.'
              : 'How much of each day had a session working, and the most that worked at once.'
          }
        >
          {ready ? (
            <RangeFade range={shownRange}>
              <TrendCard
                days={a.summary ?? []}
                range={shownRange}
                selectedDay={a.selectedDay}
                onSelect={a.setSelectedDay}
              />
            </RangeFade>
          ) : (
            <Skeleton />
          )}
        </SettingsSection>
      )}

      <SettingsSection
        title="Where the time went"
        description="Agent time per project and per agent over the range."
      >
        {ready ? (
          <RangeFade range={shownRange}>
            <Breakdown days={a.summary ?? []} />
          </RangeFade>
        ) : (
          <Skeleton />
        )}
      </SettingsSection>

      <p className="activity-foot" data-activity-foot>
        Recorded on this Mac only, in the app&apos;s data folder. Nothing leaves the machine.
      </p>
    </div>
  )
}

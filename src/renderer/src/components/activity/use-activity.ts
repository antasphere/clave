import { useEffect, useRef, useState } from 'react'
import type { DayActivity } from '../../../../shared/activity-fold'
import {
  localDayKey,
  rangeBounds,
  RANGE_DAYS,
  daysBack,
  type ActivityRange
} from './activity-shape'

/** What the Activity page reads: the range's days as a summary, the trailing
 *  year for the heatmap, and one day in full for the tape and the lanes. */
export interface ActivityState {
  /** The range's days, with the range they answer (the page keys its fade on it). */
  summary: DayActivity[] | null
  summaryRange: ActivityRange | null
  year: DayActivity[] | null
  /** The selected day in full, or null until it lands. */
  day: DayActivity | null
  selectedDay: string
  setSelectedDay: (day: string) => void
  loading: boolean
  error: string | null
  now: number
}

const CHANGE_DEBOUNCE_MS = 500

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function useActivity(range: ActivityRange): ActivityState {
  const [selectedDay, setSelectedDay] = useState(() => localDayKey(Date.now()))
  const [summary, setSummary] = useState<{ range: ActivityRange; days: DayActivity[] } | null>(null)
  const [year, setYear] = useState<DayActivity[] | null>(null)
  const [day, setDay] = useState<DayActivity | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState<string | null>(null)
  // A pushed change bumps the tick, which re-runs every fetch below.
  const [tick, setTick] = useState(0)
  // Which request each half last answered: loading is a request not answered yet.
  const rangeKey = `${range}#${tick}`
  const dayKey = `${selectedDay}#${tick}`
  const [rangeAnswered, setRangeAnswered] = useState<string | null>(null)
  const [dayAnswered, setDayAnswered] = useState<string | null>(null)

  // The request counters: an answer is kept only while its request is the
  // latest of its kind, so a slow answer never overwrites a newer one.
  const rangeSeq = useRef(0)
  const daySeq = useRef(0)

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onActivityChanged) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = api.onActivityChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        setTick((t) => t + 1)
      }, CHANGE_DEBOUNCE_MS)
    })
    return () => {
      if (timer) clearTimeout(timer)
      off()
    }
  }, [])

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.activityQuery) return
    const seq = ++rangeSeq.current
    const at = Date.now()
    const { from, to } = rangeBounds(range, at)
    const key = `${range}#${tick}`
    const summaryCall = api.activityQuery(from, to, false)
    const yearCall =
      range === 'year' ? summaryCall : api.activityQuery(daysBack(at, RANGE_DAYS.year), to, false)
    Promise.all([summaryCall, yearCall])
      .then(([s, y]) => {
        if (seq !== rangeSeq.current) return
        setSummary({ range, days: s.days })
        setYear(y.days)
        setNow(s.now)
        setError(null)
        setRangeAnswered(key)
      })
      .catch((e: unknown) => {
        if (seq !== rangeSeq.current) return
        setError(message(e))
        setRangeAnswered(key)
      })
  }, [range, tick])

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.activityQuery) return
    const seq = ++daySeq.current
    const key = `${selectedDay}#${tick}`
    api
      .activityQuery(selectedDay, selectedDay, true)
      .then((answer) => {
        if (seq !== daySeq.current) return
        setDay(answer.days[0] ?? null)
        setNow(answer.now)
        setError(null)
        setDayAnswered(key)
      })
      .catch((e: unknown) => {
        if (seq !== daySeq.current) return
        setError(message(e))
        setDayAnswered(key)
      })
  }, [selectedDay, tick])

  // Unmounted: nothing in flight may land any more.
  useEffect(
    () => () => {
      rangeSeq.current++
      daySeq.current++
    },
    []
  )

  return {
    summary: summary?.days ?? null,
    summaryRange: summary?.range ?? null,
    year,
    day,
    selectedDay,
    setSelectedDay,
    loading: rangeAnswered !== rangeKey || dayAnswered !== dayKey,
    error,
    now
  }
}

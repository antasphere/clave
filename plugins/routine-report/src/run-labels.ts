import type { RoutineRun } from '@clave/contract/routines/model'

/** The words and colours of a run, shared by the badge, the panel and the view. */
/** The dot's colour for a run, the same rule on the badge and in the history. */
export function runTone(
  run: RoutineRun | undefined
): 'none' | 'running' | 'waiting' | 'ok' | 'attention' | 'failed' {
  if (!run) return 'none'
  if (run.state === 'running' || run.state === 'waiting') return run.state
  return run.state
}

export const TONE_CLASS: Record<ReturnType<typeof runTone>, string> = {
  none: '',
  running: 'bg-accent animate-pulse',
  waiting: 'bg-amber-400 animate-pulse',
  ok: 'bg-emerald-500',
  attention: 'bg-amber-400',
  failed: 'bg-red-500'
}

export function stateLabel(run: RoutineRun): string {
  switch (run.state) {
    case 'running':
      return 'Running'
    case 'waiting':
      return 'Waiting on you'
    case 'ok':
      return 'OK'
    case 'attention':
      return 'Attention'
    case 'failed':
      return 'Failed'
  }
}

export function whenLabel(at: number, now = Date.now()): string {
  const d = new Date(at)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return sameDay
    ? time
    : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}

export function durationLabel(run: RoutineRun, now = Date.now()): string {
  const ms = (run.endedAt ?? now) - run.startedAt
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

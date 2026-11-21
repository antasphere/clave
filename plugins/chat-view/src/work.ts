import { useEffect, useState } from 'react'
import { claudeModelName } from '../../../src/shared/claude-models'
import { compactTokens, type SubAgent } from './terminal-status'

/* What both drawings of the work running now share: the strip of cards
   under the composer of the Chat and Terminal views (`WorkCards`), and
   Folio's dock in its desk's corner (`lab/FolioWork`). The rules are pure
   and tested (`work.test.ts`); the two hooks hold the leaving rows and the
   one-second clock the figures read. */

/** How long a leaving row takes to fold away; the stylesheet's transition
 *  is twice the default duration, and this waits a little past it. */
export const LEAVE_MS = 340
/** How long an agent may go without a call before its row says it is quiet.
 *  Quiet is not stuck — a long answer being written makes no call — so the
 *  row only says how long, and the reader judges. */
export const QUIET_MS = 60_000

/** "12s", "3m 12s", "1h 4m": how long since `since`. */
export function elapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** An agent no step has come from for a minute. A command is never quiet:
 *  a server left running writes nothing for hours and is working. */
export const isQuiet = (agent: SubAgent, now: number): boolean =>
  agent.kind !== 'shell' && now - agent.lastActiveAt >= QUIET_MS

/** The figures of a row, as data, in the order and the words of the card:
 *  the steps, the agent's own context, the time it has run (or how long it
 *  has been quiet, in its place), and the model it was launched on. A
 *  command has its time alone. */
export interface WorkFigures {
  /** "12 steps"; null before the first. */
  steps: string | null
  /** "48k ctx"; null before its first call. */
  context: string | null
  /** "3m 12s", or "quiet 2m 10s" when `quiet`. */
  time: string
  /** How long it has run, quiet or not. */
  ran: string
  quiet: boolean
  /** The model by name, "…" until its first answer names it; null for a
   *  command. */
  model: string | null
  /** The model's tooltip; null for a command. */
  modelTitle: string | null
}
export function workFigures(agent: SubAgent, now: number): WorkFigures {
  const shell = agent.kind === 'shell'
  const quiet = isQuiet(agent, now)
  const named = claudeModelName(agent.model) ?? agent.model
  const ran = elapsed(agent.startedAt, now)
  return {
    steps:
      !shell && agent.toolCount > 0
        ? `${agent.toolCount} step${agent.toolCount === 1 ? '' : 's'}`
        : null,
    context:
      !shell && agent.contextUsed !== null ? `${compactTokens(agent.contextUsed)} ctx` : null,
    time: quiet ? `quiet ${elapsed(agent.lastActiveAt, now)}` : ran,
    ran,
    quiet,
    model: shell ? null : (named ?? '…'),
    modelTitle: shell
      ? null
      : named
        ? `Launched on ${named}`
        : 'Its model is named at its first answer'
  }
}

/** A row of the work drawn: the work, and whether it has gone and is only
 *  held for its fold. */
export interface WorkRow {
  agent: SubAgent
  gone: boolean
}

/** One step of the leaving list: the rows `previous` listed that `next` no
 *  longer does join the ones already leaving; a row listed again stops
 *  leaving. */
export function nextLeaving(
  previous: SubAgent[],
  next: SubAgent[],
  leaving: SubAgent[]
): SubAgent[] {
  const ids = new Set(next.map((agent) => agent.id))
  const gone = previous.filter((agent) => !ids.has(agent.id))
  return [
    ...leaving.filter((agent) => !ids.has(agent.id)),
    ...gone.filter((agent) => !leaving.some((c) => c.id === agent.id))
  ]
}

/** The rows to draw: the running ones in their order, then the leaving. */
export const workRows = (agents: SubAgent[], leaving: SubAgent[]): WorkRow[] => [
  ...agents.map((agent) => ({ agent, gone: false })),
  ...leaving.map((agent) => ({ agent, gone: true }))
]

/** The rows to draw, a row the props no longer list kept, marked gone, for
 *  the length of its fold (`LEAVE_MS`). */
export function useLeavingWork(agents: SubAgent[]): WorkRow[] {
  const [leaving, setLeaving] = useState<SubAgent[]>([])
  const [previous, setPrevious] = useState(agents)
  if (previous !== agents) {
    setPrevious(agents)
    setLeaving((current) => nextLeaving(previous, agents, current))
  }
  useEffect(() => {
    if (!leaving.length) return
    const timer = window.setTimeout(() => setLeaving([]), LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [leaving])
  return workRows(agents, leaving)
}

/** Now, read again every second while anything runs. */
export function useWorkClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  return now
}

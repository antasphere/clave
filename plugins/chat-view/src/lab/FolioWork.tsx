import { useEffect, useId, useReducer, useRef, useState } from 'react'
import { ConfirmDialog } from '@clave/ui/components'
import { claudeModelName } from '../../../../src/shared/claude-models'
import { runningLabel, type SubAgent } from '../terminal-status'
import { SubAgentPeek } from '../SubAgentPeek'
import { ShellPeek } from '../ShellPeek'
import { WorkDrawing, WorkMark } from '../WorkDrawing'
import type { SubagentLogs } from '../subagents'
import { isQuiet, useLeavingWork, useWorkClock, workFigures } from '../work'
import { CLOSE_BEAT_MS, OPEN_BEAT_MS, closedDock, dockMarks, nextDock } from './folio-work'

/* Folio's work dock (PRDCT-4833): the work running now — the subagents and
   the commands left in the background — in the desk's bottom-right corner,
   at the foot of the margin column whose head holds the voice card. The
   Chat and Terminal views keep their strip under the composer (WorkCards);
   in a book of pages the strip read as a second composer and pushed the
   page up each time an agent started, so here the work lies over the desk,
   out of the flow, and nothing of the page or the composer moves for it.

   Closed, it is a pill of paper with one mark per running thing (the first
   four, then +N), no words: an agent's head, a command's prompt, the
   drawings' own focal points, breathing out of phase while they work; a
   quiet agent's mark stills and takes the warning colour. On approach (the
   pointer, after a beat; the keyboard's focus; a click that pins it) the
   pill grows a card from its corner: the count in the Terminal view's
   words, then a row per running thing with its full drawing, the type and
   the task, the last step, the figures. A row opens the same window onto
   its work as the strip's card does, with the same relaunch. The open and
   close rule is the reducer of folio-work.ts; this component feeds it and
   runs its two timers, and never takes the focus by itself. */
export function FolioWork({
  agents,
  logs,
  canRelaunch,
  onRelaunch
}: {
  agents: SubAgent[]
  /** Each agent's own conversation, by the row's id (`subagents.ts`). */
  logs?: SubagentLogs
  /** Whether the conversation can launch this agent again. */
  canRelaunch: (agent: SubAgent) => boolean
  /** Stop the agent and have the conversation launch it again on `alias`. */
  onRelaunch: (agent: SubAgent, alias: string) => void
}): React.JSX.Element | null {
  const rows = useLeavingWork(agents)
  const running = agents.length > 0
  const now = useWorkClock(running)
  const [dock, send] = useReducer(nextDock, closedDock)
  const [asked, setAsked] = useState<{ agent: SubAgent; alias: string } | null>(null)
  // The windows open over the card, by row: one whose row has gone closes
  // with it and tells nobody, so only the rows still running count.
  const [peeks, setPeeks] = useState<ReadonlySet<string>>(() => new Set())
  const root = useRef<HTMLDivElement>(null)
  const pill = useRef<HTMLButtonElement>(null)
  // Whether the pointer is over the pill or the card, for a focus that
  // leaves while the pointer stays.
  const inside = useRef(false)
  // The focus the dock gives back to the pill on Escape is not an opening.
  const returning = useRef(false)
  const cardId = useId()

  const held = asked !== null || agents.some((agent) => peeks.has(agent.id))
  useEffect(() => {
    send(held ? 'window-open' : 'window-close')
    if (!held && !inside.current) send('pointer-out')
  }, [held])
  // The two timers: whatever is pending comes due after its beat.
  useEffect(() => {
    if (!dock.pending) return
    const timer = window.setTimeout(
      () => send('beat'),
      dock.pending === 'open' ? OPEN_BEAT_MS : CLOSE_BEAT_MS
    )
    return () => window.clearTimeout(timer)
  }, [dock.pending])
  // A pointer down anywhere else closes it.
  const open = dock.open !== null
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && !root.current?.contains(target)) send('outside')
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  // Nothing left to show: the dock forgets it was open.
  const empty = rows.length === 0
  useEffect(() => {
    if (empty) {
      inside.current = false
      send('escape')
    }
  }, [empty])

  const confirm = (
    <ConfirmDialog
      isOpen={asked !== null}
      title={`Relaunch on ${asked ? (claudeModelName(asked.alias) ?? asked.alias) : ''}?`}
      message={
        asked
          ? `“${asked.agent.description || asked.agent.type}” stops now and what it has done so far is lost; the conversation launches it again, same task, on the model you picked.`
          : ''
      }
      confirmLabel="Relaunch"
      onCancel={() => setAsked(null)}
      onConfirm={() => {
        if (asked) onRelaunch(asked.agent, asked.alias)
        setAsked(null)
      }}
    />
  )
  if (empty) return confirm

  const { marks, overflow } = dockMarks(rows)
  const count = runningLabel(agents)
  const peekChange = (id: string) => (next: boolean) =>
    setPeeks((current) => {
      const copy = new Set(current)
      if (next) copy.add(id)
      else copy.delete(id)
      return copy
    })

  return (
    <div
      ref={root}
      className="folio-work"
      data-testid="folio-work"
      data-open={dock.open ?? undefined}
      data-empty={running ? undefined : 'true'}
      onPointerEnter={() => {
        inside.current = true
        send('pointer-in')
      }}
      onPointerLeave={() => {
        inside.current = false
        send('pointer-out')
      }}
      onFocus={(event) => {
        if (returning.current) {
          returning.current = false
          return
        }
        // The keyboard's focus opens it; a click's focus leaves it to the
        // click (the pill pins, a row opens its window).
        if ((event.target as HTMLElement).matches(':focus-visible')) send('focus-in')
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (next && event.currentTarget.contains(next)) return
        send('focus-out')
        if (inside.current) send('pointer-in')
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || held || !open) return
        event.stopPropagation()
        send('escape')
        returning.current = document.activeElement !== pill.current
        pill.current?.focus()
      }}
    >
      <div
        id={cardId}
        className="folio-work-card"
        data-testid="folio-work-card"
        role="group"
        aria-label="Running now"
        inert={!open}
      >
        <header className="folio-work-head">
          <span className="folio-work-eyebrow">Running now</span>
          <span className="folio-work-count">{count}</span>
        </header>
        <ul className="folio-work-rows">
          {rows.map(({ agent, gone }, index) => {
            const shell = agent.kind === 'shell'
            const figures = workFigures(agent, now)
            const quiet = !gone && figures.quiet
            const face = (
              <button
                type="button"
                className="folio-work-open"
                aria-label={`Watch ${agent.description || agent.type}`}
              >
                <WorkDrawing kind={shell ? 'shell' : 'agent'} working={!gone && !quiet} />
                <span className="folio-work-text">
                  <span className="folio-work-task">
                    {!shell && <span className="term-agent-type">{agent.type}</span>}{' '}
                    <span className="folio-work-description">{agent.description}</span>
                  </span>
                  {shell ? (
                    <code className="folio-work-step folio-work-command">
                      {agent.command ?? agent.description}
                    </code>
                  ) : (
                    <span className="folio-work-step">{agent.lastAction ?? 'No step yet'}</span>
                  )}
                  <span className="folio-work-figures">
                    {figures.steps && <span>{figures.steps}</span>}
                    {figures.context && (
                      <span title="Tokens in this agent's own context">{figures.context}</span>
                    )}
                    {quiet ? (
                      <span className="term-agent-quiet" title="No step for a while">
                        {figures.time}
                      </span>
                    ) : (
                      <span>{figures.ran}</span>
                    )}
                    {figures.model !== null && (
                      <span title={figures.modelTitle ?? undefined}>{figures.model}</span>
                    )}
                  </span>
                </span>
              </button>
            )
            return (
              <li
                key={agent.id}
                className="folio-work-row"
                data-testid="folio-work-row"
                data-kind={agent.kind}
                data-quiet={quiet || undefined}
                data-leaving={gone || undefined}
                style={{ '--row-i': index } as React.CSSProperties}
              >
                {gone ? (
                  face
                ) : shell ? (
                  <ShellPeek agent={agent} onOpenChange={peekChange(agent.id)}>
                    {face}
                  </ShellPeek>
                ) : (
                  <SubAgentPeek
                    agent={agent}
                    log={logs?.[agent.id]}
                    onOpenChange={peekChange(agent.id)}
                    onRelaunch={
                      canRelaunch(agent) ? (alias) => setAsked({ agent, alias }) : undefined
                    }
                  >
                    {face}
                  </SubAgentPeek>
                )}
              </li>
            )
          })}
        </ul>
      </div>
      <button
        ref={pill}
        type="button"
        className="folio-work-pill"
        data-testid="folio-work-pill"
        aria-label={`Running now: ${runningLabel(agents, ', ') || 'nothing'}`}
        aria-expanded={open}
        aria-controls={cardId}
        onClick={() => send('pill-click')}
      >
        {marks.map(({ agent, gone }, index) => {
          const quiet = !gone && isQuiet(agent, now)
          return (
            <span
              key={agent.id}
              className="folio-work-mark"
              data-testid="folio-work-mark"
              data-kind={agent.kind}
              data-quiet={quiet || undefined}
              data-leaving={gone || undefined}
              style={{ '--mark-i': index } as React.CSSProperties}
            >
              <WorkMark
                kind={agent.kind === 'shell' ? 'shell' : 'agent'}
                working={!gone && !quiet}
              />
            </span>
          )
        })}
        {overflow > 0 && <span className="folio-work-more">+{overflow}</span>}
      </button>
      {confirm}
    </div>
  )
}

import { useState } from 'react'
import { ConfirmDialog } from '@clave/ui/components'
import { claudeModelName } from '../../../src/shared/claude-models'
import type { SubAgent } from './terminal-status'
import { SubAgentPeek } from './SubAgentPeek'
import { ShellPeek } from './ShellPeek'
import { WorkDrawing } from './WorkDrawing'
import type { SubagentLogs } from './subagents'
import { useLeavingWork, useWorkClock, workFigures } from './work'

/** The work running now, as cards under the composer of both views: one per
 *  subagent and one per command left running (background work only,
 *  `shownWork`). A card is a drawing of what it is and two lines: the type
 *  and the task (an agent), or the command's title; then the figures — the
 *  steps an agent took, how full its own context is, how long it has run,
 *  or how long it has been quiet once no step has come for a minute. The
 *  drawing breathes while the work goes on. Clicking a card opens the
 *  window onto its work (`SubAgentPeek`, `ShellPeek`); an agent's card says
 *  the model it was launched on, and its window is where it can be relaunched
 *  on another, since that stops it and starts it over. A card folds open as its work starts
 *  and folds shut as it ends, so the strip is held for the length of the
 *  fold after a card has gone; the strip itself folds away with its last
 *  card. */
export function WorkCards({
  agents,
  logs,
  canRelaunch,
  onRelaunch
}: {
  agents: SubAgent[]
  /** Each agent's own conversation, by the card's id (`subagents.ts`). */
  logs?: SubagentLogs
  /** Whether the conversation can launch this agent again; a card it says no
   *  to, and every command's card, offers no relaunch. */
  canRelaunch: (agent: SubAgent) => boolean
  /** Stop the agent and have the conversation launch it again on `alias`. */
  onRelaunch: (agent: SubAgent, alias: string) => void
}): React.JSX.Element | null {
  const [asked, setAsked] = useState<{ agent: SubAgent; alias: string } | null>(null)
  // A card the props no longer list is kept, marked leaving, for the fold.
  const rows = useLeavingWork(agents)
  const running = agents.length > 0
  const now = useWorkClock(running)
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
  if (!rows.length) return confirm
  return (
    <div className="work-cards" data-empty={running ? undefined : 'true'}>
      <ul className="work-cards-list" aria-label="Running work">
        {rows.map(({ agent, gone }) => {
          const shell = agent.kind === 'shell'
          const figures = workFigures(agent, now)
          const quiet = !gone && figures.quiet
          const card = (
            <button
              type="button"
              className="work-card-open"
              aria-label={`Watch ${agent.description || agent.type}`}
              title={
                shell
                  ? `${agent.background ? 'Running in the background' : 'Running'}: ${agent.command ?? agent.description}`
                  : agent.lastAction
                    ? `Last step: ${agent.lastAction}`
                    : 'No step yet'
              }
            >
              <WorkDrawing kind={shell ? 'shell' : 'agent'} working={!gone && !quiet} />
              <span className="work-card-text">
                <span className="work-card-title">
                  {!shell && <span className="term-agent-type">{agent.type}</span>}
                  <span className="term-agent-description">{agent.description}</span>
                </span>
                <span className="work-card-meta">
                  {figures.steps && <span className="term-agent-steps">{figures.steps}</span>}
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
                  {/* The model it was launched on, said and not offered: a
                      relaunch is in the window the card opens. */}
                  {figures.model !== null && (
                    <span
                      className="term-agent-model work-card-model"
                      title={figures.modelTitle ?? undefined}
                    >
                      {figures.model}
                    </span>
                  )}
                </span>
              </span>
            </button>
          )
          return (
            <li
              key={agent.id}
              className="term-agent work-card"
              data-kind={agent.kind}
              data-background={agent.background || undefined}
              data-quiet={quiet || undefined}
              data-leaving={gone || undefined}
            >
              <div className="work-card-row">
                {gone ? (
                  card
                ) : shell ? (
                  <ShellPeek agent={agent}>{card}</ShellPeek>
                ) : (
                  <SubAgentPeek
                    agent={agent}
                    log={logs?.[agent.id]}
                    onRelaunch={
                      canRelaunch(agent) ? (alias) => setAsked({ agent, alias }) : undefined
                    }
                  >
                    {card}
                  </SubAgentPeek>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {confirm}
    </div>
  )
}

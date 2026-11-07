import { useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import { ConfirmDialog } from '@clave/ui/components'
import { claudeModelName, findClaudeModel } from '../../../../packages/shared/src/claude-models'
import { compactTokens, type SubAgent } from './terminal-status'
import { SubAgentPeek } from './SubAgentPeek'
import { ShellPeek } from './ShellPeek'
import { WorkDrawing } from './WorkDrawing'
import type { SubagentLogs } from './subagents'

function elapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** How long a leaving card takes to fold away; the stylesheet's transition
 *  is twice the default duration, and this waits a little past it. */
const LEAVE_MS = 340
/** How long an agent may go without a call before its card says it is quiet.
 *  Quiet is not stuck — a long answer being written makes no call — so the
 *  card only says how long, and the reader judges. */
const QUIET_MS = 60_000

/** The families a subagent can be relaunched on: the Agent tool takes an
 *  alias, never a version, so each is named by the version it stands for. */
const AGENT_MODELS = (['opus', 'fable', 'sonnet', 'haiku'] as const).map((alias) => ({
  alias,
  name: claudeModelName(alias) ?? alias
}))

/** The model chip on a subagent's card and the menu that relaunches the agent
 *  on another. Only a background agent can be stopped on its own, and only
 *  where the conversation can relaunch it (`onPick`); any other shows its
 *  model, by the provider's own name when it is not a Claude one, and offers
 *  no menu. */
function AgentModel({
  agent,
  onPick
}: {
  agent: SubAgent
  onPick?: (alias: string) => void
}): React.JSX.Element {
  const name = claudeModelName(agent.model) ?? agent.model
  const label = name ?? '…'
  const title = name ? `Runs on ${name}` : 'Its model is named at its first answer'
  if (!agent.taskId || !onPick)
    return (
      <span className="term-agent-model" title={title}>
        {label}
      </span>
    )
  const current = findClaudeModel(agent.model)?.alias
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="term-agent-model"
          aria-label={`Model of ${agent.description || agent.type}`}
          title={`${title} — relaunch it on another model`}
        >
          {label}
          <ChevronDownIcon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={6}
          className="menu-surface menu-pop chat-model-menu z-50"
          aria-label="Relaunch on"
        >
          <DropdownMenu.Label className="menu-label">Relaunch on</DropdownMenu.Label>
          {AGENT_MODELS.map((model) => (
            <DropdownMenu.Item
              key={model.alias}
              className="menu-item chat-model-option"
              data-selected={model.alias === current ? 'true' : undefined}
              disabled={model.alias === current}
              onSelect={() => onPick(model.alias)}
            >
              <span className="chat-model-option-text">
                <span className="truncate">{model.name}</span>
              </span>
              {model.alias === current && <CheckIcon className="select-option-check" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** The work running now, as cards under the composer of both views: one per
 *  subagent and one per command left running (background work only,
 *  `shownWork`). A card is a drawing of what it is and two lines: the type
 *  and the task (an agent), or the command's title; then the figures — the
 *  steps an agent took, how full its own context is, how long it has run,
 *  or how long it has been quiet once no step has come for a minute. The
 *  drawing breathes while the work goes on. Clicking a card opens the
 *  window onto its work (`SubAgentPeek`, `ShellPeek`); an agent's model chip
 *  beside it opens the relaunch menu. A card folds open as its work starts
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
  const [now, setNow] = useState(() => Date.now())
  const [leaving, setLeaving] = useState<SubAgent[]>([])
  const [previous, setPrevious] = useState(agents)
  const [asked, setAsked] = useState<{ agent: SubAgent; alias: string } | null>(null)
  // A card the props no longer list is kept, marked leaving, for the fold.
  if (previous !== agents) {
    const ids = new Set(agents.map((agent) => agent.id))
    const gone = previous.filter((agent) => !ids.has(agent.id))
    setPrevious(agents)
    setLeaving((current) => [
      ...current.filter((agent) => !ids.has(agent.id)),
      ...gone.filter((agent) => !current.some((c) => c.id === agent.id))
    ])
  }
  useEffect(() => {
    if (!leaving.length) return
    const timer = window.setTimeout(() => setLeaving([]), LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [leaving])
  const running = agents.length > 0
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
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
  if (!running && !leaving.length) return confirm
  const rows = [
    ...agents.map((agent) => ({ agent, gone: false })),
    ...leaving.map((agent) => ({ agent, gone: true }))
  ]
  return (
    <div className="work-cards" data-empty={running ? undefined : 'true'}>
      <ul className="work-cards-list" aria-label="Running work">
        {rows.map(({ agent, gone }) => {
          const shell = agent.kind === 'shell'
          const quiet = !gone && !shell && now - agent.lastActiveAt >= QUIET_MS
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
                  {agent.toolCount > 0 && (
                    <span className="term-agent-steps">
                      {`${agent.toolCount} step${agent.toolCount === 1 ? '' : 's'}`}
                    </span>
                  )}
                  {agent.contextUsed !== null && (
                    <span title="Tokens in this agent's own context">
                      {compactTokens(agent.contextUsed)} ctx
                    </span>
                  )}
                  {quiet ? (
                    <span className="term-agent-quiet" title="No step for a while">
                      quiet {elapsed(agent.lastActiveAt, now)}
                    </span>
                  ) : (
                    <span>{elapsed(agent.startedAt, now)}</span>
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
                  <SubAgentPeek agent={agent} log={logs?.[agent.id]}>
                    {card}
                  </SubAgentPeek>
                )}
                {!shell && (
                  <AgentModel
                    agent={agent}
                    onPick={canRelaunch(agent) ? (alias) => setAsked({ agent, alias }) : undefined}
                  />
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

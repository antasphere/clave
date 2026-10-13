import { useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import { ConfirmDialog } from '@clave/ui/components'
import { claudeModelName, findClaudeModel } from '../../../src/shared/claude-models'
import { compactTokens, type SubAgent } from './terminal-status'

/** How full the context is: a bar and "(used/window)". Before a turn has named
 *  the window the bar stays empty and only the count shows. The chat variant
 *  wears the chat view's material and drops the parentheses. */
export function ContextMeter({
  used,
  window,
  variant = 'term'
}: {
  used: number | null
  window: number | null
  variant?: 'term' | 'chat'
}): React.JSX.Element {
  const ratio = used !== null && window ? Math.min(1, used / window) : 0
  const count =
    used === null
      ? window
        ? `0/${compactTokens(window)}`
        : '—'
      : window
        ? `${compactTokens(used)}/${compactTokens(window)}`
        : compactTokens(used)
  const label = variant === 'chat' ? count : `(${count})`
  const chat = variant === 'chat'
  return (
    <span
      className={chat ? 'chat-context' : 'term-context'}
      title={
        used !== null && window
          ? `Context: ${Math.round(ratio * 100)}% used`
          : 'Context: known after the first answer'
      }
    >
      <span
        className={chat ? 'chat-context-bar' : 'term-context-bar'}
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        data-level={ratio >= 0.9 ? 'high' : ratio >= 0.7 ? 'mid' : undefined}
      >
        <span
          className={chat ? 'chat-context-fill' : 'term-context-fill'}
          data-some={used ? 'true' : undefined}
          style={{ inlineSize: `${ratio * 100}%` }}
        />
      </span>
      <span className={chat ? 'chat-context-count' : 'term-dim'}>{label}</span>
    </span>
  )
}

function elapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** How long a leaving row takes to fold away; the stylesheet's transition
 *  is twice the default duration, and this waits a little past it. */
const LEAVE_MS = 340
/** How long an agent may go without a call before its row says it is quiet.
 *  Quiet is not stuck — a long answer being written makes no call — so the
 *  row only says how long, and the reader judges. */
const QUIET_MS = 60_000

/** The families a subagent can be relaunched on: the Agent tool takes an
 *  alias, never a version, so each is named by the version it stands for. */
const AGENT_MODELS = (['opus', 'fable', 'sonnet', 'haiku'] as const).map((alias) => ({
  alias,
  name: claudeModelName(alias) ?? alias
}))

/** The model chip on a subagent's row and the menu that relaunches the agent
 *  on another. Only a background agent can be stopped on its own; one the
 *  turn waits on shows its model and offers no menu. */
function AgentModel({
  agent,
  onPick
}: {
  agent: SubAgent
  onPick: (alias: string) => void
}): React.JSX.Element {
  const name = claudeModelName(agent.model)
  const label = name ?? '…'
  const title = name ? `Runs on ${name}` : 'Its model is named at its first answer'
  if (!agent.taskId)
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

/** The subagents running now, stacked under the status line: what each is,
 *  what it was asked, the model it runs on, how many steps it has taken, how
 *  full its own context is and how long it has run. The dot is the loader:
 *  it breathes while the agent works, rings once at each new step, and goes
 *  still once the agent has been quiet a minute, which the row then says;
 *  its last step is in the row's tooltip, not on the line. A row folds open
 *  as its agent starts and folds shut as it ends, so the stack is held for the
 *  length of the fold after an agent has gone; the stack itself folds away
 *  with its last row. */
export function SubAgentStack({
  agents,
  onRelaunch
}: {
  agents: SubAgent[]
  /** Stop the agent and have the conversation launch it again on `alias`. */
  onRelaunch: (agent: SubAgent, alias: string) => void
}): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now())
  const [leaving, setLeaving] = useState<SubAgent[]>([])
  const [previous, setPrevious] = useState(agents)
  const [asked, setAsked] = useState<{ agent: SubAgent; alias: string } | null>(null)
  // An agent the props no longer list is kept, marked leaving, for the fold.
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
    <div className="term-agents" data-empty={running ? undefined : 'true'}>
      <ul className="term-agents-list" aria-label="Subagents">
        {rows.map(({ agent, gone }) => {
          const quiet = !gone && now - agent.lastActiveAt >= QUIET_MS
          return (
            <li
              key={agent.id}
              className="term-agent"
              data-background={agent.background || undefined}
              data-quiet={quiet || undefined}
              data-leaving={gone || undefined}
            >
              <div
                className="term-agent-row"
                title={agent.lastAction ? `Last step: ${agent.lastAction}` : 'No step yet'}
              >
                {/* Keyed on the step count: each new step mounts a fresh
                    ring, whose one-shot animation is the tick. */}
                <span className="term-agent-dot" aria-hidden="true">
                  {agent.toolCount > 0 && (
                    <span key={agent.toolCount} className="term-agent-tick" />
                  )}
                </span>
                <span className="term-agent-type">{agent.type}</span>
                <span className="term-agent-description">{agent.description}</span>
                <span className="term-agent-meta">
                  <AgentModel agent={agent} onPick={(alias) => setAsked({ agent, alias })} />
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
              </div>
            </li>
          )
        })}
      </ul>
      {confirm}
    </div>
  )
}

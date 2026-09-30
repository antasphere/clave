import type { BackgroundTask, SessionEvent } from '../../../src/shared/session-model'
import { describeToolHead } from './tools'
import { claudeModelName } from '../../../src/shared/claude-models'

/** The Terminal view's status line, read off the same session stream the
 *  transcript is: how full the context is (`context_usage`), and the subagents
 *  running now, followed through the `parent` a subagent's own tool calls
 *  carry. A provider that sends neither leaves the line empty. The provider's
 *  raw frames never reach a window (sessions/ipc.ts), so nothing here reads
 *  them. */
export interface SubAgent {
  /** The tool call that started it: a subagent's frames name it as their parent. */
  id: string
  /** The background task it runs as, which is what stopping it names; null
   *  for an agent the turn waits on. */
  taskId: string | null
  /** What the agent is (`general-purpose`, `Explore`, …), as the call asked. */
  type: string
  description: string
  /** Run in the background (the CLI's default) rather than waited on by the turn. */
  background: boolean
  startedAt: number
  /** What it did last, as the transcript would name the call; null until it acts. */
  lastAction: string | null
  /** When it last showed a sign of work (a call, a reading of its context). */
  lastActiveAt: number
  toolCount: number
  /** Tokens in its own context after its last call; null until it has made one. */
  contextUsed: number | null
  /** The model it runs on: the one its first answer names, else the alias its
   *  call asked for, else null (it inherits, and has not answered yet). */
  model: string | null
}
export interface TerminalStatus {
  /** Tokens in the main conversation's context after its last call. */
  contextUsed: number | null
  /** The model's context window, once a turn's result has named it. */
  contextWindow: number | null
  agents: SubAgent[]
  /** Activity seen for a parent before the agent itself was known. */
  activity: Record<
    string,
    Partial<Pick<SubAgent, 'lastAction' | 'lastActiveAt' | 'toolCount' | 'contextUsed' | 'model'>>
  >
}
export const emptyStatus: TerminalStatus = {
  contextUsed: null,
  contextWindow: null,
  agents: [],
  activity: {}
}

const AGENT_TOOLS = new Set(['agent', 'task'])
const isAgentTool = (name: string): boolean => AGENT_TOOLS.has(name.toLowerCase())
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** One call, the way a row of the transcript names it: "Read reducer.ts". */
function actionOf(name: string, input: unknown): string {
  const head = describeToolHead({ kind: 'tool', id: '', name, input, complete: false, at: 0 })
  return head.target ? `${head.label} ${head.target}` : head.label
}

function withActivity(agent: SubAgent, status: TerminalStatus): SubAgent {
  const seen = status.activity[agent.id]
  return seen ? { ...agent, ...seen } : agent
}

function fromBackground(task: BackgroundTask, known: SubAgent | undefined): SubAgent {
  return {
    id: task.toolUseId ?? task.id,
    taskId: task.id,
    type: known?.type ?? 'agent',
    description: task.description || known?.description || '',
    background: true,
    startedAt: known?.startedAt ?? task.startedAt,
    lastAction: known?.lastAction ?? null,
    lastActiveAt: known?.lastActiveAt ?? task.startedAt,
    toolCount: known?.toolCount ?? 0,
    contextUsed: known?.contextUsed ?? null,
    model: known?.model ?? null
  }
}
/** Note what a subagent did, on the agent when it is listed and in the
 *  activity record for when it is listed later. */
function noteActivity(
  status: TerminalStatus,
  parent: string,
  patch: TerminalStatus['activity'][string]
): TerminalStatus {
  const activity = { ...status.activity[parent], ...patch }
  return {
    ...status,
    activity: { ...status.activity, [parent]: activity },
    agents: status.agents.map((agent) => (agent.id === parent ? { ...agent, ...activity } : agent))
  }
}

export function reduceStatus(
  status: TerminalStatus,
  event: SessionEvent,
  now: number = Date.now()
): TerminalStatus {
  switch (event.type) {
    case 'tool_call': {
      if (event.parent)
        // A subagent at work: what it did last, and how much it has done.
        return noteActivity(status, event.parent, {
          lastAction: actionOf(event.name, event.input),
          lastActiveAt: now,
          toolCount: (status.activity[event.parent]?.toolCount ?? 0) + 1
        })
      if (!isAgentTool(event.name) || status.agents.some((a) => a.id === event.id)) return status
      const input = record(event.input)
      const agent: SubAgent = {
        id: event.id,
        taskId: null,
        type: text(input.subagent_type) || 'agent',
        description: text(input.description),
        background: input.run_in_background === true,
        startedAt: now,
        lastAction: null,
        lastActiveAt: now,
        toolCount: 0,
        contextUsed: null,
        model: text(input.model) || null
      }
      return { ...status, agents: [...status.agents, withActivity(agent, status)] }
    }
    case 'tool_result': {
      const agent = status.agents.find((a) => a.id === event.id)
      // A background agent's call answers at once ("running in background");
      // it stays until the background list drops it.
      if (!agent || agent.background) return status
      return { ...status, agents: status.agents.filter((a) => a.id !== event.id) }
    }
    case 'background_tasks': {
      const running = event.tasks.filter((task) => task.kind === 'agent')
      const byId = new Map(status.agents.map((agent) => [agent.id, agent]))
      const background = running.map((task) =>
        withActivity(fromBackground(task, byId.get(task.toolUseId ?? task.id)), status)
      )
      const ids = new Set(background.map((agent) => agent.id))
      return {
        ...status,
        agents: [
          ...status.agents.filter((agent) => !agent.background && !ids.has(agent.id)),
          ...background
        ]
      }
    }
    case 'context_usage':
      if (event.parent)
        return noteActivity(status, event.parent, { contextUsed: event.used, lastActiveAt: now })
      return {
        ...status,
        contextUsed: event.used,
        contextWindow: event.window ?? status.contextWindow
      }
    case 'subagent_model':
      return noteActivity(status, event.parent, { model: event.model })
    case 'state_change':
      // Nothing the turn waited on outlives it; background agents stay listed
      // by their own event.
      if (event.state === 'done')
        return { ...status, agents: status.agents.filter((agent) => agent.background) }
      return event.state === 'ended' ? { ...status, agents: [] } : status
    case 'turn_interrupted':
      return { ...status, agents: status.agents.filter((agent) => agent.background) }
    default:
      return status
  }
}

/** "12k", "1M": the status line's own compact count. */
export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}

/** What the reader's relaunch says to the conversation: which agent was
 *  stopped and on which model to launch it again. Sent as the reader's own
 *  message, so the transcript shows what was asked. */
export const relaunchRequest = (agent: SubAgent, alias: string): string =>
  `I stopped the subagent “${agent.description || agent.type}” (${agent.type}) to run it on ${claudeModelName(alias) ?? alias}. ` +
  `Launch it again with the Agent tool: same subagent_type, same prompt, model "${alias}". Nothing else changes.`

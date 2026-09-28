import type { BackgroundTask, SessionEvent } from '../../../src/shared/session-model'
import { describeToolHead } from './tools'

/** The Terminal view's status line, read off the same session stream the
 *  transcript is: how full the context is (`context_usage`), and the subagents
 *  running now, followed through the `parent` a subagent's own tool calls
 *  carry. A provider that sends neither leaves the line empty. The provider's
 *  raw frames never reach a window (sessions/ipc.ts), so nothing here reads
 *  them. */
export interface SubAgent {
  /** The tool call that started it: a subagent's frames name it as their parent. */
  id: string
  /** What the agent is (`general-purpose`, `Explore`, …), as the call asked. */
  type: string
  description: string
  background: boolean
  startedAt: number
  /** What it did last, as the transcript would name the call; null until it acts. */
  lastAction: string | null
  toolCount: number
}
export interface TerminalStatus {
  /** Tokens in the main conversation's context after its last call. */
  contextUsed: number | null
  /** The model's context window, once a turn's result has named it. */
  contextWindow: number | null
  agents: SubAgent[]
  /** Activity seen for a parent before the agent itself was known. */
  activity: Record<string, { lastAction: string; toolCount: number }>
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
    type: known?.type ?? 'agent',
    description: task.description || known?.description || '',
    background: true,
    startedAt: known?.startedAt ?? task.startedAt,
    lastAction: known?.lastAction ?? null,
    toolCount: known?.toolCount ?? 0
  }
}

export function reduceStatus(
  status: TerminalStatus,
  event: SessionEvent,
  now: number = Date.now()
): TerminalStatus {
  switch (event.type) {
    case 'tool_call': {
      if (event.parent) {
        // A subagent at work: what it did last, and how much it has done.
        const previous = status.activity[event.parent]
        const activity = {
          lastAction: actionOf(event.name, event.input),
          toolCount: (previous?.toolCount ?? 0) + 1
        }
        return {
          ...status,
          activity: { ...status.activity, [event.parent]: activity },
          agents: status.agents.map((agent) =>
            agent.id === event.parent ? { ...agent, ...activity } : agent
          )
        }
      }
      if (!isAgentTool(event.name) || status.agents.some((a) => a.id === event.id)) return status
      const input = record(event.input)
      const agent: SubAgent = {
        id: event.id,
        type: text(input.subagent_type) || 'agent',
        description: text(input.description),
        background: input.run_in_background === true,
        startedAt: now,
        lastAction: null,
        toolCount: 0
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
      return {
        ...status,
        contextUsed: event.used,
        contextWindow: event.window ?? status.contextWindow
      }
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

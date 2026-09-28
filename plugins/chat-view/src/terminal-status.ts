import type { BackgroundTask, SessionEvent } from '../../../src/shared/session-model'
import { describeToolHead } from './tools'

/** The Terminal view's status line, read off the same session stream the
 *  transcript is: how full the context is, and the subagents running now.
 *  Both come from the provider's own frames, which the Claude adapter keeps on
 *  the stream as `provider_event`: an assistant frame carries the usage of the
 *  call that produced it and, for a subagent's turn, the `parent_tool_use_id`
 *  of the call that started the subagent; the result frame names the model's
 *  context window. A provider that sends none of these leaves the line empty. */
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
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

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

function providerFrame(status: TerminalStatus, payload: unknown): TerminalStatus {
  const frame = record(payload)
  if (frame.type === 'assistant') {
    const message = record(frame.message)
    const parent = text(frame.parent_tool_use_id)
    if (!parent) {
      // The main thread's context is what its last call read plus what it wrote.
      const usage = record(message.usage)
      const used =
        count(usage.input_tokens) +
        count(usage.cache_read_input_tokens) +
        count(usage.cache_creation_input_tokens) +
        count(usage.output_tokens)
      return used > 0 ? { ...status, contextUsed: used } : status
    }
    const calls = Array.isArray(message.content)
      ? message.content.map(record).filter((block) => block.type === 'tool_use')
      : []
    if (!calls.length) return status
    const last = calls[calls.length - 1]
    const previous = status.activity[parent]
    const activity = {
      lastAction: actionOf(text(last.name), last.input),
      toolCount: (previous?.toolCount ?? 0) + calls.length
    }
    return {
      ...status,
      activity: { ...status.activity, [parent]: activity },
      agents: status.agents.map((agent) =>
        agent.id === parent ? { ...agent, ...activity } : agent
      )
    }
  }
  if (frame.type === 'result') {
    // The window is the model's; several models answer in one turn when
    // subagents run on another, and the main one is the widest of them.
    const windows = Object.values(record(frame.modelUsage)).map((usage) =>
      count(record(usage).contextWindow)
    )
    const widest = Math.max(0, ...windows)
    // Nothing the turn waited on outlives it; background agents stay listed
    // by their own event.
    return {
      ...status,
      contextWindow: widest || status.contextWindow,
      agents: status.agents.filter((agent) => agent.background)
    }
  }
  return status
}

export function reduceStatus(
  status: TerminalStatus,
  event: SessionEvent,
  now: number = Date.now()
): TerminalStatus {
  switch (event.type) {
    case 'tool_call': {
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
    case 'turn_interrupted':
      return { ...status, agents: status.agents.filter((agent) => agent.background) }
    case 'state_change':
      return event.state === 'ended' ? { ...status, agents: [] } : status
    case 'provider_event':
      return providerFrame(status, event.payload)
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

/**
 * The Codex writer: lays a conversation down as a Codex 0.167 thread so
 * `codex resume <id>` (or `thread/resume` over the app-server) opens it.
 *
 * What is written is ONE rollout file,
 * `<codexHome>/sessions/YYYY/MM/DD/rollout-<started>-<thread id>.jsonl`, in
 * the paginated history mode of 0.167 (an `ordinal` on every row), carrying
 * both tapes: the `response_item` rows the model is shown again, and the
 * `event_msg` rows the person sees as history. Nothing else: Codex rebuilds
 * its SQLite indexes (`state_5.sqlite`, `thread_history_1.sqlite`) from a scan
 * of `sessions/` on its next start, which was proven on a fresh home with no
 * credential (docs/formats/codex-0.167.md). The shapes come from the Codex
 * 0.167.0 source (`codex-rs/protocol/src/{items,protocol,models}.rs`) and
 * were checked by resuming written files through the real CLI.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { uuidv7 } from '../ids.ts'
import {
  SUPPORTED,
  UnsupportedVersionError,
  codexVersion,
  versionSupported
} from '../codex/version.ts'
import {
  object,
  text,
  type HistoryItem,
  type Session,
  type ToolCall,
  type ToolResult
} from '../ir.ts'

export interface CodexRolloutOptions {
  /** The thread id to mint; a fresh UUIDv7 by default. */
  threadId?: string
  /** The working directory the thread is recorded in; the session's by default. */
  cwd?: string
  /** The model named in the thread's turn context (Codex shows it as the
   *  thread's model until a resume names another). */
  model?: string
  /** The Codex version recorded as the file's writer (`cli_version`). */
  cliVersion?: string
  /** Prefix the first message with a note that the conversation was converted
   *  (its provider, model and date). On by default. */
  header?: boolean
  /** The clock for rows the tape does not date. */
  now?: () => number
}

/** One line of the rollout file, as Codex reads it. */
export interface RolloutRow {
  timestamp: string
  ordinal: number
  type: 'session_meta' | 'event_msg' | 'turn_context' | 'response_item'
  payload: Record<string, unknown>
}

export interface CodexRollout {
  threadId: string
  /** `sessions/YYYY/MM/DD/rollout-<started>-<id>.jsonl`, relative to the home. */
  relativePath: string
  rows: RolloutRow[]
  turns: number
  /** Events the writer left out, by reason, for the record. */
  dropped: { subagent: number; unmatchedResult: number; beforeFirstMessage: number }
}

const iso = (ms: number): string => new Date(ms).toISOString()
const pad = (n: number): string => String(n).padStart(2, '0')
/** Codex names the file and its day folder in the machine's local time. */
function localStamp(ms: number): { dir: string; stamp: string } {
  const d = new Date(ms)
  const day = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  return { dir: day, stamp }
}

/** A tool's output as one string, however the provider recorded it. */
export function outputText(output: unknown): string {
  if (output === undefined || output === null) return ''
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    const texts = output.map((block) => {
      const b = object(block)
      if (typeof b.text === 'string') return b.text
      if (b.type === 'image' || b.type === 'input_image') return '[Image]'
      return JSON.stringify(block)
    })
    return texts.join('\n')
  }
  return JSON.stringify(output)
}

interface Call {
  call: ToolCall
  result: ToolResult | null
}

/** The item Codex shows for a call the agent made in another CLI: its own
 *  item kinds where the gesture matches (a command, a file change), an MCP
 *  tool call under the source's name everywhere else, so the TUI renders it
 *  as history without a tool of its own matching. */
export function codexItemFor(call: Call, cwd: string): Record<string, unknown> {
  const input = object(call.call.input)
  const result = call.result
  const failed = result === null || result.error === true
  const output = result ? outputText(result.output) : ''
  const name = call.call.name
  if (name === 'Bash' || name === 'commandExecution') {
    const command =
      name === 'commandExecution' && Array.isArray(input.command)
        ? input.command.map(String)
        : ['bash', '-lc', text(input.command)]
    const exit =
      typeof input.exit_code === 'number' ? input.exit_code : result ? (failed ? 1 : 0) : null
    return {
      type: 'CommandExecution',
      id: call.call.id,
      command,
      cwd: pathToFileURL(text(input.cwd) || cwd).href,
      parsed_cmd: [],
      source: 'agent',
      status: failed ? 'failed' : 'completed',
      ...(result ? { aggregated_output: output } : {}),
      ...(exit !== null ? { exit_code: exit } : {})
    }
  }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'fileChange'].includes(name)) {
    const changes: Record<string, unknown> = {}
    if (name === 'fileChange' && input.changes && typeof input.changes === 'object') {
      Object.assign(changes, input.changes)
    } else {
      const path = text(input.file_path) || text(input.notebook_path) || '(unknown file)'
      if (name === 'Write') changes[path] = { type: 'add', content: text(input.content) }
      else if (name === 'MultiEdit' && Array.isArray(input.edits))
        changes[path] = {
          type: 'update',
          unified_diff: input.edits
            .map(object)
            .map((e) => `-${text(e.old_string)}\n+${text(e.new_string)}`)
            .join('\n'),
          move_path: null
        }
      else
        changes[path] = {
          type: 'update',
          unified_diff: `-${text(input.old_string)}\n+${text(input.new_string) || text(input.new_source)}`,
          move_path: null
        }
    }
    return {
      type: 'FileChange',
      id: call.call.id,
      changes,
      status: failed ? 'failed' : 'completed',
      ...(output ? { stdout: output } : {})
    }
  }
  const mcp = /^mcp__([^_].*?)__(.+)$/.exec(name)
  const slash = !mcp && name.includes('/') ? name.split('/') : null
  const server = mcp ? mcp[1] : slash ? slash[0] : 'claude-code'
  const tool = mcp ? mcp[2] : slash ? slash.slice(1).join('/') : name
  return {
    type: 'McpToolCall',
    id: call.call.id,
    server,
    tool,
    arguments: call.call.input ?? {},
    status: failed ? 'failed' : 'completed',
    ...(result && !failed
      ? { result: { content: [{ type: 'text', text: output }] } }
      : {
          error: {
            message: result
              ? output || 'The tool reported an error'
              : 'No result was recorded for this call'
          }
        })
  }
}

/** The header the first message carries, so the model and the person both
 *  know where the conversation came from. */
export function conversionHeader(session: Session, when: number): string {
  const date = new Date(when).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })
  const provider = session.head.provider === 'claude' ? 'Claude Code' : 'Codex'
  const model = session.head.model ? `, model ${session.head.model}` : ''
  return `[This conversation was converted from ${provider}${model}, on ${date}, by @clave/session-bridge. The tool calls below ran in ${provider}'s own tools.]`
}

/** The rows of a rollout for a session: pure, nothing touches the disk. */
export function codexRollout(session: Session, options: CodexRolloutOptions = {}): CodexRollout {
  const now = options.now ?? Date.now
  const threadId = options.threadId ?? uuidv7(now())
  const cwd = options.cwd ?? session.head.cwd
  const model = options.model ?? 'gpt-5'
  const started = session.head.startedAt ?? session.items.find((i) => i.at)?.at ?? now()
  const rows: RolloutRow[] = []
  let clock = started
  const push = (type: RolloutRow['type'], payload: Record<string, unknown>, at?: number): void => {
    if (at !== undefined && Number.isFinite(at)) clock = Math.max(clock, at)
    rows.push({ timestamp: iso(clock), ordinal: rows.length, type, payload })
  }
  push('session_meta', {
    id: threadId,
    session_id: threadId,
    timestamp: iso(started),
    cwd,
    runtime_workspace_roots: [cwd],
    originator: 'session_bridge',
    cli_version: options.cliVersion ?? '0.167.0',
    source: 'cli',
    model_provider: 'openai',
    history_mode: 'paginated'
  })

  // Turns: one per message of the person. Subagent events (`parent`) are
  // another thread's; a result whose call was never seen has no home.
  const dropped = { subagent: 0, unmatchedResult: 0, beforeFirstMessage: 0 }
  type Turn = { at: number; items: HistoryItem[]; interrupted: boolean }
  const turns: Turn[] = []
  for (const item of session.items) {
    const event = item.event
    if ('parent' in event && event.parent) {
      dropped.subagent++
      continue
    }
    if (event.type === 'user_message')
      turns.push({ at: item.at ?? clock, items: [item], interrupted: false })
    else if (!turns.length) {
      if (event.type !== 'session_meta' && event.type !== 'context_usage')
        dropped.beforeFirstMessage++
    } else if (event.type === 'turn_interrupted') turns[turns.length - 1].interrupted = true
    else turns[turns.length - 1].items.push(item)
  }

  let first = true
  for (const turn of turns) {
    const turnId = uuidv7(turn.at)
    const seconds = (ms: number): number => Math.floor(ms / 1000)
    push(
      'event_msg',
      {
        type: 'task_started',
        turn_id: turnId,
        root_turn_id: turnId,
        started_at: seconds(turn.at),
        collaboration_mode_kind: 'default'
      },
      turn.at
    )
    push('turn_context', {
      turn_id: turnId,
      root_turn_id: turnId,
      cwd,
      approval_policy: 'on-request',
      approvals_reviewer: 'user',
      sandbox_policy: { type: 'workspace-write' },
      model,
      summary: 'auto'
    })
    const done = (item: Record<string, unknown>, at: number): void =>
      push(
        'event_msg',
        {
          type: 'item_completed',
          thread_id: threadId,
          turn_id: turnId,
          item,
          started_at_ms: at,
          completed_at_ms: at
        },
        at
      )
    // Calls are paired with their results before anything is written: the
    // model tape must never hold a call without its output.
    const calls = new Map<string, Call>()
    for (const { event } of turn.items)
      if (event.type === 'tool_call') calls.set(event.id, { call: event, result: null })
    for (const { event } of turn.items)
      if (event.type === 'tool_result') {
        const call = calls.get(event.id)
        // A result with no output is the reader's closing of a call the
        // transcript never answered: no result, not an empty one.
        if (call) call.result = event.output === undefined ? null : event
        else dropped.unmatchedResult++
      }
    const assistantTexts = turn.items.filter((i) => i.event.type === 'assistant_text')
    let lastAgentMessage = ''
    let n = 0
    for (const item of turn.items) {
      const at = item.at ?? clock
      const event = item.event
      if (event.type === 'user_message') {
        const body =
          first && options.header !== false
            ? `${conversionHeader(session, now())}\n\n${event.text}`
            : event.text
        first = false
        const id = `${turnId}-u${n++}`
        push(
          'response_item',
          {
            type: 'message',
            id: `msg_${id}`,
            role: 'user',
            content: [{ type: 'input_text', text: body }]
          },
          at
        )
        done(
          { type: 'UserMessage', id, content: [{ type: 'text', text: body, text_elements: [] }] },
          at
        )
      } else if (event.type === 'assistant_text') {
        if (!event.delta.trim()) continue
        const id = `msg_${turnId}-a${n++}`
        const phase =
          item === assistantTexts[assistantTexts.length - 1] ? 'final_answer' : 'commentary'
        lastAgentMessage = event.delta
        push(
          'response_item',
          {
            type: 'message',
            id,
            role: 'assistant',
            content: [{ type: 'output_text', text: event.delta }],
            phase
          },
          at
        )
        done(
          { type: 'AgentMessage', id, content: [{ type: 'Text', text: event.delta }], phase },
          at
        )
      } else if (event.type === 'tool_call') {
        const call = calls.get(event.id)!
        const argumentsText =
          typeof event.input === 'string' ? event.input : JSON.stringify(event.input ?? {})
        push(
          'response_item',
          {
            type: 'function_call',
            id: `fc_${event.id}`,
            name: event.name,
            arguments: argumentsText,
            call_id: event.id
          },
          at
        )
        const resultAt = call.result
          ? (turn.items.find((i) => i.event === call.result)?.at ?? at)
          : at
        push(
          'response_item',
          {
            type: 'function_call_output',
            call_id: event.id,
            output: call.result
              ? outputText(call.result.output) || '(empty output)'
              : '(no result was recorded for this call before the conversation moved on)'
          },
          resultAt
        )
        done(codexItemFor(call, cwd), resultAt)
      }
      // tool_result rows are written beside their call; session_meta and
      // context_usage are the source provider's own accounting.
    }
    if (turn.interrupted)
      push('event_msg', {
        type: 'turn_aborted',
        turn_id: turnId,
        reason: 'interrupted',
        started_at: seconds(turn.at),
        completed_at: seconds(clock)
      })
    else
      push('event_msg', {
        type: 'task_complete',
        turn_id: turnId,
        root_turn_id: turnId,
        last_agent_message: lastAgentMessage,
        started_at: seconds(turn.at),
        completed_at: seconds(clock),
        duration_ms: Math.max(0, clock - turn.at)
      })
  }
  const { dir, stamp } = localStamp(started)
  return {
    threadId,
    relativePath: join('sessions', dir, `rollout-${stamp}-${threadId}.jsonl`),
    rows,
    turns: turns.length,
    dropped
  }
}

export interface WriteCodexOptions extends CodexRolloutOptions {
  /** The Codex home to write under. Required: a writer never guesses whose
   *  history it is adding to. */
  codexHome: string
  /** The `codex` executable whose version is checked first; `codex` by default. */
  bin?: string
  /** The version to take as verified instead of running `codex --version`
   *  (tests); the pin still applies to it. */
  codexVersion?: string
}

export interface WrittenThread extends CodexRollout {
  path: string
  codexHome: string
  codexVersion: string
}

/** Write the thread. Refuses before touching the disk when the installed
 *  Codex is not a version this writer was verified on, when the session has
 *  no message to write, and when the file already exists. */
export async function writeCodex(
  session: Session,
  options: WriteCodexOptions
): Promise<WrittenThread> {
  const version = options.codexVersion ?? (await codexVersion(options.bin))
  if (!versionSupported(version, SUPPORTED.codex))
    throw new UnsupportedVersionError('codex', version, SUPPORTED.codex)
  const rollout = codexRollout(session, { ...options, cliVersion: options.cliVersion ?? version })
  if (!rollout.turns)
    throw new Error('The session holds no message of the person: nothing to write')
  const path = join(options.codexHome, rollout.relativePath)
  if (existsSync(path)) throw new Error(`Refusing to overwrite an existing thread: ${path}`)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.session-bridge-${process.pid}.tmp`
  writeFileSync(tmp, rollout.rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  renameSync(tmp, path)
  return { ...rollout, path, codexHome: options.codexHome, codexVersion: version }
}

/** The rows of a written file, read back (for a check or a test). */
export function readRolloutRows(path: string): RolloutRow[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RolloutRow)
}

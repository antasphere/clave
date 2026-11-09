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
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
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
  /** The thread id to mint; by default a UUIDv7 dated at the conversation's
   *  start, so the id, the file name and the day folder agree. */
  threadId?: string
  /** The working directory the thread is recorded in; the session's by
   *  default. Codex refuses to restore a relative one, so must be absolute. */
  cwd?: string
  /** The model named in the thread's turn context (Codex shows it as the
   *  thread's model until a resume names another). `writeCodex` reads the
   *  home's `config.toml` for it when the option is absent; `gpt-5` last. */
  model?: string
  /** The Codex version recorded as the file's writer (`cli_version`). */
  cliVersion?: string
  /** Prefix the first message with a note that the conversation was converted
   *  (its provider, model and date). On by default. */
  header?: boolean
  /** The clock for the header's date and for rows the tape does not date. */
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
export function localStamp(ms: number): { dir: string; stamp: string } {
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

/** The smallest unified diff that says what was replaced: the old lines
 *  removed, the new lines added, one hunk. */
export function unifiedDiff(oldText: string, newText: string): string {
  const oldLines = oldText === '' ? [] : oldText.replace(/\n$/, '').split('\n')
  const newLines = newText === '' ? [] : newText.replace(/\n$/, '').split('\n')
  return [
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`)
  ].join('\n')
}

/** A function name as the model's API takes it: letters, digits, `_` and
 *  `-`, 64 characters at most. Claude's `mcp__server__tool` names can exceed
 *  that; the item the person sees keeps the full name. */
export function modelToolName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, '_')
  return (safe || 'tool').slice(0, 64)
}

interface Call {
  call: ToolCall
  result: ToolResult | null
  /** When the result landed, when the tape says. */
  resultAt?: number
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
      if (name === 'Write') {
        // Claude's Write answers "File created successfully" or "… has been
        // updated successfully": the second overwrote a file.
        const content = text(input.content)
        changes[path] = /updated/i.test(output)
          ? { type: 'update', unified_diff: unifiedDiff('', content), move_path: null }
          : { type: 'add', content }
      } else if (name === 'MultiEdit' && Array.isArray(input.edits))
        changes[path] = {
          type: 'update',
          unified_diff: input.edits
            .map(object)
            .map((e) => unifiedDiff(text(e.old_string), text(e.new_string)))
            .join('\n'),
          move_path: null
        }
      else
        changes[path] = {
          type: 'update',
          unified_diff: unifiedDiff(
            text(input.old_string),
            text(input.new_string) || text(input.new_source)
          ),
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
  const cwd = options.cwd ?? session.head.cwd
  if (!isAbsolute(cwd))
    throw new Error(`The thread's cwd must be absolute, Codex refuses to restore "${cwd}"`)
  const model = options.model ?? 'gpt-5'
  const started = session.head.startedAt ?? session.items.find((i) => i.at)?.at ?? now()
  const threadId = options.threadId ?? uuidv7(started)
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

  // Subagent events (`parent`) are another thread's. Calls are paired with
  // their results over the WHOLE tape before anything is written: a result
  // that landed after the person's next message belongs beside its call, and
  // the model tape must never hold a call without its output. A result whose
  // output is undefined is the reader's closing of an unanswered call, not a
  // result; a real one later overrides it.
  const dropped = { subagent: 0, unmatchedResult: 0, beforeFirstMessage: 0 }
  const conversation = session.items.filter((item) => {
    if ('parent' in item.event && item.event.parent) {
      dropped.subagent++
      return false
    }
    return true
  })
  const calls = new Map<string, Call>()
  for (const { event } of conversation)
    if (event.type === 'tool_call') calls.set(event.id, { call: event, result: null })
  for (const { event, at } of conversation)
    if (event.type === 'tool_result') {
      const call = calls.get(event.id)
      if (!call) dropped.unmatchedResult++
      else if (event.output !== undefined || call.result === null) {
        call.result = event.output === undefined ? null : event
        if (event.output !== undefined) call.resultAt = at
      }
    }

  // Turns: one per message of the person.
  type Turn = { at: number; items: HistoryItem[]; interruptedAt: number | null }
  const turns: Turn[] = []
  for (const item of conversation) {
    const event = item.event
    if (event.type === 'user_message')
      turns.push({ at: item.at ?? clock, items: [item], interruptedAt: null })
    else if (!turns.length) {
      if (!['session_meta', 'context_usage', 'tool_result'].includes(event.type))
        dropped.beforeFirstMessage++
    } else if (event.type === 'turn_interrupted')
      turns[turns.length - 1].interruptedAt = item.at ?? clock
    else if (event.type !== 'tool_result') turns[turns.length - 1].items.push(item)
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
            name: modelToolName(event.name),
            arguments: argumentsText,
            call_id: event.id
          },
          at
        )
        const resultAt = call.resultAt ?? at
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
      // session_meta and context_usage are the source provider's own accounting.
    }
    if (turn.interruptedAt !== null)
      push(
        'event_msg',
        {
          type: 'turn_aborted',
          turn_id: turnId,
          reason: 'interrupted',
          started_at: seconds(turn.at),
          completed_at: seconds(turn.interruptedAt)
        },
        turn.interruptedAt
      )
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

/** The model the home's `config.toml` names at its top level (`model = "…"` or
 *  `model = '…'`, before the first `[table]`), or null: the one TOML key this
 *  package reads, by a line match. */
export function codexConfigModel(codexHome: string): string | null {
  let toml: string
  try {
    toml = readFileSync(join(codexHome, 'config.toml'), 'utf8')
  } catch {
    return null
  }
  for (const line of toml.split('\n')) {
    if (/^\s*\[/.test(line)) break
    // A TOML basic string ("…") or literal string ('…').
    const match = /^\s*model\s*=\s*(["'])([^"']+)\1/.exec(line)
    if (match) return match[2]
  }
  return null
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
  const rollout = codexRollout(session, {
    ...options,
    model: options.model ?? codexConfigModel(options.codexHome) ?? undefined,
    cliVersion: options.cliVersion ?? version
  })
  if (!rollout.turns)
    throw new Error('The session holds no message of the person: nothing to write')
  const path = join(options.codexHome, rollout.relativePath)
  if (existsSync(path)) throw new Error(`Refusing to overwrite an existing thread: ${path}`)
  mkdirSync(dirname(path), { recursive: true })
  // Written whole beside its final name, then linked into place: a link
  // refuses an existing target, so two writers cannot overwrite each other,
  // and a failure leaves no half file behind.
  const tmp = `${path}.session-bridge-${process.pid}.tmp`
  try {
    writeFileSync(tmp, rollout.rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
    linkSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // Nothing to remove.
    }
    throw error instanceof Error && 'code' in error && error.code === 'EEXIST'
      ? new Error(`Refusing to overwrite an existing thread: ${path}`)
      : error
  }
  unlinkSync(tmp)
  return { ...rollout, path, codexHome: options.codexHome, codexVersion: version }
}

/** The rows of a written file, read back (for a check or a test). */
export function readRolloutRows(path: string): RolloutRow[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RolloutRow)
}

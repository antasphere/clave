/**
 * The command line:
 *
 *   session-bridge convert --from claude --to codex <id or transcript path> [--cwd <dir>]
 *                          [--codex-home <dir>] [--claude-config-dir <dir>] [--model <codex model>]
 *                          [--no-header] [--json]
 *   session-bridge inspect <file> [--json]
 *   session-bridge verify <thread id> [--codex-home <dir>] [--json]
 *
 * `convert` reads the conversation, checks the installed Codex against the
 * pin, writes the thread and prints the `codex resume` to run. `inspect` says
 * what a file is and what its tape holds. `verify` reads a thread back through
 * the real Codex on the given home (`thread/read`, which appends nothing and
 * moves nothing) and prints what came back.
 */
import { parseArgs } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { findClaudeTranscript, readClaude } from './readers/claude.ts'
import { defaultCodexHome, readCodex } from './readers/codex.ts'
import { writeCodex } from './writers/codex.ts'
import { readThread } from './codex/app-server.ts'
import { UnsupportedVersionError } from './codex/version.ts'
import { UnrecognisedTranscriptError, object, type Session } from './ir.ts'

const USAGE = `session-bridge: carry a coding-agent conversation from one CLI to another

  session-bridge convert --from claude --to codex <id or transcript path> [--cwd <dir>]
                         [--codex-home <dir>] [--claude-config-dir <dir>] [--model <codex model>]
                         [--no-header] [--json]
  session-bridge inspect <file> [--json]
  session-bridge verify <thread id> [--codex-home <dir>] [--json]
`

export interface CliIo {
  out(line: string): void
  err(line: string): void
}

/** What a file is, read off its own rows: a Codex rollout opens with a
 *  session_meta row, a Claude transcript holds user or assistant rows. */
export function detectProvider(path: string): 'claude' | 'codex' | null {
  const head = readFileSync(path, 'utf8').split('\n', 50)
  for (const line of head) {
    let row: Record<string, unknown>
    try {
      row = object(JSON.parse(line))
    } catch {
      continue
    }
    if (row.type === 'session_meta' && 'payload' in row) return 'codex'
    if ((row.type === 'user' || row.type === 'assistant') && 'message' in row) return 'claude'
  }
  return null
}

function summary(session: Session): Record<string, unknown> {
  const counts: Record<string, number> = {}
  for (const { event } of session.items) counts[event.type] = (counts[event.type] ?? 0) + 1
  return { head: session.head, events: counts, items: session.items.length }
}

export async function main(
  argv: string[],
  io: CliIo = { out: console.log, err: console.error }
): Promise<number> {
  const [command, ...rest] = argv
  try {
    if (command === 'convert') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          from: { type: 'string' },
          to: { type: 'string' },
          cwd: { type: 'string' },
          'codex-home': { type: 'string' },
          'claude-config-dir': { type: 'string' },
          model: { type: 'string' },
          'no-header': { type: 'boolean' },
          json: { type: 'boolean' }
        }
      })
      const ref = positionals[0]
      if (!ref || values.from !== 'claude' || values.to !== 'codex') {
        io.err(USAGE)
        io.err(
          'convert supports --from claude --to codex today; the Claude writer is not built yet.'
        )
        return 2
      }
      const cwd = values.cwd === undefined ? undefined : resolve(values.cwd)
      const path = existsSync(ref)
        ? ref
        : findClaudeTranscript(ref, cwd ?? process.cwd(), values['claude-config-dir'])
      if (!path) {
        io.err(
          `No Claude transcript found for ${ref} (looked under ${values['claude-config-dir'] ?? '~/.claude'}/projects).`
        )
        return 1
      }
      const session = readClaude(path)
      const written = await writeCodex(session, {
        codexHome: values['codex-home'] ?? defaultCodexHome(),
        cwd: cwd ?? session.head.cwd,
        model: values.model,
        header: !values['no-header']
      })
      if (values.json) io.out(JSON.stringify({ ...written, rows: written.rows.length }, null, 2))
      else {
        io.out(`Wrote ${written.rows.length} rows, ${written.turns} turn(s), to ${written.path}`)
        if (
          written.dropped.subagent ||
          written.dropped.unmatchedResult ||
          written.dropped.beforeFirstMessage
        )
          io.out(`Left out: ${JSON.stringify(written.dropped)}`)
        io.out(`Resume it with: codex resume ${written.threadId}`)
        if (written.codexHome !== defaultCodexHome())
          io.out(`  (with CODEX_HOME=${written.codexHome})`)
      }
      return 0
    }
    if (command === 'inspect') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { json: { type: 'boolean' }, 'codex-home': { type: 'string' } }
      })
      const path = positionals[0]
      if (!path || !existsSync(path)) {
        io.err(USAGE)
        return 2
      }
      const provider = detectProvider(path)
      if (!provider) {
        io.err(
          `${path}: neither a Claude transcript nor a Codex rollout, as far as the readers know.`
        )
        return 1
      }
      const session =
        provider === 'claude' ? readClaude(path) : readCodex(path, values['codex-home'])
      if (values.json) io.out(JSON.stringify(summary(session), null, 2))
      else {
        const s = summary(session)
        io.out(`${provider} session ${session.head.id} in ${session.head.cwd}`)
        io.out(
          `model ${session.head.model ?? '?'} · cli ${session.head.cliVersion ?? '?'} · ${session.items.length} events`
        )
        io.out(JSON.stringify(s.events))
        for (const { event } of session.items.slice(0, 12)) {
          const line =
            event.type === 'user_message'
              ? `> ${event.text}`
              : event.type === 'assistant_text'
                ? `< ${event.delta}`
                : event.type === 'tool_call'
                  ? `[call ${event.name} ${event.id}]`
                  : event.type === 'tool_result'
                    ? `[result ${event.id}${event.error ? ' error' : ''}]`
                    : `[${event.type}]`
          io.out(line.length > 120 ? `${line.slice(0, 117)}...` : line)
        }
        if (session.items.length > 12) io.out(`... ${session.items.length - 12} more`)
      }
      return 0
    }
    if (command === 'verify') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          json: { type: 'boolean' },
          'codex-home': { type: 'string' },
          cwd: { type: 'string' }
        }
      })
      const threadId = positionals[0]
      if (!threadId) {
        io.err(USAGE)
        return 2
      }
      const thread = await readThread(threadId, {
        codexHome: values['codex-home'] ?? defaultCodexHome(),
        ...(values.cwd ? { cwd: resolve(values.cwd) } : {})
      })
      if (values.json) io.out(JSON.stringify(thread, null, 2))
      else {
        io.out(
          `thread ${thread.id} · ${thread.historyMode} · model ${thread.model ?? '?'} · ${thread.turns.length} turn(s)`
        )
        for (const turn of thread.turns)
          io.out(
            `  turn ${turn.id} ${turn.status}: ${turn.items.map((i) => String(i.type)).join(', ')}`
          )
      }
      return 0
    }
    io.err(USAGE)
    return command === '--help' || command === '-h' || command === undefined ? 0 : 2
  } catch (error) {
    if (error instanceof UnsupportedVersionError || error instanceof UnrecognisedTranscriptError) {
      io.err(error.message)
      return 3
    }
    io.err(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (process.argv[1] && /[\\/]cli\.ts$/.test(process.argv[1]))
  main(process.argv.slice(2)).then((code) => process.exit(code))

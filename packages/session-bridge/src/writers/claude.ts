/**
 * The Claude writer: not built yet. Its place is here so the package's shape
 * is symmetric once it is.
 *
 * What it will write, from the format notes in docs/formats/claude-code.md:
 * `~/.claude/projects/<cwd, dashed>/<id>.jsonl`, one row per line, each
 * `type: "user"` or `type: "assistant"` with `uuid`, `parentUuid` (the chain),
 * `sessionId`, `cwd`, `timestamp`, `version` and an Anthropic `message`
 * (`role`, `content` as blocks: `text`, `tool_use` with `id`/`name`/`input`,
 * `tool_result` with `tool_use_id`/`content`/`is_error`). Claude Code resumes
 * the file with `claude --resume <id>` from the same cwd. Open questions
 * before writing it: whether the CLI accepts a `tool_use` whose name is not one
 * of its tools, and whether the `usage` blocks may be absent.
 */
import type { Session } from '../ir.ts'

export interface WriteClaudeOptions {
  configDir: string
}

export function writeClaude(session: Session, options: WriteClaudeOptions): never {
  throw new Error(
    `The Claude writer is not built yet (see writers/claude.ts for the format notes); nothing written for ${session.head.provider} session ${session.head.id} under ${options.configDir}`
  )
}

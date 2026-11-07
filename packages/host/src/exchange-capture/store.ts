import * as fs from 'fs'
import * as path from 'path'
import type { CaptureEvent, WorkstreamEventLine } from './types'

/**
 * Append-only JSONL store for capture events. One JSON object per line, in
 * append order; the file survives app restarts and is never rewritten —
 * durable observability with zero coordination. Unbounded in v1 (no
 * rotation); events are small and lanes send tens of messages, not millions.
 * `exos workstream capture` tails this file with a rotation-tolerant cursor,
 * so a future rotation costs readers nothing.
 *
 * No Electron imports: the directory is injected, so the store is
 * testable outside the app.
 */
export class CaptureStore {
  private readonly file: string
  /** `<claudeSessionId>:<agentId>` of every subagent_spawn already recorded —
   *  the dedup index for lazy sidecar discovery. Loaded from disk once. */
  private seenSubagents: Set<string> | null = null

  constructor(dir: string) {
    this.file = path.join(dir, 'events.jsonl')
  }

  filePath(): string {
    return this.file
  }

  append(event: CaptureEvent): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.appendFileSync(this.file, JSON.stringify(event) + '\n', 'utf-8')
    if (event.kind === 'subagent_spawn' && this.seenSubagents) {
      this.seenSubagents.add(subagentKey(event.session.claudeSessionId, event.agentId))
    }
  }

  /** Read every stored line with a `kind` (v1 and v2 alike). Unparseable
   *  lines are counted, never silently dropped. A missing file means nothing
   *  was captured yet. */
  readAll(): { events: WorkstreamEventLine[]; skippedLines: number } {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf-8')
    } catch {
      return { events: [], skippedLines: 0 }
    }
    const events: WorkstreamEventLine[] = []
    let skippedLines = 0
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as WorkstreamEventLine
        if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string') {
          events.push(parsed)
        } else {
          skippedLines++
        }
      } catch {
        skippedLines++
      }
    }
    return { events, skippedLines }
  }

  hasSubagent(claudeSessionId: string | null, agentId: string): boolean {
    if (!this.seenSubagents) {
      this.seenSubagents = new Set()
      for (const event of this.readAll().events) {
        if (event.kind === 'subagent_spawn') {
          const session = event['session'] as { claudeSessionId?: string | null } | undefined
          const id = event['agentId']
          if (typeof id === 'string') {
            this.seenSubagents.add(subagentKey(session?.claudeSessionId ?? null, id))
          }
        }
      }
    }
    return this.seenSubagents.has(subagentKey(claudeSessionId, agentId))
  }
}

function subagentKey(claudeSessionId: string | null, agentId: string): string {
  return `${claudeSessionId ?? '?'}:${agentId}`
}

import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'
import {
  computeUsageSnapshot,
  parseTranscriptLines,
  transcriptProjectDirName
} from './contract/workstream-events'
import type { UsageSnapshot } from './contract/workstream-events'

/**
 * Transcript reading for the exchange capture: the usage snapshot (the
 * contract's §1.4 reader over the files on disk) and Task-sidecar discovery.
 * No Electron imports: everything takes explicit paths, so the logic is
 * testable outside the app against the mirrored contract fixtures.
 *
 * Layout (verified against real files, 2026-08-20/21): root transcript at
 * `~/.claude/projects/<cwd-slug>/<claudeSessionId>.jsonl`; Task-subagent
 * sidecars at `.../<claudeSessionId>/subagents/agent-<agentId>.jsonl`, whose
 * first line is the subagent's launch prompt (a `user` entry). Assistant
 * entries carry per-call `usage` blocks — and ONE streamed API call is stored
 * as several entries (thinking, text, each tool_use) sharing one
 * `message.id` with identical usage, which is why the reader deduplicates by
 * id (the v1 per-entry sum was ~3–5× inflated; verified 44 entries / 8 ids
 * on a live transcript on 2026-08-21).
 */

/** Same encoding as title-generator.ts getJsonlPath and
 *  session-export-handlers.ts encodeProjectDir (both module-private); the
 *  contract pins it as `transcriptProjectDirName`. */
function encodeProjectDir(cwd: string): string {
  return transcriptProjectDirName(cwd)
}

export function rootTranscriptPath(cwd: string, claudeSessionId: string): string {
  return path.join(
    homedir(),
    '.claude',
    'projects',
    encodeProjectDir(cwd),
    `${claudeSessionId}.jsonl`
  )
}

export function subagentsDir(cwd: string, claudeSessionId: string): string {
  return path.join(
    homedir(),
    '.claude',
    'projects',
    encodeProjectDir(cwd),
    claudeSessionId,
    'subagents'
  )
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SidecarInfo {
  agentId: string
  transcriptPath: string
  /** The sidecar's first-line timestamp (spawn time), when present. */
  spawnedAt: string | null
  /** The subagent's launch prompt: the sidecar's first user message. */
  prompt: string | null
}

function textOfContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text as string)
    if (texts.length > 0) return texts.join('\n')
  }
  return null
}

/** List a session's Task-subagent sidecars with spawn time and launch prompt.
 *  A missing subagents dir means no fan-outs — an empty list, not an error. */
export function listSidecars(dir: string): SidecarInfo[] {
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
  } catch {
    return []
  }
  const sidecars: SidecarInfo[] = []
  for (const file of files.sort()) {
    const transcriptPath = path.join(dir, file)
    const agentId = file.slice('agent-'.length, -'.jsonl'.length)
    let spawnedAt: string | null = null
    let prompt: string | null = null
    try {
      const { entries } = parseTranscriptLines(fs.readFileSync(transcriptPath, 'utf-8'))
      const first = entries.find((o: any) => o?.type === 'user') as any
      if (first) {
        spawnedAt = typeof first.timestamp === 'string' ? first.timestamp : null
        prompt = textOfContent(first.message?.content)
      }
    } catch {
      // Unreadable sidecar: still report its existence, with what we have.
    }
    sidecars.push({ agentId, transcriptPath, spawnedAt, prompt })
  }
  return sidecars
}

/**
 * The §1.4 snapshot over the files on disk: the root transcript (throws when
 * missing or unreadable — callers turn that into a loud `*UsageError`) plus
 * every sidecar LISTED (an unreadable one still counts, contributes nothing).
 * Pure reading lives in the mirrored contract; this is the fs glue.
 */
export function computeTokenSnapshot(
  rootPath: string,
  sidecarDir: string,
  computedAt: string = new Date().toISOString()
): UsageSnapshot {
  const root = parseTranscriptLines(fs.readFileSync(rootPath, 'utf-8')).entries
  const sidecars = listSidecars(sidecarDir).map((s) => {
    try {
      return parseTranscriptLines(fs.readFileSync(s.transcriptPath, 'utf-8')).entries
    } catch {
      // Sidecar vanished between listing and reading — count it, sum nothing.
      return null
    }
  })
  return computeUsageSnapshot(root, sidecars, computedAt)
}

/** The snapshot for a Clave session: its cwd + host session id name the files. */
export function computeSessionSnapshot(cwd: string, claudeSessionId: string): UsageSnapshot {
  return computeTokenSnapshot(
    rootTranscriptPath(cwd, claudeSessionId),
    subagentsDir(cwd, claudeSessionId)
  )
}

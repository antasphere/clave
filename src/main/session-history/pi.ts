import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'
import type { PiThinkingLevel } from '../../shared/agent-launch'

export interface PiSessionInfo {
  id: string
  path: string
  cwd: string | null
  firstAt: string | null
  modifiedAt: string | null
  sizeBytes: number
  provider: string | null
  model: string | null
  thinking: PiThinkingLevel | null
  firstUserText: string | null
  lastUserText: string | null
}

const READ_LIMIT = 8 * 1024 * 1024
const PREVIEW_CHUNK = READ_LIMIT / 2
const WALK_DEPTH = 3
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const PI_THINKING_VALUES = new Set<PiThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

export function piRoot(): string {
  return process.env.CLAVE_PI_ROOT || path.join(homedir(), '.pi', 'agent', 'sessions')
}

export function listPiFiles(root: string): string[] {
  const out: string[] = []
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of items) {
      const itemPath = path.join(dir, item.name)
      if (item.isDirectory() && depth < WALK_DEPTH) queue.push({ dir: itemPath, depth: depth + 1 })
      else if (item.isFile() && item.name.endsWith('.jsonl')) out.push(itemPath)
    }
  }
  return out
}

function textContent(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        !!block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
    )
    .map((block) => block.text)
}

export function scanPiText(
  text: string,
  fallbackId: string
): Omit<PiSessionInfo, 'path' | 'modifiedAt' | 'sizeBytes'> | null {
  let id = SESSION_ID_RE.test(fallbackId) ? fallbackId : ''
  let cwd: string | null = null
  let firstAt: string | null = null
  let provider: string | null = null
  let model: string | null = null
  let thinking: PiThinkingLevel | null = null
  let firstUserText: string | null = null
  let lastUserText: string | null = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (entry.type === 'session') {
      if (typeof entry.id === 'string' && SESSION_ID_RE.test(entry.id)) id = entry.id
      if (typeof entry.cwd === 'string' && path.isAbsolute(entry.cwd)) cwd = entry.cwd
      if (typeof entry.timestamp === 'string') firstAt = entry.timestamp
    } else if (entry.type === 'model_change') {
      if (isSafePiOption(entry.provider)) provider = entry.provider
      if (isSafePiOption(entry.modelId)) model = entry.modelId
    } else if (
      entry.type === 'thinking_level_change' &&
      PI_THINKING_VALUES.has(entry.thinkingLevel as PiThinkingLevel)
    ) {
      thinking = entry.thinkingLevel as PiThinkingLevel
    } else if (entry.type === 'message') {
      const message = entry.message as Record<string, unknown> | undefined
      if (message?.role === 'assistant') {
        if (isSafePiOption(message.provider)) provider = message.provider
        if (isSafePiOption(message.model)) model = message.model
      }
      if (message?.role === 'user') {
        const value = textContent(message.content).join('\n').trim()
        if (value) {
          firstUserText ??= value
          lastUserText = value
        }
      }
    }
  }
  if (!id || !cwd || !firstAt) return null
  return { id, cwd, firstAt, provider, model, thinking, firstUserText, lastUserText }
}

function isSafePiOption(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value &&
    !value.startsWith('-') &&
    !CONTROL_RE.test(value)
  )
}

export class PiCache {
  private readonly cache = new Map<
    string,
    { size: number; mtimeMs: number; info: PiSessionInfo | null }
  >()

  get(filePath: string): PiSessionInfo | null {
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      this.cache.delete(filePath)
      return null
    }
    const hit = this.cache.get(filePath)
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.info
    let info: PiSessionInfo | null = null
    try {
      const scanned = scanPiText(
        readPiPreviewText(filePath, stat.size),
        path.basename(filePath, '.jsonl').split('_').pop() ?? ''
      )
      if (scanned)
        info = {
          ...scanned,
          path: filePath,
          modifiedAt: new Date(stat.mtimeMs).toISOString(),
          sizeBytes: stat.size
        }
    } catch {
      info = null
    }
    this.cache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, info })
    return info
  }
}

export function listPiSessions(root: string, cache: PiCache): PiSessionInfo[] {
  return listPiFiles(root)
    .map((file) => cache.get(file))
    .filter((info): info is PiSessionInfo => info !== null)
}

// ── Lane D (PRDCT-4427): where a Pi chat's session lives ──

/** Pi's own home (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`), from the
 *  environment Pi runs in. */
export function piAgentDir(env: Record<string, string | undefined> = process.env): string {
  return env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), '.pi', 'agent')
}

/** The folder Pi keeps a working directory's sessions in, by Pi's own
 *  convention: `<agent dir>/sessions/--<cwd without its leading slash, every
 *  / \ : turned into ->--`. */
export function piSessionDir(
  cwd: string,
  env: Record<string, string | undefined> = process.env
): string {
  const encoded = cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')
  return path.join(piAgentDir(env), 'sessions', `--${encoded}--`)
}

/** Pi's session ids: letters, digits, `.`, `_`, `-`, a letter or digit at
 *  each end. Anything else is never looked up. */
const PI_SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/

/** The session file Pi wrote for this id in this working directory
 *  (`<timestamp>_<id>.jsonl`, written at the first message), else null. */
export function findPiSession(
  id: string,
  cwd: string,
  env: Record<string, string | undefined> = process.env
): string | null {
  if (!PI_SESSION_ID_RE.test(id)) return null
  const dir = piSessionDir(cwd, env)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  const name = names.find((entry) => entry.endsWith(`_${id}.jsonl`))
  return name ? path.join(dir, name) : null
}

function readPiPreviewText(filePath: string, fileSize: number): string {
  const fd = fs.openSync(filePath, 'r')
  try {
    if (fileSize <= READ_LIMIT) {
      const buffer = Buffer.alloc(fileSize)
      fs.readSync(fd, buffer, 0, fileSize, 0)
      return buffer.toString('utf-8')
    }

    const headBuffer = Buffer.alloc(PREVIEW_CHUNK)
    fs.readSync(fd, headBuffer, 0, headBuffer.length, 0)
    let head = headBuffer.toString('utf-8')
    const headLineEnd = head.lastIndexOf('\n')
    if (headLineEnd !== -1) head = head.slice(0, headLineEnd + 1)

    const tailBuffer = Buffer.alloc(PREVIEW_CHUNK)
    fs.readSync(fd, tailBuffer, 0, tailBuffer.length, fileSize - tailBuffer.length)
    let tail = tailBuffer.toString('utf-8')
    const tailLineStart = tail.indexOf('\n')
    if (tailLineStart !== -1) tail = tail.slice(tailLineStart + 1)

    return `${head}\n${tail}`
  } finally {
    fs.closeSync(fd)
  }
}

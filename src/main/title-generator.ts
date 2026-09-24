import { execFile } from 'child_process'
import { existsSync, watchFile, unwatchFile, watch, readFileSync, promises as fsPromises, type Stats } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { BrowserWindow } from 'electron'
import { getLoginShellEnv } from './pty-manager'
import { TITLE_HELPER_MARKER } from './session-history'

// --- Session tracking ---

interface SessionEntry {
  cwd: string
  claudeSessionId: string
  win: BrowserWindow
  jsonlPath: string
  titleDone: boolean
  planDetected: boolean
  pendingClear: boolean
  dirWatcher: ReturnType<typeof watch> | null
  /** Byte offset already scanned — only the appended region is read each tick. */
  scanOffset: number
  /** Carry-over for a trailing partial (unterminated) line between reads. */
  scanPartial: string
}

const sessions = new Map<string, SessionEntry>()

// --- Title generation queue (prevent concurrent CLI spawns) ---

interface TitleJob {
  sessionId: string
  userMessage: string
  resolve: (title: string) => void
  reject: (err: Error) => void
}

const titleQueue: TitleJob[] = []
let activeTitleJobs = 0
const MAX_CONCURRENT_TITLES = 1

function processNextTitle(): void {
  if (activeTitleJobs >= MAX_CONCURRENT_TITLES || titleQueue.length === 0) return
  const job = titleQueue.shift()!
  activeTitleJobs++
  runTitleGeneration(job.sessionId, job.userMessage)
    .then(job.resolve)
    .catch(job.reject)
    .finally(() => {
      activeTitleJobs--
      processNextTitle()
    })
}

// --- Helpers (shared) ---

function getJsonlPath(cwd: string, claudeSessionId: string): string {
  const projectDir = cwd.replace(/[/.]/g, '-')
  return join(homedir(), '.claude', 'projects', projectDir, `${claudeSessionId}.jsonl`)
}

// --- Public API ---

export function scheduleTitleGeneration(
  sessionId: string,
  cwd: string,
  claudeSessionId: string,
  win: BrowserWindow
): void {
  const jsonlPath = getJsonlPath(cwd, claudeSessionId)
  const entry: SessionEntry = {
    cwd, claudeSessionId, win, jsonlPath,
    titleDone: false, planDetected: false, pendingClear: false, dirWatcher: null,
    scanOffset: 0, scanPartial: ''
  }
  sessions.set(sessionId, entry)

  watchJsonl(sessionId, entry)

  // Watch the project directory for new JSONL files (created by /clear)
  const projectDir = dirname(jsonlPath)
  if (existsSync(projectDir)) {
    const dirWatcher = watch(projectDir, (eventType, filename) => {
      if (eventType !== 'rename' || !filename?.endsWith('.jsonl')) return
      const newFile = join(projectDir, filename)
      if (newFile === entry.jsonlPath || !existsSync(newFile)) return
      // Only process if this session is expecting a /clear (set via notifyClear from PTY input)
      if (!entry.pendingClear) return

      // Small delay — file may not be fully written yet when the watch event fires
      setTimeout(() => {
        if (!existsSync(newFile) || !entry.pendingClear) return
        // Check if this new JSONL is a /clear continuation
        try {
          const head = readFileSync(newFile, { encoding: 'utf-8', flag: 'r' })
          if (!head.includes('<command-name>/clear</command-name>')) return
        } catch { return }

        console.log(`[title-gen] Session ${sessionId}: /clear detected (new JSONL: ${filename})`)
        entry.pendingClear = false

        // Stop watching old JSONL, switch to new one
        try { unwatchFile(entry.jsonlPath) } catch { /* ignore */ }
        entry.jsonlPath = newFile
        entry.titleDone = false
        entry.planDetected = false
        entry.scanOffset = 0
        entry.scanPartial = ''

        // Start watching the new JSONL for title generation
        watchJsonl(sessionId, entry)

        // The new file's stem IS the rotated Claude session id: hand it to
        // the renderer with the reset, so the tab follows its conversation
        // (before this the tab kept the pre-/clear id, and a Resume or a
        // restart reopened the conversation the user had just cleared).
        const stem = filename.slice(0, -'.jsonl'.length)
        if (entry.win && !entry.win.isDestroyed()) {
          entry.win.webContents.send(`session:clear-detected:${sessionId}`, stem)
        }
      }, 500)
    })
    entry.dirWatcher = dirWatcher
  }
}

function watchJsonl(sessionId: string, entry: SessionEntry): void {
  let lastSize = 0
  watchFile(entry.jsonlPath, { persistent: false, interval: 2000 }, (curr: Stats) => {
    if (curr.size === 0) return
    // File shrank (rotated/truncated) — rescan from the beginning.
    if (curr.size < lastSize) {
      entry.scanOffset = 0
      entry.scanPartial = ''
    }
    if (curr.size === lastSize) return
    lastSize = curr.size
    void processJsonl(sessionId, entry)
  })

  if (existsSync(entry.jsonlPath)) {
    void processJsonl(sessionId, entry)
  }
}

export function cleanup(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (entry) {
    try { unwatchFile(entry.jsonlPath) } catch { /* ignore */ }
    try { entry.dirWatcher?.close() } catch { /* ignore */ }
  }
  sessions.delete(sessionId)
  // Remove any queued title jobs for this session
  const queueIdx = titleQueue.findIndex((j) => j.sessionId === sessionId)
  if (queueIdx !== -1) {
    titleQueue[queueIdx].reject(new Error('Session cleaned up'))
    titleQueue.splice(queueIdx, 1)
  }
}

/** Mark a session as expecting a /clear — called when PTY input contains /clear */
export function notifyClear(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (entry) {
    entry.pendingClear = true
    console.log(`[title-gen] Session ${sessionId}: /clear pending`)
  }
}

// --- JSONL processing ---

async function processJsonl(sessionId: string, entry: SessionEntry): Promise<void> {
  // Nothing left to detect — stop polling this transcript entirely. Without this
  // the watcher re-read the whole (multi-MB, ever-growing) JSONL every 2s for the
  // session's entire life just to look for a plan that most sessions never emit.
  if (entry.titleDone && entry.planDetected) {
    try { unwatchFile(entry.jsonlPath) } catch { /* ignore */ }
    return
  }

  // Read only the appended region since the last scan.
  let chunk: string
  try {
    const fh = await fsPromises.open(entry.jsonlPath, 'r')
    try {
      const stat = await fh.stat()
      if (stat.size <= entry.scanOffset) return
      const length = stat.size - entry.scanOffset
      const buf = Buffer.alloc(length)
      await fh.read(buf, 0, length, entry.scanOffset)
      entry.scanOffset = stat.size
      chunk = buf.toString('utf-8')
    } finally {
      await fh.close()
    }
  } catch {
    return
  }

  // Keep any trailing partial line for the next read; only process complete lines.
  const text = entry.scanPartial + chunk
  const lastNl = text.lastIndexOf('\n')
  if (lastNl === -1) {
    entry.scanPartial = text
    return
  }
  entry.scanPartial = text.slice(lastNl + 1)
  const lines = text.slice(0, lastNl).split('\n')

  // Title: first valid user message (lines are scanned in order across reads).
  if (!entry.titleDone) {
    for (const line of lines) {
      if (!line.includes('"type":"user"')) continue
      const userMessage = parseUserMessage(line)
      if (!userMessage || !isValidMessage(userMessage)) continue

      entry.titleDone = true
      console.log(`[title-gen] Session ${sessionId} message: "${userMessage.slice(0, 80)}"`)

      generateTitle(sessionId, userMessage)
        .then((title) => {
          if (entry.win && !entry.win.isDestroyed()) {
            entry.win.webContents.send(`session:auto-title:${sessionId}`, title)
          }
        })
        .catch(() => {})
      break
    }
  }

  // Plan: any line carrying a planFilePath.
  if (!entry.planDetected) {
    for (const line of lines) {
      if (!line.includes('planFilePath')) continue
      try {
        const parsed = JSON.parse(line)
        const planPath = extractPlanPath(parsed)
        if (planPath && existsSync(planPath)) {
          entry.planDetected = true
          if (entry.win && !entry.win.isDestroyed()) {
            entry.win.webContents.send(`session:plan-detected:${sessionId}`, planPath)
          }
          console.log(`[title-gen] Session ${sessionId}: plan detected at ${planPath}`)
          break
        }
      } catch {
        // skip malformed line
      }
    }
  }
}

// --- Parsing ---

function parseUserMessage(line: string): string | null {
  try {
    const entry = JSON.parse(line)
    if (entry.type === 'user' && entry.message?.content) {
      const text =
        typeof entry.message.content === 'string'
          ? entry.message.content
          : Array.isArray(entry.message.content)
            ? entry.message.content
                .filter((b: { type: string }) => b.type === 'text')
                .map((b: { text: string }) => b.text)
                .join(' ')
            : ''
      if (text.trim()) return text.trim()
    }
  } catch {
    // malformed
  }
  return null
}

function extractPlanPath(entry: Record<string, unknown>): string | null {
  if (typeof entry.planFilePath === 'string') return entry.planFilePath

  const content = (entry.message as Record<string, unknown>)?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === 'ExitPlanMode') {
        const planPath = (block.input as Record<string, unknown>)?.planFilePath
        if (typeof planPath === 'string') return planPath
      }
    }
  }
  return null
}

// --- Title generation ---

/** A title is one short Haiku turn that needs no tool, no skill and no MCP
 *  server: the CLI is told so, or it connects every server the user has
 *  configured and offers every skill before it can answer — a second full
 *  boot beside the session the reader is actually waiting on. The user's
 *  settings stay in force (an auth helper lives there); the prompt goes on
 *  stdin, since `--tools` is variadic and would swallow a positional one. */
export const TITLE_CLI_ARGS = [
  '-p',
  '--model',
  'haiku',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--disable-slash-commands',
  '--tools',
  ''
]

function generateTitle(sessionId: string, userMessage: string): Promise<string> {
  return new Promise((resolve, reject) => {
    titleQueue.push({ sessionId, userMessage, resolve, reject })
    processNextTitle()
  })
}

function runTitleGeneration(sessionId: string, userMessage: string): Promise<string> {
  const prompt = `${TITLE_HELPER_MARKER} based on what the user asked.
Rules:
- Return ONLY the title, no quotes, no explanation
- Be specific about what the user is working on
- Lowercase, like an IDE tab title
- Examples: "fix auth middleware", "add dark mode", "refactor store", "debug api"

User's message:
${userMessage}`

  const env = { ...getLoginShellEnv() }
  delete env.CLAUDECODE

  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      'claude',
      TITLE_CLI_ARGS,
      { env, encoding: 'utf-8', maxBuffer: 1024 * 1024, timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) {
          console.error('[title-gen] claude CLI error:', err.message, stderr)
          const fallback = heuristicTitle(userMessage)
          if (fallback) {
            console.log(`[title-gen] Session ${sessionId} (heuristic): "${fallback}"`)
            resolve(fallback)
          } else {
            reject(new Error(stderr || err.message))
          }
          return
        }
        const title = stdout.trim()
        if (!title) {
          const fallback = heuristicTitle(userMessage)
          if (fallback) {
            console.log(`[title-gen] Session ${sessionId} (heuristic): "${fallback}"`)
            resolve(fallback)
          } else {
            reject(new Error('Empty response from Claude'))
          }
          return
        }
        const wordCount = title.split(/\s+/).length
        if (wordCount > 6 || /^(I |I'm |I'll |The |This |You |It |We |My |Let )/.test(title)) {
          console.warn(`[title-gen] Rejected bad title for ${sessionId}: "${title}"`)
          const fallback = heuristicTitle(userMessage)
          if (fallback) {
            console.log(`[title-gen] Session ${sessionId} (heuristic): "${fallback}"`)
            resolve(fallback)
          } else {
            reject(new Error('Response is not a valid title'))
          }
          return
        }
        console.log(`[title-gen] Session ${sessionId}: "${title}"`)
        resolve(title)
      }
    )
    child.stdin?.write(prompt)
    child.stdin?.end()
  })
}

// --- Helpers ---

function isValidMessage(msg: string): boolean {
  if (msg.length < 5) return false
  if (msg.startsWith('/')) return false
  if (/^(y|n|yes|no)$/i.test(msg)) return false
  return true
}

const PREFIX_RE =
  /^(please\s+|can you\s+|could you\s+|I want to\s+|I need to\s+|I need you to\s+|help me\s+)/i

function heuristicTitle(message: string): string | null {
  let text = message.split(/\n/)[0].trim()
  text = text.replace(PREFIX_RE, '')
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
  if (words.length === 0) return null
  return words.join(' ').toLowerCase()
}

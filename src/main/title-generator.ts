import {
  existsSync,
  watchFile,
  unwatchFile,
  watch,
  readFileSync,
  promises as fsPromises,
  type Stats
} from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import * as helperRunner from './helpers/runner'
import { HELPER_CANCEL_GRACE_MS } from './helpers/runner'
import { TITLE_TIMEOUT_MS, titleHelper } from './helpers/title'
import { sessionCleared, sessionPlanDetected, sessionTitleChanged } from './server/session-events'

// --- Session tracking ---

/** What the title one-shot needs to run the agent the session runs: the
 *  workspace and profile that resolve its command, the account it is on. All
 *  optional: a session with none of it is named by the workspace's default
 *  Claude on the machine login, as every session was before profiles. */
export interface TitleLaunchContext {
  workspaceId?: string
  launchProfileId?: string
  claudeProfileId?: string
  configDir?: string
}

interface SessionEntry {
  cwd: string
  claudeSessionId: string
  /** The key of the window the tab is in, for the per-window arm of its
   *  news when no server publishes it; null for a windowless caller. */
  windowKey: string | null
  launch: TitleLaunchContext
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

/** Chat tabs (events sessions) waiting to be named. A chat tab has no PTY and
 *  no transcript to watch: its first user message crosses `sessions:write` in
 *  main, so that is where the title is asked for. A session enters this set at
 *  spawn when it starts a fresh conversation and leaves it with the first
 *  message that reads as an intention; a resumed conversation never enters it
 *  and keeps the name it was saved under. */
const chatAwaitingTitle = new Map<string, TitleLaunchContext>()

// --- Title generation: the tab-title helper (`helpers/title.ts`) ---
//
// The queue, the cap of one title at a time, the kill on quit and the door
// shut on shutdown (PRDCT-3375) are the helpers' runner's now
// (`helpers/runner.ts`): these keep the names the sessions' shutdown and the
// tests call.

/** How long a cancelled child gets to leave on SIGTERM before SIGKILL. */
export const TITLE_CANCEL_GRACE_MS = HELPER_CANCEL_GRACE_MS

/** End every helper job (titles among them): the queued ones refused, the
 *  running CLI signalled, its late answer naming no tab. Called by the
 *  sessions' shutdown (`pty-manager.ts` killAll), in the app's quit and the
 *  standalone server's stop alike, and when the last window closes. The
 *  door stays open: a title asked for afterwards runs. */
export function cancelAll(): void {
  helperRunner.cancelAll()
}

/** The quit's call: every job ended as `cancelAll` does, and the door shut,
 *  so a tab named during the quit spawns no CLI nothing kills. */
export function shutdown(): void {
  helperRunner.shutdown()
}

/** The title CLIs running right now (test seam). */
export function runningTitleJobs(): number {
  return helperRunner.runningHelpers(titleHelper.id)
}

/** Open the door again (test seam: the module is one per process). */
export function resetShutdownForTests(): void {
  helperRunner.resetShutdownForTests()
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
  windowKey: string | null,
  launch: TitleLaunchContext = {}
): void {
  const jsonlPath = getJsonlPath(cwd, claudeSessionId)
  const entry: SessionEntry = {
    cwd,
    claudeSessionId,
    windowKey,
    launch,
    jsonlPath,
    titleDone: false,
    planDetected: false,
    pendingClear: false,
    dirWatcher: null,
    scanOffset: 0,
    scanPartial: ''
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
        } catch {
          return
        }

        console.log(`[title-gen] Session ${sessionId}: /clear detected (new JSONL: ${filename})`)
        entry.pendingClear = false

        // Stop watching old JSONL, switch to new one
        try {
          unwatchFile(entry.jsonlPath)
        } catch {
          /* ignore */
        }
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
        sessionCleared(sessionId, stem, entry.windowKey)
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

/** A chat tab that just started a fresh conversation: its first message names it. */
export function scheduleChatTitle(sessionId: string, launch: TitleLaunchContext = {}): void {
  chatAwaitingTitle.set(sessionId, launch)
}

/** A user message a chat tab just sent. The first one worth a title — not a
 *  slash command, not a bare yes/no — becomes the tab's name, delivered on the
 *  same channel a terminal tab's title arrives on. Anything else leaves the tab
 *  waiting for the message that does state what the conversation is about. */
export function notifyChatMessage(sessionId: string, text: string, windowKey: string | null): void {
  const launch = chatAwaitingTitle.get(sessionId)
  if (!launch) return
  const message = text.trim()
  if (!isValidMessage(message)) return
  chatAwaitingTitle.delete(sessionId)
  console.log(`[title-gen] Chat ${sessionId} message: "${message.slice(0, 80)}"`)
  generateTitle(sessionId, message, launch)
    .then((title) => sessionTitleChanged(sessionId, title, windowKey))
    .catch(() => {})
}

export function cleanup(sessionId: string): void {
  chatAwaitingTitle.delete(sessionId)
  const entry = sessions.get(sessionId)
  if (entry) {
    try {
      unwatchFile(entry.jsonlPath)
    } catch {
      /* ignore */
    }
    try {
      entry.dirWatcher?.close()
    } catch {
      /* ignore */
    }
  }
  sessions.delete(sessionId)
  // Refuse any title job this session still has waiting.
  helperRunner.cancelQueued(sessionId)
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
    try {
      unwatchFile(entry.jsonlPath)
    } catch {
      /* ignore */
    }
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

      generateTitle(sessionId, userMessage, entry.launch)
        .then((title) => sessionTitleChanged(sessionId, title, entry.windowKey))
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
          sessionPlanDetected(sessionId, planPath, entry.windowKey)
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

export { TITLE_TIMEOUT_MS }

/**
 * The tab's title: the helper's, run as the session runs (its launch
 * profile's command, on its account), once more if the first reply was not a
 * title; the message's own first words when there is still none. Every
 * fallback says why on stderr: the server's stdout is not kept, and a tab
 * named by its first four words looked like a choice for weeks.
 */
async function generateTitle(
  sessionId: string,
  userMessage: string,
  context: TitleLaunchContext
): Promise<string> {
  const outcome = await helperRunner.runHelper(titleHelper, userMessage, context, {
    owner: sessionId
  })
  if (outcome.ok) {
    console.log(`[title-gen] Session ${sessionId}: "${outcome.value}"`)
    return outcome.value
  }
  // Ended by the quit or a closed tab: no heuristic, no title for a tab that is going.
  if (outcome.reason === 'cancelled') throw new Error('Title generation cancelled')
  const fallback = heuristicTitle(userMessage)
  console.warn(
    `[title-gen] Session ${sessionId}: no title from the model (${outcome.reason}: ${outcome.detail.slice(0, 200)}); ` +
      (fallback ? `using the message's first words "${fallback}"` : 'no fallback either')
  )
  if (fallback) return fallback
  throw new Error(outcome.detail)
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
  const words = text.split(/\s+/).filter(Boolean).slice(0, 4)
  if (words.length === 0) return null
  return words.join(' ').toLowerCase()
}

/**
 * What a terminal session printed, kept so an agent can read a tab's screen
 * with no window open (wave 4, PRDCT-3377, `clave_read_session`). The
 * process that runs the sessions keeps the recent output of every terminal
 * (the last 512 KiB, as the terminal process keeps for a re-attach) and the
 * size its pane last gave it; a read renders that output through a headless
 * xterm at that size and answers the last lines as a reader would see them,
 * trailing blank rows dropped, the way the window read its own xterm. The
 * render is on demand: nothing parses escape sequences until someone asks.
 *
 * No Electron and no import at load: the headless xterm is loaded on the
 * first read, so a process that never serves a read never loads it.
 */
import type { SessionScreen } from '@clave/contract/sessions'

export const RETAIN_BYTES = 512 * 1024
/** The size a terminal is rendered at until its pane says otherwise: the
 *  size the hidden spawns of the agent tools start at. */
export const DEFAULT_COLS = 120
export const DEFAULT_ROWS = 30
export const MAX_LINES = 500

interface Retained {
  chunks: string[]
  length: number
  cols: number
  rows: number
}

const screens = new Map<string, Retained>()

const entry = (id: string): Retained => {
  let kept = screens.get(id)
  if (!kept) {
    kept = { chunks: [], length: 0, cols: DEFAULT_COLS, rows: DEFAULT_ROWS }
    screens.set(id, kept)
  }
  return kept
}

/** Output as the process produced it, oldest first; what exceeds the ring is dropped. */
export function retainOutput(id: string, data: string, retainBytes = RETAIN_BYTES): void {
  if (!data) return
  const kept = entry(id)
  kept.chunks.push(data)
  kept.length += data.length
  while (kept.length > retainBytes && kept.chunks.length > 1) {
    const first = kept.chunks.shift() as string
    kept.length -= first.length
  }
  if (kept.length > retainBytes && kept.chunks.length === 1) {
    kept.chunks[0] = kept.chunks[0].slice(kept.chunks[0].length - retainBytes)
    kept.length = kept.chunks[0].length
  }
}

/** The size the pane last gave the terminal. */
export function noteSize(id: string, cols: number, rows: number): void {
  const kept = entry(id)
  kept.cols = Math.max(1, Math.floor(cols))
  kept.rows = Math.max(1, Math.floor(rows))
}

export function hasScreen(id: string): boolean {
  return screens.has(id)
}

export function forgetScreen(id: string): void {
  screens.delete(id)
}

/** Tests only. */
export function resetScreensForTests(): void {
  screens.clear()
}

type HeadlessModule = typeof import('@xterm/headless')
type HeadlessTerminal = HeadlessModule['Terminal']
let headless: Promise<HeadlessTerminal> | null = null
/** The constructor, wherever the loader put it: on the namespace under
 *  vitest, under `default` once electron-vite has bundled main as CommonJS
 *  (the first end-to-end run answered "Terminal is not a constructor"). */
const loadHeadless = (): Promise<HeadlessTerminal> =>
  (headless ??= import('@xterm/headless').then((mod) => {
    const found =
      (mod as { Terminal?: HeadlessTerminal }).Terminal ??
      (mod as { default?: { Terminal?: HeadlessTerminal } }).default?.Terminal
    if (typeof found !== 'function') throw new Error('the headless terminal did not load')
    return found
  }))

/** The last `lines` rendered lines of the session's screen. Throws when the
 *  session printed nothing this process kept. */
export async function renderScreen(id: string, lines: number): Promise<SessionScreen> {
  const kept = screens.get(id)
  if (!kept) throw new Error('no terminal buffer')
  const wanted = Math.min(Math.max(Math.floor(lines) || 1, 1), MAX_LINES)
  const Terminal = await loadHeadless()
  const terminal = new Terminal({
    cols: kept.cols,
    rows: kept.rows,
    scrollback: Math.max(MAX_LINES, wanted),
    allowProposedApi: true
  })
  try {
    const text = kept.chunks.join('')
    await new Promise<void>((resolve) => terminal.write(text, resolve))
    const buffer = terminal.buffer.active
    const all: string[] = []
    for (let i = 0; i < buffer.length; i++) {
      all.push(buffer.getLine(i)?.translateToString(true) ?? '')
    }
    // The viewport below the cursor is blank padding (the buffer always
    // holds `rows` lines): the blank tail goes first, then the last `lines`
    // of what was printed, so a short output answers its lines and not the
    // empty rows under them.
    while (all.length && all[all.length - 1].trim() === '') all.pop()
    return { lines: all.slice(-wanted), cols: kept.cols, rows: kept.rows }
  } finally {
    terminal.dispose()
  }
}

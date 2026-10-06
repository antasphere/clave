import * as fs from 'fs'
import { TEST_NO_ACTIVATE } from './test-mode'
import { lazyTerminalPorts } from './ports/terminals'
import type { PtySpawnOptions } from './sessions/adapters/pty-backend'

/**
 * The terminal journal: one JSON line per spawn the terminal manager is
 * asked for and per write it passes on, appended to `terminal-journal.jsonl`
 * under the data directory, under `--test-no-activate` only. The
 * end-to-end specs read it through `spawnJournal` and `writeJournal` in
 * `tests/e2e/harness.mjs`, where they used to tap `pty:spawn` and `pty:write`
 * inside the main process; its path is also on the test hooks namespace,
 * `globalThis.__claveE2E.terminalJournal.file`, beside what the other
 * domains expose there, for a reader inside main.
 *
 * A spawn line carries the cwd and the options as the manager received them,
 * minus `initialInput` (a restart's resent message, never a caller's), which
 * is the shape the IPC tap used to see. A write line carries the session id
 * and the bytes as text. Appends are synchronous so a line is on disk before
 * the spawn goes any further: a spec reads the file right after the click.
 * A spawn's options carry the prompt, which is why the file exists only in
 * test mode and never by default.
 */
export const TERMINAL_JOURNAL_DOCUMENT = 'terminal-journal.jsonl'

export type TerminalJournalLine =
  | { kind: 'spawn'; t: number; cwd: string; options: Omit<PtySpawnOptions, 'initialInput'> }
  | { kind: 'write'; t: number; id: string; data: string }

export interface TerminalJournal {
  readonly file: string
  spawn(cwd: string, options: PtySpawnOptions | undefined): void
  write(id: string, data: string): void
}

export function fileTerminalJournal(file: string): TerminalJournal {
  const append = (line: TerminalJournalLine): void => {
    try {
      fs.appendFileSync(file, JSON.stringify(line) + '\n')
    } catch (err) {
      // A journal nobody can write is a broken test run, never a broken app;
      // the spec reading an empty file fails on its own assertion.
      console.error('[terminal-journal] append failed', err)
    }
  }
  return {
    file,
    spawn(cwd, options) {
      const rest: Omit<PtySpawnOptions, 'initialInput'> & { initialInput?: unknown } = {
        ...options
      }
      delete rest.initialInput
      append({ kind: 'spawn', t: Date.now(), cwd, options: rest })
    },
    write(id, data) {
      append({ kind: 'write', t: Date.now(), id, data })
    }
  }
}

let journal: TerminalJournal | null | undefined

/** The journal of a test instance, or null outside test mode: resolved once,
 *  at the first spawn or write, on the storage port's data directory. */
export function terminalJournal(): TerminalJournal | null {
  if (journal === undefined) {
    if (!TEST_NO_ACTIVATE) journal = null
    else {
      journal = fileTerminalJournal(lazyTerminalPorts.storage.pathOf(TERMINAL_JOURNAL_DOCUMENT))
      // The test hooks namespace main exposes under --test-no-activate (the
      // sessions lane puts its own there); a second global is never made.
      const hooks = (globalThis as { __claveE2E?: Record<string, unknown> }).__claveE2E ?? {}
      hooks.terminalJournal = { file: journal.file }
      ;(globalThis as { __claveE2E?: Record<string, unknown> }).__claveE2E = hooks
    }
  }
  return journal
}

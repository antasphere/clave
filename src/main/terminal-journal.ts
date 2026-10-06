import * as fs from 'fs'
import { TERMINAL_JOURNAL } from './test-mode'
import type { PtySpawnOptions } from './sessions/adapters/pty-backend'

/**
 * The terminal journal: one JSON line per spawn the terminal manager is
 * asked for and per write it passes on, appended to the file
 * `--terminal-journal=<file>` names, under `--test-no-activate` only
 * (`test-mode.ts` says why). The end-to-end specs read it through
 * `spawnJournal` in `tests/e2e/harness.mjs`, where they used to tap
 * `pty:spawn` and `pty:write` inside the main process.
 *
 * A spawn line carries the cwd and the options as the manager received them,
 * minus `initialInput` (a restart's resent message, never a caller's), which
 * is the shape the IPC tap used to see. A write line carries the session id
 * and the bytes as text. Appends are synchronous so a line is on disk before
 * the spawn goes any further: a spec reads the file right after the click.
 */
export type TerminalJournalLine =
  | { kind: 'spawn'; t: number; cwd: string; options: Omit<PtySpawnOptions, 'initialInput'> }
  | { kind: 'write'; t: number; id: string; data: string }

export interface TerminalJournal {
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

/** The journal the launch line asked for, or null: resolved once. */
export function terminalJournal(): TerminalJournal | null {
  if (journal === undefined)
    journal = TERMINAL_JOURNAL ? fileTerminalJournal(TERMINAL_JOURNAL) : null
  return journal
}

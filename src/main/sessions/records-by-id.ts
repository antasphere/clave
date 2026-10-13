/**
 * The records a window asks for by id (wave 3): the adoptable listing leaves
 * out every session this process already runs, and a window asking for one
 * of those by id wants its record all the same (a terminal the server started
 * for a group, which the window takes in from the record alone, without a
 * spawn). Such a record is marked `running`, with the process's own state as
 * its liveness, so the window can tell it from a record whose process the
 * re-home's adoption reattaches. A record the listing has comes back as the
 * listing had it, with no `running`. Pure, so the rule has a test of its own.
 */
import type { SessionRecord } from './adapters/pty-backend'

export function recordsForIds(
  adoptable: ReadonlyArray<SessionRecord>,
  ids: ReadonlyArray<unknown>,
  running: {
    /** The record of a session this process runs, undefined when it runs none by that id. */
    recordOf: (id: string) => SessionRecord | undefined
    /** Whether that session's process is alive. */
    isAlive: (id: string) => boolean
  }
): SessionRecord[] {
  const wanted = new Set(ids.filter((x): x is string => typeof x === 'string'))
  const found = adoptable.filter((r) => wanted.has(r.id))
  for (const id of wanted) {
    if (found.some((r) => r.id === id)) continue
    const record = running.recordOf(id)
    if (record) found.push({ ...record, live: running.isAlive(id), running: true })
  }
  return found
}

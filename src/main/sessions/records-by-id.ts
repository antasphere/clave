/**
 * The records a window asks for by id (wave 3): the adoptable listing leaves
 * out every session this process already runs, and a window asking for one
 * of those by id wants its record all the same (a terminal the server started
 * for a group, which the window takes in from the record alone, without a
 * spawn). Such a record is marked `running`, with the process's own state as
 * its liveness, so the window can tell it from a record whose process the
 * re-home's adoption reattaches. Pure, so the rule has a test of its own.
 *
 * The backend's listing only leaves out its own PTYs, though: a chat session
 * the host holds has no PTY there, only its record, so the listing has it,
 * and until issue #183 it went out unmarked, as a record to spawn. A window
 * reloading asked for each such chat again under its id, the spawn failed as
 * a duplicate, and the tab left the sidebar and its group; the live terminal
 * tabs, left out of the listing, left with them. A record whose session this
 * process hosts is therefore marked `running` wherever it is answered, from
 * what the host holds and never from a record file alone (a cold chat's file
 * is readable by id too), and the whole listing carries the live terminal
 * tabs the host runs.
 */
import type { SessionRecord } from './adapters/pty-backend'

/** What this process holds, as the records rule reads it. */
export interface HostedSessions {
  /** Whether this process hosts a session by that id. */
  hosts: (id: string) => boolean
  /** Whether its process runs: for a chat, whether its provider was started
   *  (a registered chat waits for a view to start it). */
  isAlive: (id: string) => boolean
}

/** The listing with each session this process hosts marked `running`, its
 *  liveness the host's. The listing itself when it hosts none of it. */
export function markHosted(
  adoptable: ReadonlyArray<SessionRecord>,
  hosted: HostedSessions
): SessionRecord[] {
  if (!adoptable.some((r) => hosted.hosts(r.id))) return adoptable as SessionRecord[]
  return adoptable.map((r) =>
    hosted.hosts(r.id) ? { ...r, live: hosted.isAlive(r.id), running: true } : r
  )
}

/**
 * The whole listing a window restores from: the backend's, its hosted
 * sessions marked, plus every TAB the host runs that the backend left out (a
 * live terminal; its record, marked `running`). A session that is the hidden
 * half of something else (a group's terminal, a view's server, a toolbar's)
 * keeps its own road back, and a process that has ended is not offered.
 */
export function hostedListing(
  adoptable: ReadonlyArray<SessionRecord>,
  hosted: HostedSessions & {
    /** Every session id this process hosts. */
    ids: () => ReadonlyArray<string>
    recordOf: (id: string) => SessionRecord | undefined
  }
): SessionRecord[] {
  const listing = markHosted(adoptable, hosted)
  const listed = new Set(listing.map((r) => r.id))
  const tabs: SessionRecord[] = []
  for (const id of hosted.ids()) {
    if (listed.has(id) || !hosted.isAlive(id)) continue
    const record = hosted.recordOf(id)
    if (record && !record.link) tabs.push({ ...record, live: true, running: true })
  }
  return tabs.length === 0 ? listing : [...listing, ...tabs]
}

export function recordsForIds(
  adoptable: ReadonlyArray<SessionRecord>,
  ids: ReadonlyArray<unknown>,
  running: HostedSessions & {
    /** The record of a session this process runs, undefined when it runs none by that id. */
    recordOf: (id: string) => SessionRecord | undefined
  }
): SessionRecord[] {
  const wanted = new Set(ids.filter((x): x is string => typeof x === 'string'))
  const found = markHosted(
    adoptable.filter((r) => wanted.has(r.id)),
    running
  )
  for (const id of wanted) {
    if (found.some((r) => r.id === id) || !running.hosts(id)) continue
    const record = running.recordOf(id)
    if (record) found.push({ ...record, live: running.isAlive(id), running: true })
  }
  return found
}

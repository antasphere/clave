import type { SessionRecord } from '../../../preload/index.d'
import { legacyAgentProvider, type LegacyAgentModes } from '../../../shared/session-migration'

/**
 * What the launch does with each surviving session record — the rule that
 * keeps a session which is only the HIDDEN HALF of something else out of the
 * sidebar (PRDCT-1756).
 *
 * The record is all that survives an app quit, and until `link` it did not
 * say what its session was FOR. So a group's `npm run dev`, a session view's
 * serving process and a toolbar button's dev server all came back as
 * top-level tabs: mystery rows next to the groups, while the owner showed
 * "not running" and its start action spawned a DUPLICATE on the same port.
 * The renderer's own links could not close the gap — the toolbar's lives in
 * a module map that dies with the window, the session view's is deliberately
 * never persisted, and the group's lives in the sidebar layout, which drops
 * it together with the group whose members did not come back.
 *
 * Pure so vitest pins it; the adoption itself is `adopt-record.ts`.
 */

/** The fields of a record this decision reads. */
export interface BootRecordLike extends LegacyAgentModes {
  id: string
  live?: boolean
  link?: SessionRecord['link']
}

export interface BootPlan<R extends BootRecordLike> {
  /** Live ordinary tabs reattach; supported agents restore metadata only, even when dead. */
  liveTabs: R[]
  /** Ordinary tabs whose process is gone — offered behind the restore prompt. */
  deadTabs: R[]
  /** Live sessions that belong inside something: a group's quick-launch
   *  terminal, a session view's server. Adopted, then linked back to their
   *  owner — never placed at the top level. */
  hidden: R[]
  /** Live toolbar terminals. Not sidebar citizens at all: they are handed to
   *  the toolbar registry, which reattaches when the button is next opened. */
  toolbar: R[]
  /** Linked records whose process is gone. Nothing to bring back — the shell
   *  they would relaunch into is not the dev server that died, and offering
   *  it is exactly what put a mystery tab in the sidebar. The owner's own
   *  start action respawns the command. */
  discard: R[]
}

/**
 * Split the adoptable records by what each session IS. A record with no
 * `link` is a tab, which is every session the user opened and every record
 * written before the field existed — so this is a no-op for them.
 */
export function planBootAdoption<R extends BootRecordLike>(records: R[]): BootPlan<R> {
  const plan: BootPlan<R> = { liveTabs: [], deadTabs: [], hidden: [], toolbar: [], discard: [] }
  for (const r of records) {
    const kind = r.link?.kind
    if (!kind) {
      ;(r.live || legacyAgentProvider(r) ? plan.liveTabs : plan.deadTabs).push(r)
      continue
    }
    if (!r.live) {
      plan.discard.push(r)
      continue
    }
    if (kind === 'toolbar') plan.toolbar.push(r)
    else plan.hidden.push(r)
  }
  return plan
}

/**
 * Every session id that will exist after the restore — what the sidebar
 * layout merge must treat as surviving. The hidden halves belong in it even
 * though they are adopted after the merge: leaving them out is what detached
 * a group terminal from its terminal row and then pruned the whole group for
 * having no surviving member.
 */
export function survivingIds<R extends BootRecordLike>(
  plan: BootPlan<R>,
  adoptedTabIds: Iterable<string>
): string[] {
  return [...adoptedTabIds, ...plan.hidden.map((r) => r.id)]
}

/** The store shape the hidden-owner lookup reads. */
export interface OwnerLookupState {
  groups: { id: string; terminals: { id: string }[] }[]
  sessions: { id: string; view?: unknown }[]
}

/**
 * What a hidden half's record does at boot, given who is around to own it:
 * `link` back to its owner when the owner is there, `discard` when it is not.
 *
 * The owner can legitimately be gone: the group was deleted, the owning tab
 * did not come back. Until PRDCT-2038 an ownerless hidden half became an
 * ordinary tab ("a process the user started, don't kill it to tidy the
 * sidebar") — and that is exactly how a deleted group's `npm run dev` came
 * back as a mystery tab at every restart. Now a deletion stops the group's
 * terminals, so an orphan record means a group that no longer exists, and
 * the record carries nothing (no group name, no terminal config) that would
 * let the group be rebuilt around it. Discard: the process is stopped and
 * the record removed, never surfaced. Pure so vitest pins it.
 */
export function resolveHiddenOwner(
  link: NonNullable<SessionRecord['link']>,
  state: OwnerLookupState
): 'link' | 'discard' {
  if (link.kind === 'group-terminal') {
    const owned = state.groups.some(
      (g) => g.id === link.groupId && g.terminals.some((t) => t.id === link.terminalId)
    )
    return owned ? 'link' : 'discard'
  }
  if (link.kind === 'session-view') {
    const owner = state.sessions.find((s) => s.id === link.ownerId)
    return owner && owner.view ? 'link' : 'discard'
  }
  return 'discard'
}

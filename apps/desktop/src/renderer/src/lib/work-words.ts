import type { WorkRole } from '@clave/contract/work-rules'
import type { Session } from '../store/session-types'
import type { WorkEntry } from './work-presentation'
import { tabIndicators } from './tab-status'

/**
 * The words a wave or lane entry (PRDCT-4123) is shown with: its roles, the
 * standings of its members, what each session is doing, and what an entry
 * says when nobody holds it or the records disagree. Never a guess: an entry
 * that cannot name its holder says why.
 */

export const ROLE_LABEL: Record<WorkRole, string> = {
  coordinator: 'Coordinator',
  lead: 'Lead',
  verifier: 'Verifier',
  worker: 'Worker'
}

export const STANDING_LABEL: Record<string, string> = {
  current: 'Current',
  pending: 'Taking over',
  superseded: 'Superseded',
  completed: 'Completed'
}

/** What a session is doing, in words that never claim a delivery: a turn that
 *  ended is a turn that ended. */
export function workStateLabel(session: Session): string {
  const { status } = tabIndicators(session)
  switch (status) {
    case 'needs-you':
      return 'Waiting on you'
    case 'working':
      return 'Working'
    case 'unread':
      return session.injectedFrom ? `Message from ${session.injectedFrom}` : 'New activity'
    case 'ended':
      return 'Ended'
    case 'idle':
      return session.agentState === 'done' ? 'Turn ended' : 'Idle'
  }
}

export const kindWord = (entry: WorkEntry): string => (entry.kind === 'wave' ? 'wave' : 'lane')

/** The words an unresolved unit is shown with: what disagrees, not a guess. */
export function unresolvedWords(entry: WorkEntry): string | null {
  const owner = entry.owner
  if (owner.state !== 'unresolved') return null
  const role = ROLE_LABEL[entry.ownerRole].toLowerCase()
  switch (owner.reason) {
    case 'several':
      return `Unresolved: ${owner.candidates.length} sessions say they are this ${kindWord(entry)}'s ${role}`
    case 'not-accepted':
      return `Unresolved: a handover to a new ${role} was never accepted`
    case 'no-current':
      return `Unresolved: this ${kindWord(entry)} has no current ${role}`
  }
}

/** The words a unit with no owner among this window's sessions is shown
 *  with. Each window reads the sessions it holds, so a lead open in another
 *  window is not one this entry can name; it says so rather than nothing. */
export function vacantWords(entry: WorkEntry): string | null {
  if (entry.owner.state !== 'vacant') return null
  const role = ROLE_LABEL[entry.ownerRole].toLowerCase()
  return `No ${role} in this window: it may be open in another window, or this ${kindWord(entry)} has none yet`
}

export function breadcrumbOf(entry: Pick<WorkEntry, 'label' | 'wave'>): string {
  return entry.wave ? `${entry.wave.label} › ${entry.label}` : entry.label
}

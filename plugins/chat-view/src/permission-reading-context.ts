import { createContext } from 'react'
import { raiseLevel, riskFloor, type RiskLevel } from '../../../src/shared/permission-risk'
import type { Permission, PermissionReading as Reading } from './reducer'

/* What the permission card reads (PermissionReading.tsx, PRDCT-4331): the
   views provide it around the transcript and the dock. */

export interface PermissionReadingValue {
  /** The host's readings, by request id (`Conversation.explained`). */
  explained: Record<string, Reading>
  /** The session's working folder: "the project". */
  cwd?: string
  /** Set when the tab can go back to skipping permissions: it sends the
   *  switch. Absent when the tab never could, or already does. */
  backToBypass?: () => void
}

export const PermissionReadingContext = createContext<PermissionReadingValue | null>(null)
export const PermissionReadingProvider = PermissionReadingContext.Provider

/** How long the card says it is reading before it stops saying so: a host
 *  that runs no explainer (an older server) never answers. */
export const READING_GIVE_UP_MS = 45_000

/** The level a request shows: the rules' floor, raised by the reading. */
export function shownLevel(
  request: Permission,
  reading: Reading | undefined,
  cwd: string | undefined
): RiskLevel {
  return raiseLevel(
    riskFloor({ toolName: request.toolName, input: request.input, cwd }),
    reading?.level
  )
}

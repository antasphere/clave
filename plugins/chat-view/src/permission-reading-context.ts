import {
  createContext,
  createElement,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode
} from 'react'
import {
  riskFloor,
  shownLevel as ruleShown,
  type RiskLevel
} from '../../../src/shared/permission-risk'
import type { SessionInput } from '../../../src/shared/session-model'
import { useViewSessionStore } from '../../../src/renderer/src/views/session-store'
import type { Action, Conversation, Permission, PermissionReading as Reading } from './reducer'

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
): RiskLevel | null {
  return ruleShown(
    riskFloor({ toolName: request.toolName, input: request.input, cwd }),
    reading?.level
  )
}

/** Whether a tab was LAUNCHED skipping permissions (PRDCT-4331, D5): its
 *  record's own launch flag, or the first mode its provider reported. The
 *  modes a tab may switch to say nothing of it: a profile that only allows
 *  the switch lists the mode too. */
export function launchedSkipping(
  dangerousMode: boolean | undefined,
  launchedMode: string | undefined
): boolean {
  return dangerousMode === true || launchedMode === 'bypassPermissions'
}

/** Whether the card offers the way back: a tab launched skipping
 *  permissions, out of that mode now, whose provider still offers it. */
export function offersWayBack(
  launched: boolean,
  mode: { mode: string; modes: readonly { id: string }[] } | null
): boolean {
  return (
    launched &&
    !!mode &&
    mode.mode !== 'bypassPermissions' &&
    mode.modes.some((m) => m.id === 'bypassPermissions')
  )
}

/** What both views give the card (D7: one hook, no block copied between
 *  them): the host's readings by the provider's request id and, for a
 *  server's session, by the server's own request key the dock answers
 *  under; the way back; and the mode switch this view asks for, said to the
 *  reducer first so the transcript's line can say who asked. */
export function usePermissionReading(input: {
  sessionId: string
  cwd: string
  conversation: Conversation
  dispatch: (action: Action) => void
  write: (input: SessionInput) => Promise<void>
  report: (error: unknown) => void
  remotePending:
    | readonly { id: string; sessionId: string; providerRequestId?: string }[]
    | undefined
}): { reading: PermissionReadingValue; switchMode: (mode: string) => void } {
  const { sessionId, cwd, conversation, remotePending } = input
  // The view's write and report change with each render; the switch reads
  // the latest once the render is committed.
  const latest = useRef(input)
  useLayoutEffect(() => {
    latest.current = input
  })
  const switchMode = useCallback((mode: string): void => {
    const { dispatch, write, report } = latest.current
    dispatch({ askMode: mode })
    void write({ type: 'set_permission_mode', mode }).catch(report)
  }, [])
  const dangerousMode = useViewSessionStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.dangerousMode
  )
  const wayBack = offersWayBack(
    launchedSkipping(dangerousMode, conversation.launchedMode),
    conversation.permissionMode
  )
  const explained = conversation.explained
  const reading = useMemo((): PermissionReadingValue => {
    const byKey = { ...explained }
    for (const r of remotePending ?? [])
      if (r.sessionId === sessionId && r.providerRequestId && explained[r.providerRequestId])
        byKey[r.id] = explained[r.providerRequestId]
    return {
      explained: byKey,
      cwd,
      ...(wayBack && { backToBypass: () => switchMode('bypassPermissions') })
    }
  }, [explained, remotePending, sessionId, cwd, wayBack, switchMode])
  return { reading, switchMode }
}

/** The view's whole tree under the reading's provider: a call around the
 *  root, so not one line of the view moves (D7). */
export function withPermissionReading(
  value: PermissionReadingValue,
  node: ReactNode
): ReactElement {
  return createElement(PermissionReadingProvider, { value }, node)
}

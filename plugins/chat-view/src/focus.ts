import { useEffect, type RefObject } from 'react'
import { useViewSessionStore } from '../../../src/renderer/src/views/session-store'

/** Put the caret in the composer when this session is the focused one and the
 *  composer can take input: a new chat tab opens ready to type into, and a tab
 *  the reader comes back to is ready again, the way a terminal tab focuses its
 *  xterm (`TerminalPanel`). Gated on `enabled` because the field is disabled
 *  until the session's subscription resolves, and a disabled field swallows the
 *  focus. Both of this plugin's views are mounted at once with one on screen; a
 *  field in a hidden slot cannot take focus, so the view off screen is a no-op.
 *  The linked-document panel keeps its editor's caret, as the terminal does. */
export function useComposerFocus(
  sessionId: string,
  enabled: boolean,
  field: RefObject<HTMLElement | null>
): void {
  const focused = useViewSessionStore((s) => s.focusedSessionId === sessionId)
  useEffect(() => {
    if (!focused || !enabled) return
    if (document.activeElement?.closest('[data-testid="linked-document-panel"]')) return
    field.current?.focus({ preventScroll: true })
  }, [focused, enabled, field])
}

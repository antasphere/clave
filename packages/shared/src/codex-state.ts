/** Request Codex's own runtime status in OSC titles. The spinner also enables
 * its Action Required title while an approval or question is on screen.
 * This is an invocation-only setting; the user's config file is untouched. */
export const CODEX_TITLE_CONFIG = 'tui.terminal_title=["app-name","status","spinner"]'

export type CodexTitleState = 'idle' | 'working' | 'blocked'

/** Parse only the title shape requested above, never terminal body text or
 * elapsed output activity. Waiting means a background command is still running.
 * Unknown/cleared titles return to neutral rather than latching a stale glow. */
export function codexStateFromTitle(title: string): CodexTitleState {
  if (/^\[ [!.] \] Action Required \| codex$/.test(title)) return 'blocked'
  if (/^codex \| (Working|Thinking|Waiting)(?: [^\s|]+)?$/.test(title)) return 'working'
  return 'idle'
}

import {
  interactionModeOfView,
  isInteractionMode,
  viewOfInteractionMode,
  type InteractionMode
} from '../../shared/harness'
import { preferencesManager } from '../preferences-manager'

/** The person's interaction mode, read where `getLaunchSettings` reads it
 *  (`launch-settings.ts`) but without its Electron half: the session host
 *  runs in the standalone server too, which never loads Electron. */
export function interactionModeSetting(): InteractionMode {
  const mode = preferencesManager.get('interactionMode')
  return isInteractionMode(mode) ? mode : 'chat'
}

/** `<pluginId>/<viewId>`, both halves non-empty: the shape `setView` accepts. */
const VIEW_ID = /^[^/\s]+\/[^/\s]+$/
const pluginOf = (viewId: string): string => viewId.split('/')[0]
/** The view a chat spawn opens in when the mode is `terminal`: only an
 *  explicit `chat: true` makes one then. */
const CHAT_VIEW = 'clave.chat-view/chat'

/**
 * A pane's view pick. Until 11 November 2026 it was written to the
 * `chatView` preference and every new chat opened in the last pick, so the
 * one setting a person chose (the interaction mode, PRDCT-4425) was
 * overwritten by whichever tab they last switched (PRDCT-4175). The pick is
 * that tab's alone now, kept on its record by the host; this stays for the
 * callers that still report it (`sessions/host.ts`, `onboarding.ts`) and
 * writes nothing.
 */
export function rememberChatView(viewId: string | null): void {
  void viewId
}

/**
 * The old `chatView` pick, moved once into the interaction mode: a person
 * who had settled on a view keeps opening in it. Only while the mode is
 * still its default (`chat`), the sign it was never chosen, and the old key
 * is cleared so the move happens once.
 */
export function migrateChatView(): void {
  const old = preferencesManager.get('chatView')
  if (old === null || old === undefined) return
  const mode = typeof old === 'string' ? interactionModeOfView(old) : undefined
  if (mode && preferencesManager.get('interactionMode') === 'chat')
    preferencesManager.set('interactionMode', mode)
  preferencesManager.set('chatView', null)
}

/**
 * The view a chat session launched on a profile opens in: a profile that
 * names another plugin's view (a plugin adapter's own page) keeps it; else
 * the view of the person's interaction mode; else, the mode being the
 * terminal on a chat spawn (only an explicit `chat: true` makes one), the
 * Chat view.
 */
export function initialChatView(profileDefault: string | undefined): string | undefined {
  migrateChatView()
  const view = viewOfInteractionMode(interactionModeSetting()) ?? CHAT_VIEW
  if (profileDefault && VIEW_ID.test(profileDefault) && pluginOf(profileDefault) !== pluginOf(view))
    return profileDefault
  return view
}

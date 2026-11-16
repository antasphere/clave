/**
 * A tab goes from its chat to its terminal and back on the same conversation
 * (lane D, PRDCT-4427), from the renderer's side: which tiles the pane menu's
 * « View as » offers, and what the restart is asked. The move itself is a
 * restart under the same id (`restartSessionProcess`); main decides whether
 * the conversation can be carried (a terminal with none is refused in a
 * sentence the menu shows), the renderer never guesses. Pure, so the tests
 * pin it without a window.
 */
import type { Session } from '../../../shared/session-model'
import type { LauncherFamily } from '../../../shared/agent-launch'
import { HARNESSES, HARNESS_BY_ID } from '../../../shared/harness'
import { CHAT_PROFILE_IDS } from '../../../shared/open-session-modes'
import type { AvailableView } from '../views/resolution'

/** One tile of « View as »: a view of the chat the tab already is, or the
 *  other transport of its harness (a chat view of a terminal tab, the
 *  terminal of a chat tab). `disabled` says why it cannot be picked now. */
export interface Tile {
  id: string
  title: string
  /** The view id `ViewDrawing` draws from (`transport:pty` for the terminal). */
  drawing: string
  kind: 'view' | 'transport'
  adapterId?: string
  viewId?: string
  disabled?: string
}

/** What the legacy store knows of the tab's agent. */
export type TransportFlags = {
  claudeMode?: boolean
  codexMode?: boolean
  piMode?: boolean
  opencodeMode?: boolean
  claudeAgentsMode?: boolean
}

/** The terminal tile's id and its drawing. */
export const TERMINAL_TILE = 'transport:pty'

/** The sentence a tile carries while the agent's turn runs: the switch cuts
 *  the turn, and here no popover asks first. */
export const WAIT_FOR_TURN = 'Wait for the turn to end'

/** The harness a tab runs: a chat by its adapter, a terminal by the store's
 *  flags (else the session's own provider); null for a plain terminal. */
export function familyOfTab(
  session: Pick<Session, 'transport' | 'adapterId' | 'provider'>,
  store: TransportFlags | undefined
): LauncherFamily | null {
  // A chat's family is the harness whose chat adapter it runs, read off the
  // table, so a harness gains its chat by its row alone.
  if (session.transport === 'events') return chatFamilyOf(session.adapterId)
  if (store) {
    if (store.codexMode) return 'codex'
    if (store.piMode) return 'pi'
    if (store.opencodeMode) return 'opencode'
    if (store.claudeMode || store.claudeAgentsMode) return 'claude'
    // Antigravity and the plain terminal have no flag the store's type names.
    return session.provider === 'antigravity' ? 'antigravity' : null
  }
  const provider = session.provider === 'claude-agents' ? 'claude' : session.provider
  return provider in HARNESS_BY_ID ? (provider as LauncherFamily) : null
}

/** The harness whose chat adapter this is, in `harnesses` (the real table by
 *  default); null for an adapter no harness names. */
export function chatFamilyOf(
  adapterId: string,
  harnesses: readonly { id: LauncherFamily; chatAdapterId: string | null }[] = HARNESSES
): LauncherFamily | null {
  return harnesses.find((harness) => harness.chatAdapterId === adapterId)?.id ?? null
}

/** The tiles « View as » offers. A chat of a family with a chat adapter: its
 *  views, then the terminal. A terminal of such a family: one tile per chat
 *  view, then the terminal it is, marked active. Anything else (a plain
 *  terminal, a session view's server, a family with no chat adapter): its
 *  views alone, none for a terminal. */
export function transportTiles(
  session: Pick<Session, 'transport' | 'adapterId' | 'provider' | 'state'>,
  store: TransportFlags | undefined,
  views: AvailableView[],
  chatViews: AvailableView[]
): Tile[] {
  const own = views.map(
    (view): Tile => ({ id: view.id, title: view.title, drawing: view.id, kind: 'view' })
  )
  const family = familyOfTab(session, store)
  const chat = family ? HARNESS_BY_ID[family].chatAdapterId : null
  if (!family || !chat) return own
  const disabled =
    session.state === 'working' || session.state === 'blocked' ? WAIT_FOR_TURN : undefined
  const terminal: Tile = {
    id: TERMINAL_TILE,
    title: 'Terminal',
    drawing: TERMINAL_TILE,
    kind: 'transport',
    adapterId: 'pty'
  }
  if (session.transport === 'events')
    return [...own, { ...terminal, ...(disabled ? { disabled } : {}) }]
  return [
    ...chatViews.map(
      (view): Tile => ({
        id: `transport:${view.id}`,
        title: view.title,
        drawing: view.id,
        kind: 'transport',
        adapterId: chat,
        viewId: view.id,
        ...(disabled ? { disabled } : {})
      })
    ),
    // The terminal it is: the active tile, which the menu never moves to.
    terminal
  ]
}

/** What the restart is asked for a transport tile: the adapter, and the view
 *  a chat opens in. */
export function transportSwitchOverrides(tile: Tile): { adapterId: string; viewId?: string } {
  if (tile.kind !== 'transport' || !tile.adapterId)
    throw new Error(`"${tile.id}" is not a transport tile`)
  return { adapterId: tile.adapterId, ...(tile.viewId ? { viewId: tile.viewId } : {}) }
}

/** What the store learns besides the answer. `restartSessionProcess` lays
 *  the patch OVER the answer's fields, so the patch wins: a move to the
 *  terminal patches nothing (the answer's `launchProfileId`, the profile the
 *  spawn resolved, stands); a move to a chat names the family's chat profile. */
export function transportSwitchPatch(
  tile: Tile,
  family: LauncherFamily
): { launchProfileId?: string } {
  return tile.adapterId === 'pty' ? {} : { launchProfileId: CHAT_PROFILE_IDS[family] }
}

import { describe, expect, it } from 'vitest'
import type { Session } from '../../../shared/session-model'
import type { AvailableView } from '../views/resolution'
import {
  TERMINAL_TILE,
  WAIT_FOR_TURN,
  chatFamilyOf,
  familyOfTab,
  transportSwitchOverrides,
  transportSwitchPatch,
  transportTiles
} from './switch-transport'

/**
 * The pane menu's « View as » for a tab that can change transport (lane D,
 * PRDCT-4427): a chat offers its views and the terminal, a terminal of a
 * harness with a chat offers the chat views and itself; a plain terminal and
 * a harness with no chat offer no move.
 */
const session = (patch: Partial<Session> = {}): Session => ({
  id: 's1',
  provider: 'claude',
  transport: 'events',
  cwd: '/project',
  windowKey: 'main',
  state: 'idle',
  createdAt: 0,
  adapterId: 'claude-chat',
  title: 'project',
  ...patch
})
const view = (id: string, title: string): AvailableView => ({
  id: `clave.chat-view/${id}`,
  title,
  pluginName: 'Chat',
  kind: 'native'
})
const chatViews = [view('chat', 'Chat'), view('terminal', 'Enclave'), view('lab', 'Folio')]
const claude = { claudeMode: true, codexMode: false }
const codex = { claudeMode: false, codexMode: true }

describe('the tiles of « View as » (lane D, PRDCT-4427)', () => {
  it('a Claude chat: its views, then the terminal', () => {
    const tiles = transportTiles(session(), claude, chatViews, chatViews)
    expect(tiles.map((t) => [t.kind, t.title])).toEqual([
      ['view', 'Chat'],
      ['view', 'Enclave'],
      ['view', 'Folio'],
      ['transport', 'Terminal']
    ])
    expect(tiles.at(-1)).toMatchObject({ id: TERMINAL_TILE, adapterId: 'pty' })
    expect(tiles.at(-1)?.disabled).toBeUndefined()
  })
  it('a Claude terminal: the chat views as moves onto claude-chat, then itself', () => {
    const tiles = transportTiles(
      session({ transport: 'pty', adapterId: 'pty' }),
      claude,
      [],
      chatViews
    )
    expect(tiles.map((t) => t.title)).toEqual(['Chat', 'Enclave', 'Folio', 'Terminal'])
    expect(tiles[0]).toMatchObject({
      kind: 'transport',
      adapterId: 'claude-chat',
      viewId: 'clave.chat-view/chat',
      drawing: 'clave.chat-view/chat'
    })
    expect(tiles[2]).toMatchObject({ adapterId: 'claude-chat', viewId: 'clave.chat-view/lab' })
    expect(tiles[3]).toMatchObject({ id: TERMINAL_TILE, adapterId: 'pty' })
  })
  it('a Codex terminal moves onto codex-chat', () => {
    const tiles = transportTiles(
      session({ transport: 'pty', adapterId: 'pty', provider: 'codex' }),
      codex,
      [],
      chatViews
    )
    expect(tiles.filter((t) => t.adapterId === 'codex-chat')).toHaveLength(3)
  })
  it('an Antigravity terminal and a plain terminal get no tile; a chat of no harness keeps its views', () => {
    expect(
      transportTiles(
        session({ transport: 'pty', adapterId: 'pty', provider: 'antigravity' }),
        { claudeMode: false, codexMode: false },
        [],
        chatViews
      )
    ).toEqual([])
    expect(
      transportTiles(
        session({ transport: 'pty', adapterId: 'pty', provider: 'terminal' }),
        { claudeMode: false, codexMode: false },
        [],
        chatViews
      )
    ).toEqual([])
    expect(
      transportTiles(session({ adapterId: 'echo', provider: 'echo' }), undefined, chatViews, [])
    ).toHaveLength(3)
  })
  it('a move waits for the turn to end; a view of the chat itself does not', () => {
    const tiles = transportTiles(session({ state: 'working' }), claude, chatViews, chatViews)
    expect(tiles.at(-1)?.disabled).toBe(WAIT_FOR_TURN)
    expect(tiles[0].disabled).toBeUndefined()
    const blocked = transportTiles(
      session({ transport: 'pty', adapterId: 'pty', state: 'blocked' }),
      claude,
      [],
      chatViews
    )
    expect(blocked[0].disabled).toBe(WAIT_FOR_TURN)
  })
  it('reads a chat’s family off the harness table, never a hardcoded adapter', () => {
    expect(familyOfTab(session({ adapterId: 'claude-chat' }), claude)).toBe('claude')
    expect(familyOfTab(session({ adapterId: 'codex-chat' }), codex)).toBe('codex')
    expect(familyOfTab(session({ adapterId: 'unknown-chat' }), undefined)).toBeNull()
    // The day a harness row names its chat adapter, the chat reads as it.
    const table = [
      { id: 'claude' as const, chatAdapterId: 'claude-chat' },
      { id: 'opencode' as const, chatAdapterId: 'opencode-chat' }
    ]
    expect(chatFamilyOf('opencode-chat', table)).toBe('opencode')
  })
  it('reads the family from the session when the store has no record', () => {
    expect(familyOfTab(session({ transport: 'pty', provider: 'codex' }), undefined)).toBe('codex')
    expect(familyOfTab(session({ transport: 'pty', provider: 'terminal' }), undefined)).toBeNull()
    expect(familyOfTab(session({ adapterId: 'codex-chat' }), undefined)).toBe('codex')
  })
})

describe('what the restart is asked (lane D, PRDCT-4427)', () => {
  it('the adapter and the view a chat opens in; the terminal names no view', () => {
    const [chat, , , terminal] = transportTiles(
      session({ transport: 'pty', adapterId: 'pty' }),
      claude,
      [],
      chatViews
    )
    expect(transportSwitchOverrides(chat)).toEqual({
      adapterId: 'claude-chat',
      viewId: 'clave.chat-view/chat'
    })
    expect(transportSwitchOverrides(terminal)).toEqual({ adapterId: 'pty' })
    expect(transportSwitchPatch(chat, 'claude')).toEqual({ launchProfileId: 'claude-chat' })
    expect(transportSwitchPatch(chat, 'codex')).toEqual({ launchProfileId: 'codex-chat' })
    // Nothing patched: the answer's resolved profile stands.
    expect(transportSwitchPatch(terminal, 'claude')).toEqual({})
    expect(transportSwitchPatch(terminal, 'claude')).not.toHaveProperty('launchProfileId')
  })
  it('refuses a tile that is not a move', () => {
    const [own] = transportTiles(session(), claude, chatViews, chatViews)
    expect(() => transportSwitchOverrides(own)).toThrow('not a transport tile')
  })
})

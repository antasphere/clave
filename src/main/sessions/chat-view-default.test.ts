import { beforeEach, expect, it, vi } from 'vitest'

const prefs = vi.hoisted(() => ({
  chatView: null as unknown,
  interactionMode: 'chat' as unknown
}))
vi.mock('../preferences-manager', () => ({
  preferencesManager: {
    get: (key: keyof typeof prefs) => prefs[key],
    set: vi.fn((key: keyof typeof prefs, value: unknown) => (prefs[key] = value))
  }
}))
import { initialChatView, migrateChatView, rememberChatView } from './chat-view-default'

beforeEach(() => {
  prefs.chatView = null
  prefs.interactionMode = 'chat'
})

it('opens a new chat in the view of the interaction mode', () => {
  expect(initialChatView(undefined)).toBe('clave.chat-view/chat')
  prefs.interactionMode = 'enclave'
  expect(initialChatView('clave.chat-view/chat')).toBe('clave.chat-view/terminal')
  prefs.interactionMode = 'folio'
  expect(initialChatView(undefined)).toBe('clave.chat-view/lab')
})

it('opens the Chat view when the mode is the terminal and a chat is forced', () => {
  prefs.interactionMode = 'terminal'
  expect(initialChatView(undefined)).toBe('clave.chat-view/chat')
  expect(initialChatView('clave.chat-view/lab')).toBe('clave.chat-view/chat')
})

it("leaves a profile that names another plugin's view on it", () => {
  prefs.interactionMode = 'enclave'
  expect(initialChatView('acme.viewer/page')).toBe('acme.viewer/page')
})

it('no longer remembers a pane pick: the setting stays the one chosen', () => {
  prefs.interactionMode = 'folio'
  rememberChatView('clave.chat-view/terminal')
  expect(prefs.chatView).toBeNull()
  expect(initialChatView(undefined)).toBe('clave.chat-view/lab')
})

it('moves an old pick into the mode once, while the mode is still its default', () => {
  prefs.chatView = 'clave.chat-view/terminal'
  expect(initialChatView(undefined)).toBe('clave.chat-view/terminal')
  expect(prefs.interactionMode).toBe('enclave')
  expect(prefs.chatView).toBeNull()
  // Once: a later change of the mode is not undone.
  prefs.interactionMode = 'chat'
  migrateChatView()
  expect(prefs.interactionMode).toBe('chat')
})

it('keeps a mode already chosen, and drops an old pick of the wrong shape', () => {
  prefs.interactionMode = 'folio'
  prefs.chatView = 'clave.chat-view/terminal'
  migrateChatView()
  expect(prefs.interactionMode).toBe('folio')
  expect(prefs.chatView).toBeNull()
  prefs.interactionMode = 'chat'
  prefs.chatView = 42
  migrateChatView()
  expect(prefs.interactionMode).toBe('chat')
  expect(prefs.chatView).toBeNull()
  prefs.chatView = 'acme.viewer/page'
  migrateChatView()
  expect(prefs.interactionMode).toBe('chat')
  expect(prefs.chatView).toBeNull()
})

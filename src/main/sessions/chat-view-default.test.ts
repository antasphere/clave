import { beforeEach, expect, it, vi } from 'vitest'

const prefs = vi.hoisted(() => ({ chatView: null as unknown }))
vi.mock('../preferences-manager', () => ({
  preferencesManager: {
    get: (key: 'chatView') => prefs[key],
    set: vi.fn((key: 'chatView', value: unknown) => (prefs[key] = value))
  }
}))
import { initialChatView, rememberChatView } from './chat-view-default'

beforeEach(() => {
  prefs.chatView = null
})

it("opens a new chat in the profile's default until the reader picks a view", () => {
  expect(initialChatView('clave.chat-view/chat')).toBe('clave.chat-view/chat')
  expect(initialChatView(undefined)).toBeUndefined()
})

it('opens every new chat in the last view picked', () => {
  rememberChatView('clave.chat-view/terminal')
  expect(initialChatView('clave.chat-view/chat')).toBe('clave.chat-view/terminal')
  expect(initialChatView(undefined)).toBe('clave.chat-view/terminal')
  rememberChatView('clave.chat-view/compact')
  expect(initialChatView('clave.chat-view/chat')).toBe('clave.chat-view/compact')
})

it("leaves a profile that names another plugin's view on it", () => {
  rememberChatView('clave.chat-view/terminal')
  expect(initialChatView('acme.viewer/page')).toBe('acme.viewer/page')
})

it('ignores a cleared view and a value of the wrong shape', () => {
  rememberChatView('clave.chat-view/terminal')
  rememberChatView(null)
  rememberChatView('not a view')
  expect(initialChatView('clave.chat-view/chat')).toBe('clave.chat-view/terminal')
  prefs.chatView = 42
  expect(initialChatView('clave.chat-view/chat')).toBe('clave.chat-view/chat')
})

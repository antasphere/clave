import { beforeEach, expect, it, vi } from 'vitest'

const prefs = vi.hoisted(() => ({ chatModels: {} as Record<string, unknown> }))
vi.mock('../preferences-manager', () => ({
  preferencesManager: {
    get: (key: 'chatModels') => prefs[key],
    set: vi.fn((key: 'chatModels', value: Record<string, unknown>) => (prefs[key] = value))
  }
}))
import { rememberChatModel, rememberedChatModel } from './chat-model-default'

beforeEach(() => {
  prefs.chatModels = {}
})

it('remembers the pick per chat adapter', () => {
  rememberChatModel('claude-chat', 'opus')
  rememberChatModel('codex-chat', 'gpt-5.5')
  expect(rememberedChatModel('claude-chat')).toBe('opus')
  expect(rememberedChatModel('codex-chat')).toBe('gpt-5.5')
  expect(rememberedChatModel('echo')).toBeUndefined()
})

it('forgets it when the reader picks the provider default', () => {
  rememberChatModel('claude-chat', 'opus')
  rememberChatModel('claude-chat', null)
  expect(rememberedChatModel('claude-chat')).toBeUndefined()
})

it('never stores or hands out a name a launch would refuse', () => {
  rememberChatModel('claude-chat', 'opus')
  rememberChatModel('claude-chat', '--dangerously-skip-permissions')
  expect(rememberedChatModel('claude-chat')).toBe('opus')
  prefs.chatModels = { 'claude-chat': 'opus; rm -rf ~', 'codex-chat': 42 }
  expect(rememberedChatModel('claude-chat')).toBeUndefined()
  expect(rememberedChatModel('codex-chat')).toBeUndefined()
})

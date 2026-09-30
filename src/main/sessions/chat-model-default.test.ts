import { beforeEach, expect, it, vi } from 'vitest'

const prefs = vi.hoisted(() => ({
  chatModels: {} as Record<string, unknown>,
  chatEfforts: {} as Record<string, unknown>
}))
vi.mock('../preferences-manager', () => ({
  preferencesManager: {
    get: (key: 'chatModels' | 'chatEfforts') => prefs[key],
    set: vi.fn(
      (key: 'chatModels' | 'chatEfforts', value: Record<string, unknown>) => (prefs[key] = value)
    )
  }
}))
import {
  rememberChatEffort,
  rememberChatModel,
  rememberedChatEffort,
  rememberedChatModel
} from './chat-model-default'

beforeEach(() => {
  prefs.chatModels = {}
  prefs.chatEfforts = {}
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

it('remembers the effort pick per chat adapter, apart from the model', () => {
  rememberChatEffort('claude-chat', 'high')
  rememberChatEffort('codex-chat', 'xhigh')
  rememberChatEffort('claude-chat', 'max')
  expect(rememberedChatEffort('claude-chat')).toBe('max')
  expect(rememberedChatEffort('codex-chat')).toBe('xhigh')
  expect(rememberedChatEffort('echo')).toBeUndefined()
  expect(prefs.chatModels).toEqual({})
})

it('never stores or hands out an effort a launch would refuse', () => {
  rememberChatEffort('claude-chat', 'high')
  rememberChatEffort('claude-chat', '--x')
  rememberChatEffort('claude-chat', 'high;rm')
  rememberChatEffort('claude-chat', '')
  expect(rememberedChatEffort('claude-chat')).toBe('high')
  prefs.chatEfforts = { 'claude-chat': 'High', 'codex-chat': 3 }
  expect(rememberedChatEffort('claude-chat')).toBeUndefined()
  expect(rememberedChatEffort('codex-chat')).toBeUndefined()
})

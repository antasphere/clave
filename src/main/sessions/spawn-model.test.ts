import { expect, it, vi } from 'vitest'

/* The model main gives a launch naming none, mirrored from `pty-manager.ts`:
   the profile named, else the family's selected one; a chat profile starts on
   its adapter's remembered model, a terminal on its CLI's own default. */
const m = vi.hoisted(() => ({
  selected: 'claude-chat',
  resolve: vi.fn(),
  remembered: { 'claude-chat': 'claude-fable-5-1', 'codex-chat': 'gpt-5.5' } as Record<
    string,
    string
  >
}))
vi.mock('../launch-profile-manager', () => ({
  launchProfileManager: {
    resolve: (family: string, workspaceId?: string | null) => {
      m.resolve(family, workspaceId)
      return { id: m.selected }
    }
  },
  eventsProfile: (id?: string | null) =>
    id === 'claude-chat' || id === 'chat:claude:work'
      ? { adapterId: 'claude-chat' }
      : id === 'codex-chat'
        ? { adapterId: 'codex-chat' }
        : undefined
}))
vi.mock('./chat-model-default', () => ({
  rememberedChatModel: (adapterId: string) => m.remembered[adapterId]
}))
import { rememberedSpawnModel } from './spawn-model'

it('answers the remembered chat model of the profile named, or of the selected one', () => {
  expect(rememberedSpawnModel('claude', 'chat:claude:work', 'ws')).toBe('claude-fable-5-1')
  expect(m.resolve).not.toHaveBeenCalled()
  expect(rememberedSpawnModel('codex', 'codex-chat', null)).toBe('gpt-5.5')
  expect(rememberedSpawnModel('claude', undefined, 'ws')).toBe('claude-fable-5-1')
  expect(m.resolve).toHaveBeenLastCalledWith('claude', 'ws')
})

it('answers nothing for a terminal profile, whose CLI keeps its own default', () => {
  expect(rememberedSpawnModel('claude', 'work', 'ws')).toBeUndefined()
  m.selected = 'work'
  expect(rememberedSpawnModel('claude', undefined, 'ws')).toBeUndefined()
})

import { describe, expect, it, vi } from 'vitest'

vi.mock('../store/launch-profile-store', () => ({
  selectedLaunchProfile: (family: string) => ({
    id: family === 'claude' ? 'claude-chat' : 'codex-terminal'
  })
}))
import { chatAdapterOf, rememberedLaunchModel } from './launch-model'

/**
 * The model a launch is judged by (PRDCT-4302): a chat launch starts on the
 * model last picked in its adapter's composer, a terminal CLI on a default
 * this Mac cannot read. Passing the wrong one skips an account that could
 * take the launch, or lands on one whose family cap is out.
 */
describe('chatAdapterOf', () => {
  it('names the chat adapter of a built-in chat profile and of a derived chat variant', () => {
    expect(chatAdapterOf('claude', 'claude-chat')).toBe('claude-chat')
    expect(chatAdapterOf('codex', 'codex-chat')).toBe('codex-chat')
    expect(chatAdapterOf('claude', 'chat:claude:work')).toBe('claude-chat')
    expect(chatAdapterOf('codex', 'chat:codex:work')).toBe('codex-chat')
  })
  it('is nothing for a terminal profile, or a chat of the other family', () => {
    expect(chatAdapterOf('claude', 'claude-work')).toBeNull()
    expect(chatAdapterOf('claude', 'codex-chat')).toBeNull()
    expect(chatAdapterOf('codex', 'chat:claude:work')).toBeNull()
  })
})

describe('rememberedLaunchModel', () => {
  /** Main's answer per adapter (PRDCT-4420: the read goes to the manager
   *  that holds the composer's pick, keyed by adapter, never to a key of the
   *  renderer's own preference file). */
  const read = (models: unknown): ((adapterId: string) => Promise<string | null | undefined>) =>
    vi.fn(async (adapterId: string) =>
      models && typeof models === 'object'
        ? ((models as Record<string, string>)[adapterId] ?? null)
        : (models as string | null | undefined)
    )
  it('reads the remembered model of the chat adapter the launch profile stands for', async () => {
    const r = read({ 'claude-chat': 'claude-opus-5-5', 'codex-chat': 'gpt-5.5' })
    expect(await rememberedLaunchModel('claude', 'claude-chat', null, r)).toBe('claude-opus-5-5')
    expect(await rememberedLaunchModel('codex', 'chat:codex:work', 'ws', r)).toBe('gpt-5.5')
    expect(r).toHaveBeenCalledWith('claude-chat')
    expect(r).toHaveBeenCalledWith('codex-chat')
  })
  it('asks main by adapter id, never the renderer preference file by key', async () => {
    const r = read({ 'claude-chat': 'claude-opus-5-5' })
    await rememberedLaunchModel('claude', 'claude-chat', null, r)
    expect(r).not.toHaveBeenCalledWith('chatModels')
  })
  it("falls to the family's selected profile when the launch names none", async () => {
    const r = read({ 'claude-chat': 'claude-opus-5-5', 'codex-chat': 'gpt-5.5' })
    expect(await rememberedLaunchModel('claude', undefined, 'ws', r)).toBe('claude-opus-5-5')
    // The selected Codex profile is a terminal: its model is the CLI's own.
    expect(await rememberedLaunchModel('codex', undefined, 'ws', r)).toBeUndefined()
  })
  it('knows nothing for a terminal launch, a missing or malformed preference, or a stored default alias', async () => {
    expect(
      await rememberedLaunchModel('claude', 'claude-work', null, read({ 'claude-chat': 'x' }))
    ).toBeUndefined()
    expect(
      await rememberedLaunchModel('claude', 'claude-chat', null, read(undefined))
    ).toBeUndefined()
    expect(await rememberedLaunchModel('claude', 'claude-chat', null, read(42))).toBeUndefined()
    expect(
      await rememberedLaunchModel('claude', 'claude-chat', null, read({ 'claude-chat': 'bad..id' }))
    ).toBeUndefined()
    expect(
      await rememberedLaunchModel('claude', 'claude-chat', null, read({ 'claude-chat': 'default' }))
    ).toBeUndefined()
    expect(
      await rememberedLaunchModel(
        'claude',
        'claude-chat',
        null,
        read({ 'claude-chat': 'default[1m]' })
      )
    ).toBeUndefined()
    const failing = vi.fn(async () => {
      throw new Error('no preferences')
    })
    expect(await rememberedLaunchModel('claude', 'claude-chat', null, failing)).toBeUndefined()
  })
})

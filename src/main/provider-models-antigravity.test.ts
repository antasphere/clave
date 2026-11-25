import { afterEach, expect, it, vi } from 'vitest'

const cli = vi.hoisted(() => ({
  list: vi.fn(async (): Promise<{ id: string; label: string }[]> => [{ id: 'm', label: 'M' }])
}))
vi.mock('./antigravity-cli', () => ({
  antigravityCommand: () => 'agy',
  listAntigravityModels: cli.list
}))
vi.mock('./pty-manager', () => ({}))
vi.mock('./sessions/session-manager', () => ({ sessionManager: { getAdapter: () => undefined } }))
vi.mock('./sessions/adapters/claude-adapter', () => ({ ClaudeAdapter: class {} }))
vi.mock('./sessions/adapters/codex-adapter', () => ({ CodexAdapter: class {} }))
vi.mock('./sessions/adapters/echo-adapter', () => ({ EchoAdapter: class {} }))
vi.mock('./launch-profile-manager', () => ({ launchProfileManager: {} }))
import { providerModels } from './provider-models'

afterEach(() => vi.useRealTimers())

it('keeps a list five minutes and a failure one', async () => {
  vi.useFakeTimers()
  const read = (): Promise<unknown> => providerModels('antigravity-chat', '/').catch(() => 'failed')
  await read()
  vi.advanceTimersByTime(4 * 60_000)
  await read()
  expect(cli.list).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(61_000)
  cli.list.mockRejectedValueOnce(new Error('signed out'))
  expect(await read()).toBe('failed')
  vi.advanceTimersByTime(30_000)
  await read()
  expect(cli.list).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(31_000)
  await read()
  expect(cli.list).toHaveBeenCalledTimes(3)
})

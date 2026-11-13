import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  // The handlers import the shell's settings source, which reads the launch
  // decision (`server-launch.ts`), which reads whether the app is packaged.
  app: { isPackaged: false }
}))

describe('main’s usage poll', () => {
  it('reads with the server in this process, or none named yet, and a window open', async () => {
    const { shouldPollUsage } = await import('./usage-handlers')
    expect(shouldPollUsage('in-process', true)).toBe(true)
    expect(shouldPollUsage(null, true)).toBe(true)
  })
  it('stays still with the server in another process, or with no window', async () => {
    const { shouldPollUsage } = await import('./usage-handlers')
    expect(shouldPollUsage('attached', true)).toBe(false)
    expect(shouldPollUsage('in-process', false)).toBe(false)
  })
})

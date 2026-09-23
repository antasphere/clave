import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (buffer: Buffer) => buffer.toString()
  }
}))

// The machine as it was found: two items under the same service. A lookup by
// service alone answers the stray one (account "unknown", MCP tokens only);
// the login lives under the macOS username.
const calls: string[][] = []
vi.mock('child_process', () => ({
  execFile: (
    _file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, out?: { stdout: string }) => void
  ) => {
    calls.push(args)
    const i = args.indexOf('-a')
    const account = i === -1 ? null : args[i + 1]
    if (account === null) {
      cb(null, { stdout: JSON.stringify({ mcpOAuth: { server: {} } }) })
    } else if (account === os.userInfo().username) {
      cb(null, { stdout: JSON.stringify({ claudeAiOauth: { accessToken: 'the-login' } }) })
    } else {
      cb(new Error('The specified item could not be found in the keychain.'))
    }
  }
}))

import { readLimitsWith } from './usage-manager'

describe('the keychain read', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    calls.length = 0
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reads the login under the username, not the stray item beside it', async () => {
    const result = await readLimitsWith({ kind: 'keychain' })

    expect(result).not.toHaveProperty('error')
    expect(calls[0]).toEqual(expect.arrayContaining(['-a', os.userInfo().username]))
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer the-login')
  })
})

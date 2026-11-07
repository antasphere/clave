import { expect, test, vi } from 'vitest'
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  existsSync: () => false
}))
import { secureFiles } from './platform'

test('missing native helper returns a typed error without a Node filesystem fallback', async () => {
  await expect(secureFiles.read(__filename, 100)).rejects.toMatchObject({
    _tag: 'FileOperationFailed',
    code: 'io',
    message: expect.stringContaining('helper is unavailable')
  })
})

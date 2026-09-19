import { afterEach, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const mocked = vi.hoisted(() => ({ value: '', setPath: vi.fn() }))
vi.mock('electron', () => ({
  app: { commandLine: { getSwitchValue: () => mocked.value }, setPath: mocked.setPath }
}))
const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.resetModules()
  vi.clearAllMocks()
})

test('resolves and creates a relative isolated profile before assigning Electron paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clave-profile-'))
  directories.push(root)
  const target = join(root, 'new-profile')
  mocked.value = relative(process.cwd(), target)
  await import('./user-data-override')
  expect(existsSync(target)).toBe(true)
  expect(mocked.setPath.mock.calls).toEqual([
    ['userData', target],
    ['sessionData', target]
  ])
})

test('keeps the normal app profile when no override is requested', async () => {
  mocked.value = ''
  await import('./user-data-override')
  expect(mocked.setPath).not.toHaveBeenCalled()
})

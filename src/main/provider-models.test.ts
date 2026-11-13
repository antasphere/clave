import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EchoAdapter } from './sessions/adapters/echo-adapter'

const echo = new EchoAdapter()

vi.mock('./sessions/session-manager', () => ({
  sessionManager: { getAdapter: (id: string) => (id === 'echo' ? echo : undefined) }
}))
vi.mock('./pty-manager', () => ({
  buildSpawnEnv: () => ({}),
  codexHomeForSpawn: () => undefined,
  getLoginShellEnv: () => ({})
}))
vi.mock('./launch-profile-manager', () => ({
  launchProfileManager: { resolve: () => undefined }
}))

import { providerModels } from './provider-models'

describe('the provider model list', () => {
  it('imports nothing from Electron, so a Clave server can list models', () => {
    const source = readFileSync(join(__dirname, 'provider-models.ts'), 'utf8')
    expect(source).not.toMatch(/from ['"]electron['"]/)
    expect(source).not.toMatch(/require\(['"]electron['"]\)/)
  })

  it('asks an adapter once, and asks again after a listing failed', async () => {
    const models = vi
      .spyOn(echo, 'models')
      .mockRejectedValueOnce(new Error('app-server down'))
      .mockResolvedValue([{ value: 'echo-1', label: 'Echo 1' }] as never)

    await expect(providerModels('echo', '/work')).rejects.toThrow('app-server down')
    const first = providerModels('echo', '/work')
    const second = providerModels('echo', '/elsewhere')
    expect(second).toBe(first)
    await expect(first).resolves.toEqual([{ value: 'echo-1', label: 'Echo 1' }])
    expect(models).toHaveBeenCalledTimes(2)
  })

  it('refuses an adapter with no model list outside a session, and keeps no failure', async () => {
    const first = providerModels('plugin-x', '/work')
    await expect(first).rejects.toThrow('No model list without a session for plugin-x')
    const second = providerModels('plugin-x', '/work')
    expect(second).not.toBe(first)
    await expect(second).rejects.toThrow('No model list without a session for plugin-x')
  })
})

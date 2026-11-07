import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('./agent-updates', () => ({ agentUpdateManager: { checkAll: vi.fn() } }))
vi.mock('./test-mode', () => ({ TEST_NO_ACTIVATE: false, TEST_ONBOARDING: false }))
vi.mock('./preferences-manager', () => ({ preferencesManager: { get: vi.fn(), set: vi.fn() } }))
vi.mock('./sessions/adapters/pty-backend', () => ({
  getUserShell: () => '/bin/zsh',
  loginShellEnvAsync: async () => ({}),
  refreshLoginShellEnv: async () => ({})
}))

import { codexInstallCommand, createWorkspaceFolder, findOnPath, folderNameOf } from './onboarding'

/**
 * The first-run walk's rules in main: an agent is found the way a login shell
 * would find it, Codex is installed with what the Mac has, and the first
 * workspace's folder is one plain segment under the place the reader chose.
 */
function binDir(...commands: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-onb-'))
  for (const command of commands) {
    const file = path.join(dir, command)
    fs.writeFileSync(file, '#!/bin/sh\n')
    fs.chmodSync(file, 0o755)
  }
  return dir
}

describe('findOnPath', () => {
  it('finds an executable in the first folder that holds it', () => {
    const a = binDir('claude')
    const b = binDir('claude', 'codex')
    expect(findOnPath('claude', `${a}:${b}`)).toBe(path.join(a, 'claude'))
    expect(findOnPath('codex', `${a}:${b}`)).toBe(path.join(b, 'codex'))
  })

  it('ignores a file that is not executable, and an empty PATH', () => {
    const dir = binDir()
    fs.writeFileSync(path.join(dir, 'claude'), 'not a program')
    expect(findOnPath('claude', dir)).toBeNull()
    expect(findOnPath('claude', undefined)).toBeNull()
    expect(findOnPath('claude', '::')).toBeNull()
  })
})

describe('codexInstallCommand', () => {
  it('prefers npm, then the Homebrew cask, then nothing', () => {
    expect(codexInstallCommand(`${binDir('npm')}:${binDir('brew')}`)).toBe(
      'npm install -g @openai/codex'
    )
    expect(codexInstallCommand(binDir('brew'))).toBe('brew install --cask codex')
    expect(codexInstallCommand(binDir())).toBeNull()
  })
})

describe('the first workspace folder', () => {
  it('keeps a name to one visible segment', () => {
    expect(folderNameOf('My workspace')).toBe('My workspace')
    expect(folderNameOf('a/b:c')).toBe('a b c')
    expect(folderNameOf('..hidden')).toBe('hidden')
    expect(folderNameOf('   ')).toBeNull()
    expect(folderNameOf('x'.repeat(121))).toBeNull()
  })

  it('creates the folder under the chosen place, and takes one already there', () => {
    const parent = binDir()
    const made = createWorkspaceFolder(parent, 'My workspace')
    expect(made).toBe(path.join(parent, 'My workspace'))
    expect(fs.statSync(made).isDirectory()).toBe(true)
    fs.writeFileSync(path.join(made, 'notes.md'), 'kept')
    expect(createWorkspaceFolder(parent, 'My workspace')).toBe(made)
    expect(fs.readFileSync(path.join(made, 'notes.md'), 'utf-8')).toBe('kept')
  })

  it('refuses a relative place, an empty name and a file in the way', () => {
    const parent = binDir()
    fs.writeFileSync(path.join(parent, 'taken'), '')
    expect(() => createWorkspaceFolder('relative', 'x')).toThrow(/where/)
    expect(() => createWorkspaceFolder(parent, '  ')).toThrow(/name/)
    expect(() => createWorkspaceFolder(parent, 'taken')).toThrow(/file/)
  })
})

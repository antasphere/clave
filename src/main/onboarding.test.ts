import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('./agent-updates', () => ({
  agentUpdateManager: { checkAll: vi.fn(() => Promise.resolve()) }
}))
vi.mock('./test-mode', () => ({ TEST_NO_ACTIVATE: false, TEST_ONBOARDING: false }))
const prefs = vi.hoisted(() => ({ values: {} as Record<string, unknown> }))
vi.mock('./preferences-manager', () => ({
  preferencesManager: {
    get: (key: string) => prefs.values[key],
    set: (key: string, value: unknown) => void (prefs.values[key] = value)
  }
}))
// The login environment the walk reads: a PATH a test sets, behind a delay
// like the real login shell's, so two clicks can land inside it.
const login = vi.hoisted(() => ({ env: {} as Record<string, string> }))
vi.mock('./sessions/adapters/pty-backend', () => ({
  loginShellEnvAsync: async () => login.env,
  refreshLoginShellEnv: async () => {
    await new Promise((r) => setTimeout(r, 40))
    return login.env
  }
}))
vi.mock('./sessions/chat-view-default', () => ({ rememberChatView: vi.fn() }))

import {
  codexInstallCommand,
  createWorkspaceFolder,
  findOnPath,
  folderNameOf,
  getOnboardingState,
  installAgent,
  releaseOnboardingWindow,
  runInstaller
} from './onboarding'

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

describe('the one-click install', () => {
  const env = { PATH: '/usr/bin:/bin' }

  it('fails when the download in the pipe fails, not only the last command', async () => {
    expect((await runInstaller('false | cat', env)).ok).toBe(false)
    expect((await runInstaller('echo hi | cat', env)).ok).toBe(true)
  })

  it('ends every child of the installer when it takes too long', async () => {
    const marker = path.join(binDir(), 'still-running')
    const started = Date.now()
    const result = await runInstaller(`(sleep 2; touch ${JSON.stringify(marker)}) & wait`, env, 200)
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/too long/)
    expect(Date.now() - started).toBeLessThan(1500)
    await new Promise((r) => setTimeout(r, 2300))
    expect(fs.existsSync(marker)).toBe(false)
  }, 6000)

  it('runs one install when Install is clicked twice', async () => {
    // A fake npm that counts its runs and puts a `codex` on the PATH.
    const bin = binDir()
    const count = path.join(bin, 'runs')
    fs.writeFileSync(
      path.join(bin, 'npm'),
      `#!/bin/sh\necho x >> ${JSON.stringify(count)}\nsleep 0.2\nprintf '#!/bin/sh\\n' > ${JSON.stringify(path.join(bin, 'codex'))}\nchmod +x ${JSON.stringify(path.join(bin, 'codex'))}\n`
    )
    fs.chmodSync(path.join(bin, 'npm'), 0o755)
    login.env = { PATH: `${bin}:/usr/bin:/bin` }
    const [first, second] = await Promise.all([installAgent('codex'), installAgent('codex')])
    expect(fs.readFileSync(count, 'utf-8').trim().split('\n')).toHaveLength(1)
    expect([first.ok, second.ok].sort()).toEqual([false, true])
    expect(first.agents.concat(second.agents).some((a) => a.id === 'codex' && a.installed)).toBe(
      true
    )
  })
})

describe('the window that shows the walk', () => {
  it('is the first one that asks, until it closes', () => {
    prefs.values.onboarding = 'pending'
    expect(getOnboardingState(1).show).toBe(true)
    expect(getOnboardingState(2).show).toBe(false)
    expect(getOnboardingState(1).show).toBe(true)
    releaseOnboardingWindow(2)
    expect(getOnboardingState(2).show).toBe(false)
    releaseOnboardingWindow(1)
    expect(getOnboardingState(2).show).toBe(true)
    prefs.values.onboarding = 'done'
    expect(getOnboardingState(2).show).toBe(false)
  })
})

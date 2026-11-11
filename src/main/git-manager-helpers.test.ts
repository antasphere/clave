import { afterAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The git panel's two one-shots on the helpers runner (PRDCT-4326): they used
// to run a bare `claude`, whatever the launch profile said. The CLI is a stub.

type Callback = (err: Error | null, stdout: string, stderr: string) => void
const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  resolve: vi.fn()
}))
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: mocks.execFile
}))
vi.mock('./sessions/adapters/pty-backend', () => ({
  getLoginShellEnv: () => ({ PATH: '/bin', CLAUDECODE: '1' }),
  getUserShell: () => '/bin/zsh',
  // The default account is a token account: the helper must run on it.
  accountTokenForSpawn: async (kind: string, id: string | undefined) =>
    kind === 'claude' && id === undefined ? 'sk-ant-oat01-default' : undefined
}))
vi.mock('./launch-profile-manager', () => ({
  launchProfileManager: { resolveClaudeCli: mocks.resolve }
}))
vi.mock('./shell-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./shell-launch')>()),
  findExecutable: (command: string) => command
}))

import { gitManager } from './git-manager'

function stub(replies: Array<{ err?: Error; stdout?: string; stderr?: string }>): string[] {
  const prompts: string[] = []
  mocks.execFile.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, finish: Callback) => {
      const reply = replies.shift() ?? { stdout: '' }
      const stdin = {
        write: (text: string) => prompts.push(text),
        end: () =>
          setImmediate(() => finish(reply.err ?? null, reply.stdout ?? '', reply.stderr ?? '')),
        on: vi.fn()
      }
      return { stdin, kill: vi.fn(), once: vi.fn() }
    }
  )
  return prompts
}

describe('the push summary helper from the git manager', () => {
  it("starts the way a session does: the default launch profile's command, the helper's arguments", async () => {
    mocks.resolve.mockReturnValue({
      id: 'custom',
      name: 'Custom',
      family: 'claude',
      command: ['/opt/bin/my-claude', '--wrapper'],
      additionalArgs: []
    })
    const prompts = stub([{ stdout: 'Faster sync\nPulls run in parallel.\nNext: nothing.' }])
    const summary = await gitManager.summarizePushGroup('/repo', ['feat: parallel pulls'], '1 file')
    expect(summary).toEqual({ title: 'Faster sync', description: 'Pulls run in parallel.' })
    expect(mocks.resolve).toHaveBeenCalledWith(undefined, undefined)
    const [file, args, opts] = mocks.execFile.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> }
    ]
    expect(file).toBe('/opt/bin/my-claude')
    expect(args.slice(0, 4)).toEqual(['--wrapper', '-p', '--model', 'haiku'])
    expect(args).toContain('--system-prompt')
    expect(opts.env.CLAUDECODE).toBeUndefined()
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-default')
    expect(prompts[0]).toContain('<commit-messages>\n- feat: parallel pulls\n</commit-messages>')
  })

  it('retries once, then says what the CLI said', async () => {
    mocks.resolve.mockReturnValue({
      id: 'claude',
      name: 'Claude',
      family: 'claude',
      command: ['claude'],
      additionalArgs: []
    })
    const failed = Object.assign(new Error('Command failed: claude -p ...'), { code: 1 })
    mocks.execFile.mockClear()
    stub([
      { err: failed, stderr: 'boom' },
      { err: failed, stderr: 'boom again' }
    ])
    await expect(gitManager.summarizePushGroup('/repo', ['x'], '')).rejects.toThrow(/boom again/)
    expect(mocks.execFile).toHaveBeenCalledTimes(2)
  })

  it('a login shell that cannot find the command says so the way the panel reads it', async () => {
    mocks.resolve.mockReturnValue({
      id: 'claude',
      name: 'Claude',
      family: 'claude',
      command: ['claude'],
      additionalArgs: []
    })
    const missing = Object.assign(new Error('Command failed: /bin/zsh -lic ...'), { code: 127 })
    stub([{ err: missing, stderr: 'zsh:1: command not found: claude' }, { err: missing }])
    await expect(gitManager.summarizePushGroup('/repo', ['x'], '')).rejects.toThrow(
      /claude: command not found/
    )
  })
})

const scratch = mkdtempSync(path.join(realpathSync(tmpdir()), 'clave-git-helpers-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('the commit message helper from the git manager', () => {
  it("starts the way a session does: the default launch profile's command, on the default account", async () => {
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: scratch, encoding: 'utf-8' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    writeFileSync(path.join(scratch, 'a.txt'), 'one\n')
    git('add', '.')
    git('commit', '-qm', 'feat: the first one')
    writeFileSync(path.join(scratch, 'a.txt'), 'one\ntwo\n')
    git('add', '.')
    mocks.resolve.mockReturnValue({
      id: 'custom',
      name: 'Custom',
      family: 'claude',
      command: ['/opt/bin/my-claude', '--wrapper'],
      additionalArgs: []
    })
    mocks.execFile.mockClear()
    const prompts = stub([{ stdout: 'feat: add the second line\n\nNext: push it.' }])
    await expect(gitManager.generateCommitMessage(scratch)).resolves.toBe(
      'feat: add the second line'
    )
    const [file, args, opts] = mocks.execFile.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> }
    ]
    expect(file).toBe('/opt/bin/my-claude')
    expect(args.slice(0, 4)).toEqual(['--wrapper', '-p', '--model', 'haiku'])
    expect(args).toContain('--system-prompt')
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-default')
    expect(prompts[0]).toMatch(/<diff>\n[\s\S]*\+two[\s\S]*\n<\/diff>/)
    expect(prompts[0]).toContain('<recent-commits>\nfeat: the first one\n</recent-commits>')
  })
})

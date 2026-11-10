import { describe, expect, it, vi } from 'vitest'

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
  accountTokenForSpawn: async () => undefined
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

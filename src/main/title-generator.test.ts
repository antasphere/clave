import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  inMemorySessionWindows,
  installSessionWindows,
  type SessionWindowsPort
} from './sessions/windows'

// The module reaches for Electron, the PTY backend's login-shell env and the
// history store at import; none of them is needed here. The CLI itself is a
// stub: what it was asked and what it answered is the whole of these tests.

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  prompts: [] as string[],
  stdout: 'follow the first message',
  error: null as Error | null,
  /** The launch profile manager's Claude-CLI resolver, answering with the tab's profile. */
  resolve: vi.fn(),
  profile: {
    id: 'work',
    name: 'Work',
    family: 'claude' as const,
    command: ['/opt/agents/claude-work', '--profile', 'work'],
    additionalArgs: ['--add-dir', '/tmp']
  },
  /** The account store: one token account, `acct-work`. */
  getToken: vi.fn((id: string | undefined) =>
    id === 'acct-work' ? 'sk-ant-oat01-account' : undefined
  )
}))
// The generator imports no Electron (PRDCT-3293): asking for it fails the import.
vi.mock('electron', () => {
  throw new Error('the title generator imported electron')
})
vi.mock('child_process', () => ({ execFile: mocks.execFile }))
// The login shell of the machine this was found on: a Nushell profile that
// exported a `claude setup-token` token as ANTHROPIC_API_KEY.
vi.mock('./sessions/adapters/pty-backend', () => ({
  getLoginShellEnv: () => ({
    PATH: '/bin',
    CLAUDECODE: '1',
    ANTHROPIC_API_KEY: 'sk-ant-oat01-login'
  }),
  getUserShell: () => '/bin/zsh',
  accountTokenForSpawn: (kind: string, id: string | undefined) =>
    kind === 'claude' ? mocks.getToken(id) : undefined
}))
vi.mock('./launch-profile-manager', () => ({
  launchProfileManager: { resolveClaudeCli: mocks.resolve }
}))
// The profile's command is found on the login PATH: it starts directly.
vi.mock('./shell-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./shell-launch')>()),
  findExecutable: (command: string) => command
}))
vi.mock('./session-history', () => ({ TITLE_HELPER_MARKER: 'Generate a short 2-4 word title' }))

import { TITLE_CLI_ARGS, cleanup, notifyChatMessage, scheduleChatTitle } from './title-generator'

describe('title generation CLI arguments', () => {
  it('asks Haiku for one turn with no MCP server, skill or tool', () => {
    expect(TITLE_CLI_ARGS.slice(0, 3)).toEqual(['-p', '--model', 'haiku'])
    expect(TITLE_CLI_ARGS).toContain('--strict-mcp-config')
    const config = TITLE_CLI_ARGS[TITLE_CLI_ARGS.indexOf('--mcp-config') + 1]
    expect(JSON.parse(config)).toEqual({ mcpServers: {} })
    expect(TITLE_CLI_ARGS).toContain('--disable-slash-commands')
    expect(TITLE_CLI_ARGS[TITLE_CLI_ARGS.indexOf('--tools') + 1]).toBe('')
  })

  it('keeps the user settings in force and the prompt off the command line', () => {
    // `--setting-sources ''` would drop an auth helper; a positional prompt
    // would be swallowed by the variadic `--tools`.
    expect(TITLE_CLI_ARGS).not.toContain('--setting-sources')
    expect(TITLE_CLI_ARGS.at(-1)).toBe('')
    expect(TITLE_CLI_ARGS.at(-2)).toBe('--tools')
  })
})

// A chat tab has no PTY and no transcript watcher, so nothing named it: it kept
// its folder name for the conversation's whole life. These pin the main-process
// half of the fix: a fresh chat tab is named by its first message worth a
// title, once, and a resumed or closed one is left alone.

type Callback = (err: Error | null, stdout: string, stderr: string) => void
let sequence = 0
/** A window the tab is in, as the session windows port names it: its key,
 *  and what the per-window arm sent it. */
function window(): { win: string; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  const key = `win-${++sequence}`
  const port: SessionWindowsPort = {
    ...inMemorySessionWindows(),
    send: (windowKey, channel, ...args) => {
      if (windowKey === key) send(channel, ...args)
    }
  }
  installSessionWindows(port)
  return { win: key, send }
}
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.prompts.length = 0
  mocks.stdout = 'follow the first message'
  mocks.error = null
  mocks.resolve.mockReturnValue(mocks.profile)
  mocks.execFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, callback: Callback) => {
      const stdin = { write: (text: string) => mocks.prompts.push(text), end: vi.fn() }
      setImmediate(() => callback(mocks.error, mocks.stdout, ''))
      return { stdin }
    }
  )
})

describe('a chat tab is named by its first message', () => {
  it('asks the CLI for a title from the first message and hands it to the tab', async () => {
    const id = `chat-${++sequence}`
    const { win, send } = window()
    scheduleChatTitle(id)
    notifyChatMessage(id, 'please make the sidebar tab follow the first message I send', win)
    await settled()
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    expect(mocks.execFile.mock.calls[0][0]).toBe('/opt/agents/claude-work')
    expect(mocks.execFile.mock.calls[0][1]).toEqual(['--profile', 'work', ...TITLE_CLI_ARGS])
    expect(mocks.prompts.join('')).toContain('follow the first message I send')
    expect(send).toHaveBeenCalledWith(`session:auto-title:${id}`, 'follow the first message')
  })

  it('runs the CLI in a one-shot environment: no nested marker, the token where the CLI reads it, time to boot', async () => {
    // With the token left in ANTHROPIC_API_KEY the API answers 401 and the
    // CLI retries past any timeout; the heuristic then named every tab.
    const id = `chat-${++sequence}`
    const { win } = window()
    scheduleChatTitle(id)
    notifyChatMessage(id, 'please make the sidebar tab follow the first message I send', win)
    await settled()
    const opts = mocks.execFile.mock.calls[0][2] as { env: Record<string, string>; timeout: number }
    expect(opts.env.CLAUDECODE).toBeUndefined()
    expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-login')
    expect(opts.env.PATH).toBe('/bin')
    expect(opts.timeout).toBeGreaterThanOrEqual(30000)
  })

  it("runs the agent the tab runs: its workspace's profile, on its account", async () => {
    // A tab on a custom Claude profile and a token account is named by that
    // command on that account — the same as the conversation itself, so a
    // usage cap or a binary only the profile knows never lands on the machine
    // login by surprise.
    const id = `chat-${++sequence}`
    const { win } = window()
    scheduleChatTitle(id, {
      workspaceId: 'ws-1',
      launchProfileId: 'chat:claude:work',
      claudeProfileId: 'acct-work',
      configDir: '/Users/me/.claude-work'
    })
    notifyChatMessage(id, 'please make the sidebar tab follow the first message I send', win)
    await settled()
    expect(mocks.resolve).toHaveBeenCalledWith('ws-1', 'chat:claude:work')
    const opts = mocks.execFile.mock.calls[0][2] as { env: Record<string, string> }
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-account')
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe('/Users/me/.claude-work')
  })

  it('asks once: a later message changes nothing', async () => {
    const id = `chat-${++sequence}`
    const { win, send } = window()
    scheduleChatTitle(id)
    notifyChatMessage(id, 'please make the sidebar tab follow the first message', win)
    await settled()
    notifyChatMessage(id, 'now make the second message change nothing at all', win)
    await settled()
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a slash command or a bare yes does not spend the title; the next real message does', async () => {
    const id = `chat-${++sequence}`
    const { win, send } = window()
    scheduleChatTitle(id)
    notifyChatMessage(id, '/help', win)
    notifyChatMessage(id, 'yes', win)
    notifyChatMessage(id, '  ok  ', win)
    await settled()
    expect(mocks.execFile).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    notifyChatMessage(id, 'refactor the session store into smaller slices', win)
    await settled()
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(`session:auto-title:${id}`, 'follow the first message')
  })

  it('a tab that was never scheduled (a resumed conversation) keeps its name', async () => {
    const id = `chat-${++sequence}`
    const { win, send } = window()
    notifyChatMessage(id, 'please make the sidebar tab follow the first message', win)
    await settled()
    expect(mocks.execFile).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('a closed tab is forgotten before its first message', async () => {
    const id = `chat-${++sequence}`
    const { win, send } = window()
    scheduleChatTitle(id)
    cleanup(id)
    notifyChatMessage(id, 'please make the sidebar tab follow the first message', win)
    await settled()
    expect(mocks.execFile).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("falls back to the message's own words when the CLI is missing", async () => {
    const id = `chat-${++sequence}`
    const { win, send } = window()
    mocks.error = new Error('spawn claude ENOENT')
    scheduleChatTitle(id)
    notifyChatMessage(id, 'please fix the auth middleware timeout on login', win)
    await settled()
    expect(send).toHaveBeenCalledWith(`session:auto-title:${id}`, 'fix the auth middleware')
  })

  it('a window gone before the title arrived receives nothing', async () => {
    const id = `chat-${++sequence}`
    const { send } = window()
    scheduleChatTitle(id)
    notifyChatMessage(id, 'please make the sidebar tab follow the first message', 'gone-window')
    await settled()
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })
})

// The quit ends the one-shot CLI (PRDCT-3375): wave 3's verifier found a
// `claude -p` alive after the server had stopped, a child in its own process
// group that nothing of the sessions' shutdown reached. `cancelAll` is what
// the sessions' shutdown calls now.
describe('a quit ends the title jobs', () => {
  it('signals the running CLI, and its late answer names no tab', async () => {
    const { cancelAll, runningTitleJobs } = await import('./title-generator')
    let finish!: Callback
    const kill = vi.fn()
    const exitListeners: Array<() => void> = []
    mocks.execFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: Callback) => {
        finish = callback
        return {
          stdin: { write: vi.fn(), end: vi.fn() },
          kill,
          once: (event: string, listener: () => void) => {
            if (event === 'exit') exitListeners.push(listener)
          }
        }
      }
    )
    const id = `chat-${++sequence}`
    const { win, send } = window()
    scheduleChatTitle(id)
    notifyChatMessage(id, 'please make the sidebar tab follow the first message I send', win)
    await settled()
    expect(runningTitleJobs()).toBe(1)
    cancelAll()
    expect(kill).toHaveBeenCalledWith('SIGTERM')
    // The CLI dies on the signal: its callback reports the kill.
    for (const listener of exitListeners) listener()
    finish(new Error('killed'), '', '')
    await settled()
    expect(runningTitleJobs()).toBe(0)
    // Before the change the kill's error fell to the heuristic, which named
    // the tab on its way out.
    expect(send).not.toHaveBeenCalledWith(`session:auto-title:${id}`, expect.anything())
  })

  it('refuses the jobs still queued behind the running one', async () => {
    const { cancelAll } = await import('./title-generator')
    const kill = vi.fn()
    mocks.execFile.mockImplementation(() => ({
      stdin: { write: vi.fn(), end: vi.fn() },
      kill,
      once: vi.fn()
    }))
    const first = `chat-${++sequence}`
    const second = `chat-${++sequence}`
    const { win, send } = window()
    scheduleChatTitle(first)
    scheduleChatTitle(second)
    notifyChatMessage(first, 'please make the sidebar tab follow the first message I send', win)
    notifyChatMessage(second, 'and name the second tab from its own first message too', win)
    await settled()
    // One CLI at a time: the second waits in the queue.
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    cancelAll()
    await settled()
    expect(kill).toHaveBeenCalledTimes(1)
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalledWith(`session:auto-title:${second}`, expect.anything())
  })
})

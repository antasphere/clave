import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  /** Replies handed out one per call before `stdout` takes over. */
  replies: [] as string[],
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

  it('gives the helper a system prompt of its own', () => {
    const value = TITLE_CLI_ARGS[TITLE_CLI_ARGS.indexOf('--system-prompt') + 1]
    expect(value).toMatch(/not an assistant/)
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
  // A title may take two tries (the retry), each a few ticks of its own.
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setImmediate(resolve))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.prompts.length = 0
  mocks.stdout = 'follow the first message'
  mocks.replies.length = 0
  mocks.error = null
  mocks.resolve.mockReturnValue(mocks.profile)
  mocks.execFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, callback: Callback) => {
      const stdin = { write: (text: string) => mocks.prompts.push(text), end: vi.fn() }
      const reply = mocks.replies.length ? mocks.replies.shift()! : mocks.stdout
      setImmediate(() => callback(mocks.error, reply, ''))
      return { stdin }
    }
  )
})

describe('a chat tab is named by its first message', () => {
  it('continues the title queue after an account lookup refuses a job synchronously', async () => {
    const { win, send } = window()
    const refused = `chat-refused-${++sequence}`
    mocks.getToken.mockImplementationOnce(() => {
      throw new Error('The selected Claude account is no longer available.')
    })
    scheduleChatTitle(refused, { claudeProfileId: 'removed-account' })
    notifyChatMessage(refused, 'please name the tab from this first message', win)
    await settled()
    expect(mocks.execFile).not.toHaveBeenCalled()

    const next = `chat-default-${++sequence}`
    scheduleChatTitle(next)
    notifyChatMessage(next, 'please name this later Default tab from its first message', win)
    await settled()
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(`session:auto-title:${next}`, 'follow the first message')
    cleanup(refused)
    cleanup(next)
  })

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

  it('a label Haiku puts before the title does not reach the tab', async () => {
    // Found on a tab named "lowercase title, 2-4 words: explain centra": six
    // words passed the word count, and the line break collapsed in the sidebar.
    const id = `chat-${++sequence}`
    const { win, send } = window()
    mocks.stdout = 'lowercase title, 2-4 words:\n\nexplain centra\n'
    scheduleChatTitle(id)
    notifyChatMessage(id, 'tell me more about centra', win)
    await settled()
    expect(send).toHaveBeenCalledWith(`session:auto-title:${id}`, 'explain centra')
  })

  it('a reply on several lines that is not a label and a title falls back to the message', async () => {
    const id = `chat-${++sequence}`
    const { win, send } = window()
    mocks.stdout = 'fix auth middleware\nfor login'
    scheduleChatTitle(id)
    notifyChatMessage(id, 'please fix the auth middleware timeout on login', win)
    await settled()
    expect(send).toHaveBeenCalledWith(`session:auto-title:${id}`, 'fix the auth middleware')
  })

  it('a label on the title line itself is stripped, not the whole reply refused', async () => {
    // PRDCT-4326: "Title: fix auth middleware" used to fall to the heuristic.
    const id = `chat-${++sequence}`
    const { win, send } = window()
    mocks.stdout = 'Title: fix auth middleware'
    scheduleChatTitle(id)
    notifyChatMessage(id, 'please repair the login timeout in the auth layer', win)
    await settled()
    expect(send).toHaveBeenCalledWith(`session:auto-title:${id}`, 'fix auth middleware')
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
  })

  it('a title with a colon in it is kept', async () => {
    // Server log: Rejected bad title ... "lane d merge flow: mergeable-ready pr #74".
    const id = `chat-${++sequence}`
    const { win, send } = window()
    mocks.stdout = 'merge flow: ready pr\n'
    scheduleChatTitle(id)
    notifyChatMessage(id, 'please look at the lane d merge flow for the ready pr', win)
    await settled()
    expect(send).toHaveBeenCalledWith(`session:auto-title:${id}`, 'merge flow: ready pr')
  })

  it("the person's output style after the title does not reach the tab", async () => {
    const id = `chat-${++sequence}`
    const { win, send } = window()
    mocks.stdout = 'fix auth middleware\n\nNext: nothing.\n'
    scheduleChatTitle(id)
    notifyChatMessage(id, 'please repair the login timeout in the auth layer', win)
    await settled()
    expect(send).toHaveBeenCalledWith(`session:auto-title:${id}`, 'fix auth middleware')
  })

  it('a reply that answers the message is asked ONCE more before the heuristic', async () => {
    const id = `chat-${++sequence}`
    const { win, send } = window()
    mocks.replies.push(
      "I'll look into the timeout. First, a few questions:\n1. Which route?\n2. Since when?",
      'fix auth timeout'
    )
    scheduleChatTitle(id)
    notifyChatMessage(id, 'please fix the auth middleware timeout on login', win)
    await settled()
    expect(mocks.execFile).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith(`session:auto-title:${id}`, 'fix auth timeout')
  })

  it('two replies that are no title fall to the heuristic, and say why on stderr', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const id = `chat-${++sequence}`
    const { win, send } = window()
    mocks.stdout = 'Sure! Here is what I would do:\n- read the middleware\n- add a test'
    scheduleChatTitle(id)
    notifyChatMessage(id, 'please fix the auth middleware timeout on login', win)
    await settled()
    expect(mocks.execFile).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith(`session:auto-title:${id}`, 'fix the auth middleware')
    const said = warn.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(said).toMatch(/no title from the model \(unreadable/)
    warn.mockRestore()
  })

  it('a long first message full of questions goes in as data, clipped, the ask after it', async () => {
    // The tab that was named "in clave. we often": a 4,425-character first
    // message, pasted raw after the instruction, was answered 4 times in 5.
    const id = `chat-${++sequence}`
    const { win, send } = window()
    const questions = Array.from(
      { length: 40 },
      (_, i) =>
        `Question ${i + 1}: in clave, we often see the helper answer instead of naming; why?`
    ).join('\n')
    const message = `in clave. we often get tabs named badly.\n${questions}\nTAIL-NEVER-SENT`
    expect(message.length).toBeGreaterThan(3000)
    scheduleChatTitle(id)
    notifyChatMessage(id, message, win)
    await settled()
    const prompt = mocks.prompts.join('')
    expect(prompt.startsWith('Generate a short 2-4 word title')).toBe(true)
    const open = prompt.indexOf('<message>\n')
    const close = prompt.indexOf('\n</message>')
    expect(open).toBeGreaterThan(0)
    expect(close).toBeGreaterThan(open)
    // The message sits between the tags, clipped, and the instruction comes after.
    expect(prompt.slice(open, close)).toContain('in clave. we often get tabs named badly.')
    expect(prompt).not.toContain('TAIL-NEVER-SENT')
    expect(close - open).toBeLessThan(1600)
    expect(prompt.slice(close)).toMatch(/Reply with the title alone/)
    // And the CLI is told it is a function, not an agent.
    const args = mocks.execFile.mock.calls[0][1] as string[]
    expect(args[args.indexOf('--system-prompt') + 1]).toMatch(/never answer/)
    expect(send).toHaveBeenCalledWith(`session:auto-title:${id}`, 'follow the first message')
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
  afterEach(async () => {
    const { resetShutdownForTests } = await import('./title-generator')
    resetShutdownForTests()
  })

  it("a title asked for AFTER the quit's shutdown starts no CLI", async () => {
    const { shutdown } = await import('./title-generator')
    shutdown()
    const id = `chat-${++sequence}`
    const { win, send } = window()
    scheduleChatTitle(id)
    notifyChatMessage(id, 'please make the sidebar tab follow the first message I send', win)
    await settled()
    expect(mocks.execFile).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalledWith(`session:auto-title:${id}`, expect.anything())
  })

  it('cancelAll alone leaves the door open: a tab opened after the last window closed is still named', async () => {
    // Round 2 of the verifier: the sessions' shutdown also runs when the last
    // window closes on macOS, which is not a quit; a door shut there left
    // every later chat tab unnamed, silently, for the rest of the process.
    const { cancelAll } = await import('./title-generator')
    cancelAll()
    const id = `chat-${++sequence}`
    const { win, send } = window()
    scheduleChatTitle(id)
    notifyChatMessage(id, 'please make the sidebar tab follow the first message I send', win)
    await settled()
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(`session:auto-title:${id}`, 'follow the first message')
  })

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

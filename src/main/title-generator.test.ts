import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

// The module reaches for Electron, the PTY backend's login-shell env and the
// history store at import; none of them is needed here. The CLI itself is a
// stub: what it was asked and what it answered is the whole of these tests.

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  prompts: [] as string[],
  stdout: 'follow the first message',
  error: null as Error | null
}))
vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('child_process', () => ({ execFile: mocks.execFile }))
vi.mock('./sessions/adapters/pty-backend', () => ({ getLoginShellEnv: () => ({ PATH: '/bin' }) }))
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
function window(): { win: BrowserWindow; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  return {
    win: { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow,
    send
  }
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
    expect(mocks.execFile.mock.calls[0][0]).toBe('claude')
    expect(mocks.execFile.mock.calls[0][1]).toEqual(TITLE_CLI_ARGS)
    expect(mocks.prompts.join('')).toContain('follow the first message I send')
    expect(send).toHaveBeenCalledWith(`session:auto-title:${id}`, 'follow the first message')
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
    const send = vi.fn()
    const win = { isDestroyed: () => true, webContents: { send } } as unknown as BrowserWindow
    scheduleChatTitle(id)
    notifyChatMessage(id, 'please make the sidebar tab follow the first message', win)
    await settled()
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })
})

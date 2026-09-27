import { describe, it, expect, vi, beforeEach } from 'vitest'

const ptySpawn = vi.fn()
vi.mock('node-pty', () => ({ spawn: (...args: unknown[]) => ptySpawn(...args) }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clave-login-test' },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./mcp/mcp-runtime', () => ({
  getMcpRuntime: () => null,
  writeSessionMcpConfig: () => null,
  deleteSessionMcpConfig: () => undefined
}))
const setToken = vi.fn()
vi.mock('./claude-accounts', () => ({
  claudeAccountsManager: {
    get: (id: string) => ({ id, label: 'Work' }),
    setToken: (id: string, token: string) => setToken(id, token)
  }
}))
vi.mock('./codex-accounts', () => ({ codexAccountsManager: {} }))
vi.mock('./shell-launch', () => ({
  resolvePosixShellLaunch: (_shell: string, command: string) => ({
    file: '/bin/zsh',
    args: ['-l', '-c', command]
  })
}))
vi.mock('./sessions/adapters/pty-backend', () => ({
  getLoginShellEnv: () => ({ HOME: '/tmp/clave-login-test' }),
  getUserShell: () => '/bin/zsh'
}))

import {
  accountLoginManager,
  findClaudeToken,
  findLoginUrl,
  stripAnsi,
  type LoginJob
} from './account-login'

/** A real token is 108 characters; the shape check needs 20 after the prefix. */
const TOKEN = 'sk-ant-oat01-' + 'abcDEF0123456789_-'.repeat(5) + 'xyz01'

/** What `claude setup-token` paints once the browser flow completes: the
 *  token on its own line, the next line placed by a cursor move rather than
 *  a newline (Ink patches the screen line by line). */
const SUCCESS_FRAME = (token: string): string =>
  'Long-lived authentication token created successfully!\r\n' +
  'Your OAuth token (valid for 365 days):\r\n' +
  `\x1b[33m${token}\x1b[39m` +
  '\x1b[1B\x1b[G' +
  "\x1b[2mStore this token securely. You won't be able to see it again.\x1b[22m\r\n" +
  'Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>\r\n'

/** A PTY the test drives: chunks in, the exit code in, the kill observed. */
function fakePty(): {
  data: (chunk: string) => void
  exit: (exitCode: number) => void
  killed: () => boolean
} {
  let onData: ((chunk: string) => void) | null = null
  let onExit: ((e: { exitCode: number }) => void) | null = null
  let killed = false
  ptySpawn.mockReturnValueOnce({
    onData: (cb: (chunk: string) => void) => {
      onData = cb
    },
    onExit: (cb: (e: { exitCode: number }) => void) => {
      onExit = cb
    },
    kill: () => {
      killed = true
    },
    write: () => undefined
  })
  return {
    data: (chunk) => onData?.(chunk),
    exit: (exitCode) => onExit?.({ exitCode }),
    killed: () => killed
  }
}

const progress: LoginJob[] = []
accountLoginManager.onProgress((job) => progress.push(job))

function lastJob(): LoginJob {
  return progress[progress.length - 1]
}

/**
 * The login runs in a hidden PTY (ADR 0002): what the user sees is what
 * these three read out of its output. A missed link is a login the user
 * cannot finish; a missed token is a login that "worked" and stored nothing,
 * and a token with a stray word on its end is a login that "worked" and
 * stored a credential the service refuses.
 */
describe('the login output readers', () => {
  it('strips colours, title changes and carriage returns', () => {
    expect(stripAnsi('\x1b[1mBold\x1b[0m \x1b]0;title\x07 line\r\n')).toBe('Bold  line\n')
  })

  it('keeps a line break where the CLI moved the cursor instead of printing one', () => {
    // A cursor move or an erase is where one line ends and another starts;
    // dropping it glues the two lines into one word.
    expect(stripAnsi('\x1b[2K\x1b[1Gprompt> ')).toBe('\n\nprompt> ')
    expect(stripAnsi(`${TOKEN}\x1b[1B\x1b[GStore this token`)).toBe(`${TOKEN}\n\nStore this token`)
    expect(stripAnsi('one\rtwo')).toBe('one\ntwo')
  })

  it('finds the link the CLI printed, without the punctuation after it', () => {
    expect(
      findLoginUrl(
        'Opening your browser…\nIf it did not open, visit:\n  https://claude.ai/oauth/authorize?code=true&client_id=abc.\n'
      )
    ).toBe('https://claude.ai/oauth/authorize?code=true&client_id=abc')
    expect(
      findLoginUrl('navigate to http://localhost:1455/auth/callback?x=1 to authenticate')
    ).toBe('http://localhost:1455/auth/callback?x=1')
    expect(findLoginUrl('Starting local login server')).toBeNull()
  })

  it('does not run a link into the line the CLI painted after it', () => {
    expect(findLoginUrl(stripAnsi('visit https://claude.ai/oauth/x\x1b[1B\x1b[GPress Enter'))).toBe(
      'https://claude.ai/oauth/x'
    )
  })

  it('finds the token by its shape and nothing shorter', () => {
    expect(findClaudeToken(`Your token:\n\n${TOKEN}\n\nKeep it safe.`)).toBe(TOKEN)
    expect(findClaudeToken('sk-ant-short\n')).toBeNull()
    expect(findClaudeToken('Run claude setup-token to get one\n')).toBeNull()
  })

  it('takes the token only once something follows it', () => {
    // The scan runs on every chunk; a token cut by a chunk boundary looks
    // like a shorter token until the rest arrives.
    expect(findClaudeToken(`Your token:\n${TOKEN.slice(0, 60)}`)).toBeNull()
    expect(findClaudeToken(`Your token:\n${TOKEN}`)).toBeNull()
    expect(findClaudeToken(`Your token:\n${TOKEN}\n`)).toBe(TOKEN)
    expect(findClaudeToken(`Your token:\n${TOKEN} `)).toBe(TOKEN)
  })

  it('reads the token out of the frame the CLI paints, without the next line', () => {
    expect(findClaudeToken(stripAnsi(SUCCESS_FRAME(TOKEN)))).toBe(TOKEN)
  })
})

describe('the Claude login job', () => {
  beforeEach(() => {
    setToken.mockReset()
    ptySpawn.mockReset()
  })

  it('stores the token the CLI printed, not the word painted after it', () => {
    const p = fakePty()
    accountLoginManager.startClaudeLogin('acct-1')
    p.data(SUCCESS_FRAME(TOKEN))
    expect(setToken).toHaveBeenCalledTimes(1)
    expect(setToken).toHaveBeenCalledWith('acct-1', TOKEN)
    expect(lastJob().status).toBe('done')
    expect(p.killed()).toBe(true)
  })

  it('waits for the whole token when a chunk boundary cuts it', () => {
    const p = fakePty()
    accountLoginManager.startClaudeLogin('acct-2')
    const frame = SUCCESS_FRAME(TOKEN)
    const cut = frame.indexOf(TOKEN) + 50
    p.data(frame.slice(0, cut))
    expect(setToken).not.toHaveBeenCalled()
    p.data(frame.slice(cut))
    expect(setToken).toHaveBeenCalledWith('acct-2', TOKEN)
    expect(lastJob().status).toBe('done')
  })

  it('still takes a token that is the last thing the CLI printed before exiting', () => {
    const p = fakePty()
    accountLoginManager.startClaudeLogin('acct-3')
    p.data(`Your OAuth token (valid for 365 days):\r\n${TOKEN}`)
    expect(setToken).not.toHaveBeenCalled()
    p.exit(0)
    expect(setToken).toHaveBeenCalledWith('acct-3', TOKEN)
    expect(lastJob().status).toBe('done')
  })

  it('fails when the command ends without a token', () => {
    const p = fakePty()
    accountLoginManager.startClaudeLogin('acct-4')
    p.data('Opening your browser…\r\n')
    p.exit(0)
    expect(setToken).not.toHaveBeenCalled()
    const job = lastJob()
    expect(job.status).toBe('failed')
    expect(job.message).toBe('The command ended without printing a token.')
  })
})

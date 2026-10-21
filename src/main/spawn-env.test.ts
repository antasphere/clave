import { describe, it, expect, vi } from 'vitest'

// pty-manager pulls node-pty and electron at import; neither is needed for the
// pure environment builder under test.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./mcp/mcp-runtime', () => ({
  getMcpRuntime: () => null,
  writeSessionMcpConfig: () => null,
  deleteSessionMcpConfig: () => undefined
}))

import {
  buildSpawnEnv,
  accountTokenForSpawn,
  codexHomeForSpawn,
  tmuxEnvironmentReconcileArgs,
  TMUX_SESSION_ENV_VARS
} from './pty-manager'

/**
 * The boundary: a subscription token reaches a Claude session and nothing
 * else. Found untested by the first verifier round: with the guard deleted a
 * plain terminal handed an account id printed the token, and every suite
 * stayed green.
 */
describe('accountTokenForSpawn', () => {
  const getToken = (id: string | undefined): string | undefined =>
    id === 'work' ? 'sk-ant-work' : undefined
  it('hands the account token to a Claude session', () => {
    expect(accountTokenForSpawn('claude', 'work', getToken)).toBe('sk-ant-work')
    expect(accountTokenForSpawn('claude-agents', 'work', getToken)).toBe('sk-ant-work')
  })
  it('never to a terminal or another agent, whatever account id they carry', () => {
    expect(accountTokenForSpawn(null, 'work', getToken)).toBeUndefined()
    expect(accountTokenForSpawn('codex', 'work', getToken)).toBeUndefined()
    expect(accountTokenForSpawn('antigravity', 'work', getToken)).toBeUndefined()
    expect(accountTokenForSpawn('pi', 'work', getToken)).toBeUndefined()
  })
  it.each(['claude', 'claude-agents'] as const)(
    'keeps machine-login behavior for Default or omitted accounts in %s',
    (kind) => {
      expect(accountTokenForSpawn(kind, 'default', getToken)).toBeUndefined()
      expect(accountTokenForSpawn(kind, undefined, getToken)).toBeUndefined()
    }
  )
  it.each(['claude', 'claude-agents'] as const)(
    'refuses a missing or cleared non-default token in %s instead of using the machine login',
    (kind) => {
      expect(() => accountTokenForSpawn(kind, 'removed-account', () => undefined)).toThrow(
        'The selected Claude account is no longer available.'
      )
    }
  )
  it('does not look up Claude tokens for another provider or a plain terminal', () => {
    const getToken = (): never => {
      throw new Error('A non-Claude session must not consult Claude tokens')
    }
    for (const kind of [null, 'codex', 'antigravity', 'pi'] as const)
      expect(accountTokenForSpawn(kind, 'removed-account', getToken)).toBeUndefined()
  })
})

/**
 * The same boundary for a Codex account's home (ADR 0002): a Claude tab or a
 * terminal handed a Codex account id must not have its environment pointed
 * at another home, and the sync runs only when a home is going to be used.
 */
describe('codexHomeForSpawn', () => {
  it('syncs and hands the home to a Codex session only', () => {
    const synced: (string | undefined)[] = []
    const syncHome = (id: string | undefined): string | undefined => {
      synced.push(id)
      return id === 'work' ? '/data/codex-homes/work' : undefined
    }
    expect(codexHomeForSpawn('codex', 'work', syncHome)).toBe('/data/codex-homes/work')
    expect(codexHomeForSpawn('codex', 'default', syncHome)).toBeUndefined()
    expect(codexHomeForSpawn('claude', 'work', syncHome)).toBeUndefined()
    expect(codexHomeForSpawn(null, 'work', syncHome)).toBeUndefined()
    expect(codexHomeForSpawn('pi', 'work', syncHome)).toBeUndefined()
    expect(synced).toEqual(['work', 'default'])
  })

  it('refuses an explicitly selected account whose home disappeared instead of using Default', () => {
    const syncHome = (): undefined => undefined
    expect(() => codexHomeForSpawn('codex', 'removed-account', syncHome)).toThrow(
      'The selected Codex account is no longer available.'
    )
  })

  it.each([undefined, 'default'])('keeps machine-home behavior for account %s', (id) => {
    expect(codexHomeForSpawn('codex', id, () => undefined)).toBeUndefined()
  })

  it('does not resolve Codex homes for other providers or a plain terminal', () => {
    const syncHome = (): never => {
      throw new Error('A non-Codex session must not consult Codex accounts')
    }
    for (const kind of [null, 'claude', 'claude-agents', 'antigravity', 'pi'] as const)
      expect(codexHomeForSpawn(kind, 'removed-account', syncHome)).toBeUndefined()
  })
})

/**
 * A tmux server copies its own environment into a new session; the account
 * variables cross from the client only when `update-environment` names them.
 * Found on the real app: the token reached a plain session and never a
 * tmux-backed one on the long-running shared server.
 */
describe('tmuxEnvironmentReconcileArgs', () => {
  it('appends every account variable a live server does not list yet', () => {
    expect(tmuxEnvironmentReconcileArgs(['DISPLAY', 'SSH_AUTH_SOCK'])).toEqual([
      ['set-option', '-ga', 'update-environment', 'CLAUDE_CONFIG_DIR'],
      ['set-option', '-ga', 'update-environment', 'CLAUDE_CODE_OAUTH_TOKEN'],
      ['set-option', '-ga', 'update-environment', 'CODEX_HOME']
    ])
  })
  it('does nothing on a server that already lists them', () => {
    expect(tmuxEnvironmentReconcileArgs(['DISPLAY', ...TMUX_SESSION_ENV_VARS])).toEqual([])
    expect(tmuxEnvironmentReconcileArgs(['CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME'])).toEqual([
      ['set-option', '-ga', 'update-environment', 'CLAUDE_CONFIG_DIR']
    ])
  })
})

/**
 * The account has to reach the process. Nothing here fails loudly: a dropped
 * field spawns a session that renders perfectly and runs on the machine's own
 * login, which is exactly the bug the accounts exist to end.
 */
describe('buildSpawnEnv', () => {
  const base = { PATH: '/usr/bin', CLAUDECODE: '1', HOME: '/Users/x' }

  it('sets the token and the config dir only when the account carries them', () => {
    const env = buildSpawnEnv(base, { configDir: '/Users/x/.claude-work', oauthToken: 'sk-ant-t' })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-t')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/x/.claude-work')
    const plain = buildSpawnEnv(base, {})
    expect(plain).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
    expect(plain).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(plain).not.toHaveProperty('CODEX_HOME')
  })

  it("sets a Codex account's home only when the session has one", () => {
    expect(buildSpawnEnv(base, { codexHome: '/data/codex-homes/work' }).CODEX_HOME).toBe(
      '/data/codex-homes/work'
    )
    expect(buildSpawnEnv({ ...base, CODEX_HOME: '/mine' }, {}).CODEX_HOME).toBe('/mine')
  })

  it('keeps the terminal and strips the nesting marker', () => {
    const env = buildSpawnEnv(base, {})
    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
    expect(env.PATH).toBe('/usr/bin')
    expect(env).not.toHaveProperty('CLAUDECODE')
  })

  it('does not mutate the login shell environment it was handed', () => {
    const before = { ...base }
    buildSpawnEnv(base, { oauthToken: 'sk-ant-t' })
    expect(base).toEqual(before)
  })
})

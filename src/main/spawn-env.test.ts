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
  it('nothing for the Default or an unknown account', () => {
    expect(accountTokenForSpawn('claude', 'default', getToken)).toBeUndefined()
    expect(accountTokenForSpawn('claude', undefined, getToken)).toBeUndefined()
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
      ['set-option', '-ga', 'update-environment', 'CLAUDE_CODE_OAUTH_TOKEN']
    ])
  })
  it('does nothing on a server that already lists them', () => {
    expect(tmuxEnvironmentReconcileArgs(['DISPLAY', ...TMUX_SESSION_ENV_VARS])).toEqual([])
    expect(tmuxEnvironmentReconcileArgs(['CLAUDE_CODE_OAUTH_TOKEN'])).toEqual([
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

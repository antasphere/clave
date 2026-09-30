import { describe, expect, it } from 'vitest'
import { buildOneShotLaunch, oneShotEnv } from './claude-one-shot'
import type { LaunchProfile } from '../shared/agent-launch'

// Found on a Nushell login whose profile exported a `claude setup-token`
// token as ANTHROPIC_API_KEY: the API answered 401 "API key is invalid", the
// CLI retried it eleven times with backoff, the title helper's timeout fired,
// and every tab was named by the first four words of its message for weeks.
// Nothing said so — the fallback made the failure look like a design choice.

describe('oneShotEnv', () => {
  it('strips the nested-session marker', () => {
    const env = oneShotEnv({ PATH: '/bin', CLAUDECODE: '1' })
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.PATH).toBe('/bin')
  })

  it('moves an OAuth token out of the API key variable into the one the CLI reads it from', () => {
    const env = oneShotEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-oat01-abc' })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-abc')
  })

  it('leaves a real API key where it is', () => {
    const env = oneShotEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-api03-abc' })
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-abc')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('never overrides a token already set, but still drops the misplaced one', () => {
    // ANTHROPIC_API_KEY takes precedence over every other auth source in the
    // CLI, so leaving the misplaced token there would still 401 the call.
    const env = oneShotEnv({
      ANTHROPIC_API_KEY: 'sk-ant-oat01-login',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-account'
    })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-account')
  })

  it("runs on the session's account: its token and config dir win over the login's", () => {
    const env = oneShotEnv(
      { ANTHROPIC_API_KEY: 'sk-ant-oat01-login', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-shell' },
      { oauthToken: 'sk-ant-oat01-account', configDir: '/Users/me/.claude-work' }
    )
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-account')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/me/.claude-work')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('the Default account leaves the login environment as it is', () => {
    const env = oneShotEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/from/shell' }, {})
    expect(env.CLAUDE_CONFIG_DIR).toBe('/from/shell')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('does not touch the environment it was given', () => {
    const base = { CLAUDECODE: '1', ANTHROPIC_API_KEY: 'sk-ant-oat01-abc' }
    oneShotEnv(base)
    expect(base).toEqual({ CLAUDECODE: '1', ANTHROPIC_API_KEY: 'sk-ant-oat01-abc' })
  })
})

// The one-shot runs the agent the session runs: the launch profile's command,
// found on the login PATH and started directly, else through the login-shell
// wrapper the sessions use — a profile whose command only that shell can
// place (a version manager's shim, a function) must not lose its title.

const claude: LaunchProfile = {
  id: 'builtin-claude',
  name: 'Claude',
  family: 'claude',
  command: ['claude'],
  additionalArgs: [],
  builtIn: true
}
const wrapped: LaunchProfile = {
  id: 'work',
  name: 'Work',
  family: 'claude',
  command: ['/opt/agents/claude-work', '--profile', "it's"],
  additionalArgs: ['--add-dir', '/tmp']
}
const args = ['-p', '--model', 'haiku']

describe('buildOneShotLaunch', () => {
  it("starts the profile's command directly when the login PATH places it", () => {
    const launch = buildOneShotLaunch({
      profile: claude,
      args,
      loginEnv: { PATH: '/opt/homebrew/bin:/usr/bin' },
      userShell: '/opt/homebrew/bin/nu',
      locate: (command, path) =>
        command === 'claude' && path?.includes('/opt/homebrew/bin')
          ? '/opt/homebrew/bin/claude'
          : null
    })
    expect(launch.file).toBe('/opt/homebrew/bin/claude')
    expect(launch.args).toEqual(args)
  })

  it("keeps the profile's own command tokens ahead of the one-shot's, and leaves its session arguments out", () => {
    const launch = buildOneShotLaunch({
      profile: wrapped,
      args,
      loginEnv: { PATH: '/usr/bin' },
      userShell: '/bin/zsh',
      locate: (command) => command
    })
    expect(launch.file).toBe('/opt/agents/claude-work')
    expect(launch.args).toEqual(['--profile', "it's", ...args])
  })

  it('falls back to the login-shell wrapper the sessions use when PATH cannot place the command', () => {
    const launch = buildOneShotLaunch({
      profile: claude,
      args,
      loginEnv: { PATH: '/usr/bin' },
      userShell: '/bin/bash',
      locate: () => null
    })
    expect(launch.file).toBe('/bin/bash')
    expect(launch.args).toEqual(['-l', '-c', "exec 'claude' '-p' '--model' 'haiku'"])
  })

  it('diverts a shell that cannot parse the wrapper, quoting every token', () => {
    const launch = buildOneShotLaunch({
      profile: wrapped,
      args,
      loginEnv: {},
      userShell: '/opt/homebrew/bin/nu',
      locate: () => null,
      platform: 'darwin'
    })
    expect(launch.file).toBe('/bin/zsh')
    expect(launch.args[2]).toBe(
      "exec '/opt/agents/claude-work' '--profile' 'it'\\''s' '-p' '--model' 'haiku'"
    )
  })

  it("spawns in the one-shot environment on the session's account", () => {
    const launch = buildOneShotLaunch({
      profile: claude,
      args,
      loginEnv: { PATH: '/usr/bin', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'sk-ant-oat01-login' },
      account: { oauthToken: 'sk-ant-oat01-account' },
      userShell: '/bin/zsh',
      locate: (command) => command
    })
    expect(launch.env.CLAUDECODE).toBeUndefined()
    expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-account')
    expect(launch.env.PATH).toBe('/usr/bin')
  })

  it('refuses a profile of another family: no other agent answers a Claude prompt', () => {
    expect(() =>
      buildOneShotLaunch({
        profile: { ...claude, family: 'codex', command: ['codex'] },
        args,
        loginEnv: {},
        userShell: '/bin/zsh'
      })
    ).toThrow(/Claude/)
  })
})

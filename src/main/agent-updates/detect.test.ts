import { describe, expect, it } from 'vitest'
import {
  canUpgrade,
  classifyInstall,
  compareVersions,
  isNewer,
  parseVersion,
  prefixNpm,
  releaseSource,
  upgradeCommand
} from './detect'

const HOME = '/Users/someone'

describe('where an agent CLI came from', () => {
  it("reads Claude's native installer from its versions folder", () => {
    expect(classifyInstall(`${HOME}/.local/share/claude/versions/2.1.285`, 'claude')).toEqual({
      kind: 'claude-native'
    })
  })

  it('reads a Homebrew cask and a Homebrew formula', () => {
    expect(classifyInstall('/opt/homebrew/Caskroom/codex/0.159.0/bin/codex', 'codex')).toEqual({
      kind: 'homebrew',
      name: 'codex',
      cask: true
    })
    expect(
      classifyInstall('/opt/homebrew/Cellar/claude-code/2.1.0/libexec/bin/claude', 'claude')
    ).toEqual({ kind: 'homebrew', name: 'claude-code', cask: false })
  })

  it('reads a bun global and names the scoped package', () => {
    expect(
      classifyInstall(
        `${HOME}/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`,
        'pi'
      )
    ).toEqual({ kind: 'package', manager: 'bun', pkg: '@earendil-works/pi-coding-agent' })
  })

  it('reads an npm global with the prefix that owns it, the top-level package winning', () => {
    expect(
      classifyInstall(
        `${HOME}/.nvm/versions/node/v22.1.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin/bin/codex`,
        'codex'
      )
    ).toEqual({
      kind: 'package',
      manager: 'npm',
      pkg: '@openai/codex',
      prefix: `${HOME}/.nvm/versions/node/v22.1.0`
    })
  })

  it('reads a pnpm global through its content store, by the package after the last node_modules', () => {
    expect(
      classifyInstall(
        `${HOME}/Library/pnpm/global/5/.pnpm/@openai+codex@0.159.0/node_modules/@openai/codex/bin/codex.js`,
        'codex'
      )
    ).toEqual({ kind: 'package', manager: 'pnpm', pkg: '@openai/codex' })
  })

  it('reads a yarn global', () => {
    expect(
      classifyInstall(`${HOME}/.config/yarn/global/node_modules/unscoped-cli/bin.js`, 'pi')
    ).toEqual({ kind: 'package', manager: 'yarn', pkg: 'unscoped-cli' })
  })

  it('leaves a CLI shipped inside an app to the app, even under a node_modules path', () => {
    const install = classifyInstall(
      '/Applications/Antigravity.app/Contents/Resources/app/node_modules/agy/bin/agy',
      'antigravity'
    )
    expect(install).toEqual({ kind: 'app', app: 'Antigravity.app' })
    expect(canUpgrade(install)).toBe(false)
  })

  it('does not take a non-Claude binary in a versions folder for the Claude installer', () => {
    expect(classifyInstall(`${HOME}/.local/share/claude/versions/1.0.0`, 'codex')).toEqual({
      kind: 'unknown'
    })
  })

  it('calls anything else unknown and refuses to upgrade it', () => {
    const install = classifyInstall('/usr/local/bin/agy', 'antigravity')
    expect(install).toEqual({ kind: 'unknown' })
    expect(canUpgrade(install)).toBe(false)
    expect(upgradeCommand(install, '/usr/local/bin/agy')).toBeNull()
  })
})

describe('versions', () => {
  it('finds the version in what each CLI prints', () => {
    expect(parseVersion('2.1.285 (Claude Code)')).toBe('2.1.285')
    expect(parseVersion('codex-cli 0.159.0\n')).toBe('0.159.0')
    expect(parseVersion('0.85.1')).toBe('0.85.1')
    expect(parseVersion('agy 1.2.3-beta.4')).toBe('1.2.3-beta.4')
    expect(parseVersion('command not found')).toBeNull()
  })

  it('orders numerically, not as text, with a pre-release below its release', () => {
    expect(compareVersions('0.99.1', '0.85.1')).toBeGreaterThan(0)
    expect(compareVersions('2.1.10', '2.1.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta.1', '1.0.0-beta.1.1')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('garbage', '1.0.0')).toBe(0)
  })

  it('claims an update only for a strictly newer, known release', () => {
    expect(isNewer('0.159.1', '0.159.0')).toBe(true)
    expect(isNewer('0.159.0', '0.159.0')).toBe(false)
    expect(isNewer('2.1.280', '2.1.285')).toBe(false)
    expect(isNewer(null, '1.0.0')).toBe(false)
    expect(isNewer('1.0.0', null)).toBe(false)
  })
})

describe('where the latest release is read', () => {
  it("follows the channel Claude's own settings picked", () => {
    const native = { kind: 'claude-native' } as const
    expect(releaseSource('claude', native, 'stable')).toEqual({
      pkg: '@anthropic-ai/claude-code',
      tag: 'stable'
    })
    expect(releaseSource('claude', native, null)).toEqual({
      pkg: '@anthropic-ai/claude-code',
      tag: 'latest'
    })
  })

  it('reads a global package by its own name and a cask by the agent it carries', () => {
    expect(releaseSource('pi', { kind: 'package', manager: 'bun', pkg: '@x/pi' }, null)).toEqual({
      pkg: '@x/pi',
      tag: 'latest'
    })
    expect(releaseSource('codex', { kind: 'homebrew', name: 'codex', cask: true }, null)).toEqual({
      pkg: '@openai/codex',
      tag: 'latest'
    })
  })

  it('has no source for an agent it cannot name', () => {
    expect(
      releaseSource('antigravity', { kind: 'homebrew', name: 'agy', cask: false }, null)
    ).toBeNull()
    expect(releaseSource('codex', { kind: 'unknown' }, null)).toBeNull()
  })
})

describe('the upgrade command', () => {
  it('is argv, run by the installer that owns the install', () => {
    expect(upgradeCommand({ kind: 'claude-native' }, '/u/.local/bin/claude')).toEqual({
      file: '/u/.local/bin/claude',
      args: ['update']
    })
    expect(upgradeCommand({ kind: 'homebrew', name: 'codex', cask: true }, '/x/codex')).toEqual({
      file: 'brew',
      args: ['upgrade', '--cask', 'codex']
    })
    expect(upgradeCommand({ kind: 'homebrew', name: 'gemini', cask: false }, '/x/g')).toEqual({
      file: 'brew',
      args: ['upgrade', 'gemini']
    })
    expect(upgradeCommand({ kind: 'package', manager: 'bun', pkg: '@x/pi' }, '/x/pi')).toEqual({
      file: 'bun',
      args: ['add', '-g', '@x/pi@latest']
    })
    expect(upgradeCommand({ kind: 'package', manager: 'pnpm', pkg: 'p' }, '/x/p')).toEqual({
      file: 'pnpm',
      args: ['add', '-g', 'p@latest']
    })
    expect(upgradeCommand({ kind: 'package', manager: 'yarn', pkg: 'y' }, '/x/y')).toEqual({
      file: 'yarn',
      args: ['global', 'add', 'y@latest']
    })
  })

  it("uses the npm of the package's own prefix when it is there, else the PATH's", () => {
    const install = {
      kind: 'package',
      manager: 'npm',
      pkg: '@openai/codex',
      prefix: '/n/v22'
    } as const
    expect(prefixNpm(install)).toBe('/n/v22/bin/npm')
    expect(prefixNpm({ kind: 'package', manager: 'bun', pkg: 'x' })).toBeNull()
    expect(upgradeCommand(install, '/n/v22/bin/codex', '/n/v22/bin/npm')).toEqual({
      file: '/n/v22/bin/npm',
      args: ['install', '-g', '@openai/codex@latest']
    })
    expect(upgradeCommand(install, '/n/v22/bin/codex', null)).toEqual({
      file: 'npm',
      args: ['install', '-g', '@openai/codex@latest']
    })
  })

  it('never upgrades an app-shipped CLI', () => {
    expect(upgradeCommand({ kind: 'app', app: 'X.app' }, '/x')).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { withNativeAgentDirs } from './pty-backend'

/**
 * The login PATH Clave spawns with always ends with the folder Anthropic's
 * native installer puts `claude` in: a process that read its environment
 * before the first-run walk installed the CLI still finds it, and nothing the
 * profile places is ever shadowed.
 */
describe('withNativeAgentDirs', () => {
  it('appends ~/.local/bin last, once', () => {
    const env = withNativeAgentDirs({ PATH: '/opt/homebrew/bin:/usr/bin' }, '/Users/a')
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/Users/a/.local/bin')
    expect(withNativeAgentDirs(env, '/Users/a').PATH).toBe(env.PATH)
  })

  it('leaves a PATH that already names it where the profile put it', () => {
    const env = withNativeAgentDirs({ PATH: '/Users/a/.local/bin:/usr/bin' }, '/Users/a')
    expect(env.PATH).toBe('/Users/a/.local/bin:/usr/bin')
  })

  it('makes a PATH from nothing, and does nothing without a home', () => {
    expect(withNativeAgentDirs({}, '/Users/a').PATH).toBe('/Users/a/.local/bin')
    expect(withNativeAgentDirs({ PATH: '/bin' }, '').PATH).toBe('/bin')
  })
})

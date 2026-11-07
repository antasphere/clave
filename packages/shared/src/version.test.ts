import { describe, it, expect } from 'vitest'
import { isPrereleaseVersion, prereleaseIdOf, prereleaseLabel } from './version'

describe('version', () => {
  it('tells a pre-release from a stable version', () => {
    expect(isPrereleaseVersion('2.0.0-beta.1')).toBe(true)
    expect(isPrereleaseVersion('2.0.0')).toBe(false)
    expect(isPrereleaseVersion('1.92.0')).toBe(false)
  })

  it('names the channel from the pre-release id', () => {
    expect(prereleaseIdOf('2.0.0-beta.3')).toBe('beta')
    expect(prereleaseIdOf('2.0.0-alpha.1')).toBe('alpha')
    expect(prereleaseIdOf('2.0.0')).toBeNull()
  })

  it('labels the two conventional channels by name and anything else as a pre-release', () => {
    expect(prereleaseLabel('2.0.0-beta.1')).toBe('Beta')
    expect(prereleaseLabel('2.0.0-alpha.1')).toBe('Alpha')
    expect(prereleaseLabel('2.0.0-rc.1')).toBe('Pre-release')
    expect(prereleaseLabel('2.0.0')).toBeNull()
  })
})

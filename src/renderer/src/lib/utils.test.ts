import { describe, expect, it } from 'vitest'
import { shortenPath } from './utils'

describe('shortenPath', () => {
  it('replaces the home folder with a tilde and leaves other roots alone', () => {
    expect(shortenPath('/Users/someone/work/repo')).toBe('~/work/repo')
    expect(shortenPath('/opt/work')).toBe('/opt/work')
  })

  it('answers an empty label for a root that is not a string, so a malformed registry entry never takes the window down', () => {
    expect(shortenPath(undefined as unknown as string)).toBe('')
    expect(shortenPath(null as unknown as string)).toBe('')
  })
})

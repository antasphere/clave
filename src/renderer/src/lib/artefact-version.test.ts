import { describe, expect, it } from 'vitest'
import { inBrowser, versionLabel, withVersion } from './artefact-version'

describe('the version an artefact shows (PRDCT-4494)', () => {
  it('hides Slideless’s own bar whatever is shown', () => {
    expect(withVersion('http://127.0.0.1:4100/', 'live')).toBe('http://127.0.0.1:4100/?bar=0')
  })
  it('asks the preview for the latest version or one version by number', () => {
    expect(withVersion('http://127.0.0.1:4100/', 'latest')).toBe(
      'http://127.0.0.1:4100/?bar=0&v=latest'
    )
    expect(withVersion('http://127.0.0.1:4100/', '3')).toBe('http://127.0.0.1:4100/?bar=0&v=3')
  })
  it('replaces a version already asked for, and drops it for the live folder', () => {
    expect(withVersion('http://127.0.0.1:4100/?v=2', '3')).toBe('http://127.0.0.1:4100/?v=3&bar=0')
    expect(withVersion('http://127.0.0.1:4100/?v=2', 'live')).toBe('http://127.0.0.1:4100/?bar=0')
  })
  it('names what is shown as the chip says it', () => {
    expect([versionLabel('live'), versionLabel('latest'), versionLabel('4')]).toEqual([
      'Live',
      'Latest',
      'v4'
    ])
  })
  it('opens in a browser with Slideless’s own bar, on the version shown', () => {
    expect(inBrowser('http://127.0.0.1:4100/?bar=0', 'live')).toBe('http://127.0.0.1:4100/')
    expect(inBrowser('http://127.0.0.1:4100/?bar=0&v=2', '3')).toBe('http://127.0.0.1:4100/?v=3')
  })
})

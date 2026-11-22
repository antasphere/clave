import { describe, expect, it } from 'vitest'
import { PROVIDER_LOGOS } from '../../../../plugins/chat-view/src/provider-logo'
import { AntigravityLogo } from '../components/icons/cli-logos'

describe('the mark that breathes while an agent works', () => {
  it('is Antigravity’s own in an Antigravity chat, never the fallback dot', () => {
    expect(PROVIDER_LOGOS['antigravity']).toBe(AntigravityLogo)
  })
  it('is the dot for a provider with no mark', () => {
    expect(PROVIDER_LOGOS['echo']).toBeUndefined()
    expect(PROVIDER_LOGOS['constructor']).toBeUndefined()
  })
})

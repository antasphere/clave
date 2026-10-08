import { describe, expect, it } from 'vitest'
import { acceptedHandoff, handoffShape } from './antasphere-handoff'

const env = { CLAVE_ANTASPHERE_ISSUER: 'http://127.0.0.1:4321' }
const issued = { url: 'http://127.0.0.1:4321/authorize?state=abc', generation: 2 }
const manager = (
  current: boolean | ((h: { url: string; generation: number }) => boolean)
): { confirmHandoff: (h: { url: string; generation: number }) => boolean } => ({
  confirmHandoff: (h: { url: string; generation: number }) =>
    typeof current === 'function' ? current(h) : current
})

describe('what the shell opens a browser on', () => {
  it('the exact handoff the manager in this process issued, at the configured issuer', () => {
    const exact = manager((h) => h.url === issued.url && h.generation === issued.generation)
    expect(acceptedHandoff(issued, env, exact)?.toString()).toBe(issued.url)
    expect(acceptedHandoff({ ...issued, generation: 3 }, env, exact)).toBeNull()
    expect(acceptedHandoff({ ...issued, url: issued.url + '&x=1' }, env, exact)).toBeNull()
  })

  it('nothing after the login moved on, whatever the link looks like', () => {
    expect(acceptedHandoff(issued, env, manager(false))).toBeNull()
  })

  it('nothing off the configured issuer, with credentials, malformed, or when no issuer is configured', () => {
    expect(
      acceptedHandoff({ ...issued, url: 'http://127.0.0.1:9999/authorize' }, env, null)
    ).toBeNull()
    expect(acceptedHandoff({ ...issued, url: 'https://evil.test/authorize' }, env, null)).toBeNull()
    expect(
      acceptedHandoff({ ...issued, url: 'http://user:pw@127.0.0.1:4321/authorize' }, env, null)
    ).toBeNull()
    expect(acceptedHandoff({ ...issued, url: 'not a url' }, env, null)).toBeNull()
    expect(acceptedHandoff(issued, { CLAVE_ANTASPHERE_ISSUER: 'ftp://x' }, null)).toBeNull()
    // Attached, the shell holds no manager: the origin check is its own, the
    // generation's binding was the server's, asked right before.
    expect(acceptedHandoff(issued, env, null)?.toString()).toBe(issued.url)
  })

  it('takes only a handoff-shaped value', () => {
    for (const bad of [
      null,
      'x',
      1,
      {},
      { url: 1, generation: 1 },
      { url: 'u', generation: 1.5 }
    ]) {
      expect(handoffShape(bad)).toBeNull()
    }
    expect(handoffShape({ url: 'u', generation: 1, extra: true })).toEqual({
      url: 'u',
      generation: 1
    })
  })
})

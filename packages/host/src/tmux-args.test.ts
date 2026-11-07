import { describe, expect, it } from 'vitest'
import { tmuxKillSessionArgs } from './tmux-args'

describe('tmuxKillSessionArgs — a kill by name is exact, never a prefix match', () => {
  it('targets the session with the = exact-match prefix on the named socket', () => {
    expect(tmuxKillSessionArgs('clave', 'clave-wt-demo-nuit-10ds3a')).toEqual([
      '-L',
      'clave',
      'kill-session',
      '-t',
      '=clave-wt-demo-nuit-10ds3a'
    ])
  })

  it('never emits a bare -t target (that is what let an absent name kill its -2 sibling)', () => {
    const args = tmuxKillSessionArgs('clave', 'clave-functions-iqsx89')
    const target = args[args.indexOf('-t') + 1]
    expect(target.startsWith('=')).toBe(true)
    expect(target.slice(1)).toBe('clave-functions-iqsx89')
  })
})

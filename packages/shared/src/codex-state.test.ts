import { describe, expect, it } from 'vitest'
import { codexStateFromTitle } from './codex-state'

describe('Codex runtime titles', () => {
  it.each(['Working', 'Thinking', 'Waiting'])(
    'keeps %s blue, including without animation',
    (status) => {
      expect(codexStateFromTitle(`codex | ${status}`)).toBe('working')
      expect(codexStateFromTitle(`codex | ${status} ⠋`)).toBe('working')
    }
  )
  it.each(['[ ! ] Action Required | codex', '[ . ] Action Required | codex'])(
    'clears the glow for %s',
    (title) => {
      expect(codexStateFromTitle(title)).toBe('blocked')
    }
  )
  it.each([
    'codex | Ready',
    'codex | Starting',
    '',
    'bash',
    'Working',
    'project | Working',
    'codex | FutureState'
  ])('stays neutral for %s', (title) => {
    expect(codexStateFromTitle(title)).toBe('idle')
  })
})

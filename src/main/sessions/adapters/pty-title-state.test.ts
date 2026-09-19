import { expect, it, vi } from 'vitest'
import { codexTitleReader } from './pty-title-state'

it('follows fragmented Codex OSC titles with either terminator and clears unknown titles', () => {
  const state = vi.fn()
  const read = codexTitleReader(state)
  read('codex | Working')
  expect(state).not.toHaveBeenCalled()
  read('\x1b')
  read(']0;codex | Wor')
  read('king\x07\x1b]2;[ ! ] Action Required | codex\x1b')
  read('\\\x1b]2;\x07')
  expect(state.mock.calls.flat()).toEqual(['working', 'blocked', 'idle'])
})

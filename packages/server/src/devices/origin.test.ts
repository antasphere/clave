import { expect, it } from 'vitest'
import { isListenerOrigin } from '../cors'

it('compares the listener port as well as the hostname', () => {
  expect(isListenerOrigin('http://machine.test:43127', 'machine.test:43127')).toBe(true)
  expect(isListenerOrigin('http://machine.test:43128', 'machine.test:43127')).toBe(false)
  expect(isListenerOrigin('http://machine.test', 'machine.test:43127')).toBe(false)
})

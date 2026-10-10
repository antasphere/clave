import { afterEach, describe, expect, it, vi } from 'vitest'
import * as real from '@xterm/headless'
import {
  renderScreen,
  resetScreensForTests,
  retainOutput,
  setHeadlessImportForTests
} from './terminal-screen'

/**
 * The headless loader's module shapes (verifier round 3 of wave 4's lane D):
 * under vitest the namespace carries `Terminal`; the main process bundled as
 * CommonJS puts it under `default` (the first end-to-end run answered
 * "Terminal is not a constructor"); a module with no constructor, or one
 * that does not load at all, is said in the loader's own words, never in
 * Node's (which name the install path).
 */
afterEach(() => {
  setHeadlessImportForTests(null)
  resetScreensForTests()
})

describe('the headless loader', () => {
  it('renders from the namespace shape', async () => {
    setHeadlessImportForTests(async () => ({ Terminal: real.Terminal }))
    retainOutput('a', 'hello\r\n')
    expect((await renderScreen('a', 5)).lines).toEqual(['hello'])
  })
  it('renders from the default shape (main bundled as CommonJS)', async () => {
    setHeadlessImportForTests(async () => ({ default: { Terminal: real.Terminal } }))
    retainOutput('b', 'hello\r\n')
    expect((await renderScreen('b', 5)).lines).toEqual(['hello'])
  })
  it('says its own words when the module has no constructor', async () => {
    setHeadlessImportForTests(async () => ({ default: { Terminal: 42 } }))
    retainOutput('c', 'x')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(renderScreen('c', 5)).rejects.toThrow('the headless terminal did not load')
    } finally {
      spy.mockRestore()
    }
  })
  it('says its own words, never the install path, when the module does not load, and tries again', async () => {
    setHeadlessImportForTests(async () => {
      throw new Error("Cannot find module '@xterm/headless' imported from /Applications/Clave.app")
    })
    retainOutput('d', 'x')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(renderScreen('d', 5)).rejects.toThrow('the headless terminal did not load')
      await expect(renderScreen('d', 5)).rejects.not.toThrow('Clave.app')
      // The failure is not kept: the next read asks the loader again.
      setHeadlessImportForTests(async () => ({ Terminal: real.Terminal }))
      expect((await renderScreen('d', 5)).lines).toEqual(['x'])
    } finally {
      spy.mockRestore()
    }
  })
})

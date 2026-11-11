import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _electron as electron } from 'playwright-core'
import { launchApp, liveAppPids } from './harness.mjs'

vi.mock('playwright-core', () => ({ _electron: { launch: vi.fn() } }))

const server = { url: 'http://127.0.0.1:1', token: 'fixture-token' }
const dir = '/unused/clave-harness-launch-unit'
let app
let win
let order

beforeEach(() => {
  order = []
  win = {
    waitForLoadState: vi.fn(async () => {
      order.push('loaded')
    }),
    evaluate: vi.fn(async () => {
      order.push('boot')
      return 'complete'
    }),
    waitForTimeout: vi.fn(async () => {
      order.push('settled')
    })
  }
  app = {
    process: () => ({ pid: 424242 }),
    close: vi.fn(async () => undefined),
    firstWindow: vi.fn(async () => {
      order.push('window')
      return win
    })
  }
  electron.launch.mockReset().mockResolvedValue(app)
})

afterEach(async () => {
  if (liveAppPids().includes(424242)) await app.close()
})

describe('launchApp observation boundaries', () => {
  it('keeps window, DOM, callback, boot and settle waits by default, even without discovery', async () => {
    const beforeBoot = vi.fn(async () => {
      order.push('callback')
    })
    const launched = await launchApp(dir, { server, waitForServer: false, beforeBoot, settleMs: 7 })
    expect(launched.win).toBe(win)
    expect(order).toEqual(['window', 'loaded', 'callback', 'boot', 'settled'])
    expect(win.waitForLoadState).toHaveBeenCalledWith('domcontentloaded')
    expect(win.waitForTimeout).toHaveBeenCalledWith(7)
  })

  it('returns an owned, bounded-close app before any window wait for a main-process lifecycle fixture', async () => {
    app.firstWindow.mockImplementation(() => new Promise(() => {}))
    const pending = launchApp(dir, { server, waitForServer: false, waitForWindow: false })
    const launched = await Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('waited for a window')), 250))
    ])
    expect(launched.app).toBe(app)
    expect(launched.win).toBe(null)
    expect(launched.fixture).toBeTruthy()
    expect(app.firstWindow).not.toHaveBeenCalled()
    expect(win.evaluate).not.toHaveBeenCalled()
    expect(liveAppPids()).toContain(424242)
    await launched.app.close()
    expect(liveAppPids()).not.toContain(424242)
  })

  it.each([{ waitForServer: true }, { beforeBoot: async () => undefined }, { settleMs: 1 }])(
    'refuses an early launch that would silently skip an observation: %j',
    async (options) => {
      await expect(
        launchApp(dir, {
          server,
          waitForServer: false,
          waitForWindow: false,
          ...options
        })
      ).rejects.toThrow(
        /waitForWindow: false requires waitForServer: false, beforeBoot: null and settleMs: 0/
      )
      expect(electron.launch).not.toHaveBeenCalled()
    }
  )
})

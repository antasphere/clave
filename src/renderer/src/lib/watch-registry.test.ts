import { describe, expect, it, vi } from 'vitest'
import { createWatchRegistry } from './watch-registry'

describe('watch registry', () => {
  it('starts the watcher for the first consumer only', () => {
    const r = createWatchRegistry()
    expect(r.acquire('/a.html')).toBe(true)
    expect(r.acquire('/a.html')).toBe(false)
    expect(r.count('/a.html')).toBe(2)
  })

  it('stops the watcher for the last consumer only — the file tab leaving does not blind the preview', () => {
    const r = createWatchRegistry()
    r.acquire('/a.html')
    r.acquire('/a.html')
    expect(r.release('/a.html')).toBe(false)
    expect(r.count('/a.html')).toBe(1)
    expect(r.release('/a.html')).toBe(true)
    expect(r.count('/a.html')).toBe(0)
  })

  it('keeps paths apart', () => {
    const r = createWatchRegistry()
    r.acquire('/a.html')
    expect(r.acquire('/b.html')).toBe(true)
    expect(r.release('/a.html')).toBe(true)
    expect(r.count('/b.html')).toBe(1)
  })

  it('tolerates a release with no acquire', () => {
    const r = createWatchRegistry()
    expect(r.release('/never.html')).toBe(true)
    expect(r.count('/never.html')).toBe(0)
  })

  it("keeps the first consumer's watch promise, gives a second consumer the same, drops it with the last", () => {
    const r = createWatchRegistry()
    const set = Promise.resolve()
    const start = vi.fn(() => set)
    expect(r.watch('/a.md')).toBeUndefined()
    expect(r.acquire('/a.md', start)).toBe(true)
    expect(r.watch('/a.md')).toBe(set)
    const again = vi.fn(() => Promise.resolve())
    expect(r.acquire('/a.md', again)).toBe(false)
    expect(again).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledTimes(1)
    expect(r.watch('/a.md')).toBe(set)
    r.release('/a.md')
    expect(r.watch('/a.md')).toBe(set)
    r.release('/a.md')
    expect(r.watch('/a.md')).toBeUndefined()
  })
  it("a watch that could not be set is nobody's unhandled rejection, and is still told to whoever asks", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const r = createWatchRegistry()
      r.acquire('/gone.md', () => Promise.reject(new Error('no such folder')))
      // Long enough for Node to report a rejection nobody handled.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(unhandled).toEqual([])
      await expect(r.watch('/gone.md')).rejects.toThrow('no such folder')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

import { describe, expect, it } from 'vitest'
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
})

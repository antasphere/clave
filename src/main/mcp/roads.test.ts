import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The road record exists for the end-to-end suite and for nothing else: in
 * test mode every tool call is one entry on the shared hooks namespace;
 * outside it nothing is kept, so a long-running app never grows a list.
 */
type Hooks = { __claveE2E?: { mcpRoads?: unknown[] } }
const g = globalThis as typeof globalThis & Hooks

beforeEach(() => {
  vi.resetModules()
  delete g.__claveE2E
})
afterEach(() => {
  delete g.__claveE2E
})

describe('the agent tools’ road record', () => {
  it('records each tool’s road on the hooks namespace in test mode', async () => {
    vi.doMock('../test-mode', () => ({ TEST_NO_ACTIVATE: true }))
    const { noteRoad } = await import('./roads')
    noteRoad('createGroup', 'server')
    noteRoad('focus', 'window')
    expect(g.__claveE2E?.mcpRoads).toEqual([
      { command: 'createGroup', road: 'server' },
      { command: 'focus', road: 'window' }
    ])
  })
  it('keeps nothing outside test mode', async () => {
    vi.doMock('../test-mode', () => ({ TEST_NO_ACTIVATE: false }))
    const { noteRoad } = await import('./roads')
    for (let i = 0; i < 1000; i++) noteRoad('list', 'server')
    expect(g.__claveE2E).toBeUndefined()
  })
})

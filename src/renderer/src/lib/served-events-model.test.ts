import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The model main pushes lands in the sidebar's store (PRDCT-4256, integration
 * round 1, G1): without it the foot and the row's warning judge the caps by
 * the launch model for the tab's whole life. A push for a tab this window
 * does not hold writes nothing.
 */
type ModelEvent = { id: string; model: string }
const h = vi.hoisted(() => ({
  state: {
    sessions: [{ id: 's1' }] as { id: string }[],
    setSessionModel: vi.fn()
  },
  modelChanged: undefined as ((event: ModelEvent) => void) | undefined
}))
vi.mock('../store/session-store', () => ({ useSessionStore: { getState: () => h.state } }))
vi.mock('../store/pinned-store', () => ({ usePinnedStore: { getState: () => ({}) } }))
vi.mock('../store/workspace-store', () => ({ useWorkspaceStore: { getState: () => ({}) } }))
vi.mock('./adopt-record', () => ({ adoptServerStartedTerminals: vi.fn() }))
vi.mock('./restart-ownership', () => ({ servedRestartApplies: () => true }))

beforeEach(async () => {
  vi.resetModules()
  h.state = { sessions: [{ id: 's1' }], setSessionModel: vi.fn() }
  h.modelChanged = undefined
  vi.stubGlobal('window', {
    electronAPI: {
      onSessionModelChanged: (cb: (event: ModelEvent) => void) => {
        h.modelChanged = cb
      }
    }
  })
  ;(await import('./served-events')).initServedToolsEvents()
})
afterEach(() => vi.unstubAllGlobals())

describe('the model push from main', () => {
  it("writes the provider's model into the store for a tab the window holds", () => {
    expect(h.modelChanged).toBeTypeOf('function')
    h.modelChanged?.({ id: 's1', model: 'claude-opus-5-5' })
    h.modelChanged?.({ id: 's1', model: 'claude-fable-5-1[1m]' })
    expect(h.state.setSessionModel.mock.calls).toEqual([
      ['s1', 'claude-opus-5-5'],
      ['s1', 'claude-fable-5-1[1m]']
    ])
  })

  it('writes nothing for a tab the window does not hold', () => {
    h.modelChanged?.({ id: 'elsewhere', model: 'claude-opus-5-5' })
    expect(h.state.setSessionModel).not.toHaveBeenCalled()
  })
})

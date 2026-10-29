import { describe, expect, it } from 'vitest'
import { chatPath, coldLaunchState, deepLinkState, machineIdOf, stateForPath } from './persistence'

describe('where the app opens', () => {
  it('a cold launch opens Machines then the Workspaces of the current machine', () => {
    expect(coldLaunchState('m1')).toEqual({
      index: 1,
      routes: [{ name: 'Machines' }, { name: 'Workspaces', params: { machineId: 'm1' } }]
    })
    expect(coldLaunchState(null)).toEqual({ index: 0, routes: [{ name: 'Machines' }] })
  })
  it('a new process opens Workspaces whatever the app showed before: no saved screen is read', () => {
    // The module exposes no saved-state reader and no time window: the only
    // inputs of a cold launch are the current machine and a deep link.
    expect(Object.keys(coldLaunchState('m1'))).toEqual(['index', 'routes'])
    expect(coldLaunchState('m1').routes.map((r) => r.name)).not.toContain('Chat')
  })
  it("a deep link opens the conversation from a cold start, over its machine's workspaces", () => {
    const expected = deepLinkState('m1', 's1')
    expect(stateForPath('clave://chat/m1/s1')).toEqual(expected)
    expect(stateForPath('chat/m1/s1')).toEqual(expected)
    expect(stateForPath('/chat/m1/s1?from=notification')).toEqual(expected)
    expect(expected.routes.map((r) => r.name)).toEqual(['Machines', 'Workspaces', 'Chat'])
    expect(expected.routes[2]?.params).toEqual({ machineId: 'm1', sessionId: 's1' })
  })
  it('round-trips the ids a link carries, encoded', () => {
    const path = chatPath('dev:127.0.0.1:43201', 'sess/with slash')
    expect(path).toBe('chat/dev%3A127.0.0.1%3A43201/sess%2Fwith%20slash')
    expect(stateForPath(`clave://${path}`)?.routes[2]?.params).toEqual({
      machineId: 'dev:127.0.0.1:43201',
      sessionId: 'sess/with slash'
    })
  })
  it('a link the app does not know opens nothing', () => {
    expect(stateForPath('clave://settings')).toBeUndefined()
    expect(stateForPath('clave://chat/m1')).toBeUndefined()
    expect(stateForPath('clave://chat/%E0%A4%A/s1')).toBeUndefined()
    expect(stateForPath('')).toBeUndefined()
  })
  it('names the machine of a screen tree', () => {
    expect(machineIdOf(deepLinkState('m1', 's1'))).toBe('m1')
    expect(machineIdOf(coldLaunchState(null))).toBeNull()
    expect(machineIdOf(null)).toBeNull()
  })
})

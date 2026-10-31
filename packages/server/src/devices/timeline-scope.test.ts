import { expect, it } from 'vitest'
import { deviceMayCall } from './scope'
it('admits only the timeline read and preserves the device route allowlist', () => {
  expect(deviceMayCall('GET', '/sessions/timeline')).toBe(true)
  expect(deviceMayCall('POST', '/sessions/timeline')).toBe(false)
  for (const path of [
    '/sessions/timeline/delete',
    '/sessions/control',
    '/clients',
    '/devices',
    '/e2e/evaluate'
  ])
    expect(deviceMayCall('GET', path)).toBe(false)
})

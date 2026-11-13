import { expect, it } from 'vitest'
import { deviceMayCall } from './scope'

it('allows only the exact attachment preparation POST among file writes', () => {
  expect(deviceMayCall('POST', '/files/attachments/prepare')).toBe(true)
  for (const path of [
    '/files/write',
    '/files/upload',
    '/files/create',
    '/files/mkdir',
    '/files/watch',
    '/files/attachments/prepare/extra',
    '/files/attachments/prepare-other'
  ])
    expect(deviceMayCall('POST', path), path).toBe(false)
  expect(deviceMayCall('PUT', '/files/attachments/prepare')).toBe(false)
  expect(deviceMayCall('DELETE', '/files/attachments/prepare')).toBe(false)
})

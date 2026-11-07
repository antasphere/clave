import { expect, it } from 'vitest'
import { workspaceForPath } from './workspace-types'

it('infers the most specific whole path, with either path separator', () => {
  const workspaces = [
    { id: 'parent', rootDir: '/work' },
    { id: 'nested', rootDir: '/work/nested/' },
    { id: 'windows', rootDir: 'C:\\projects\\app' }
  ]
  expect(workspaceForPath(workspaces, '/work/nested/src/')).toBe('nested')
  expect(workspaceForPath(workspaces, '/work')).toBe('parent')
  expect(workspaceForPath(workspaces, '/worker')).toBeUndefined()
  expect(workspaceForPath(workspaces, 'C:\\projects\\app\\src')).toBe('windows')
  expect(workspaceForPath(workspaces, undefined)).toBeUndefined()
})

import { expect, it } from 'vitest'
import { FILE_TREE_IGNORED } from '@clave/contract/files'
import { IGNORED_DIRECTORIES } from './constants'

it('keeps the server and Mac tree ignore lists equal', () => {
  expect([...FILE_TREE_IGNORED]).toEqual(IGNORED_DIRECTORIES)
})

import { expect, it } from 'vitest'
import { privateAnswerPath } from './answer-route'

it('matches only router-equivalent answer paths without throwing on invalid encoding', () => {
  for (const url of [
    '/sessions/write',
    '/SESSIONS//write/?x=1',
    '/%73essions/write;probe=1',
    'http://localhost/sessions/write'
  ])
    expect(privateAnswerPath(url)).toBe('/sessions/write')
  for (const url of ['/requests/resolve', '/requests//%72esolve/', '/REQUESTS/resolve#probe'])
    expect(privateAnswerPath(url)).toBe('/requests/resolve')
  for (const url of [
    '/files/write',
    '/sessions/write-extra',
    '/requests/resolve/other',
    '/sessions%2Fwrite',
    '/%xx'
  ])
    expect(privateAnswerPath(url)).toBeUndefined()
})

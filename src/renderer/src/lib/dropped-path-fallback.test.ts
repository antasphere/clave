import { describe, expect, it } from 'vitest'
import { resourceKey, sessionKey } from '@clave/contract/fleet'
import { droppedPathFallback } from './dropped-paths'

/**
 * A dropped path that could not be attached (PRDCT-4329): a folder always
 * lands here, since the transfer reads one file's bytes and `readBounded`
 * refuses a directory ("Folders and special files cannot be attached.").
 */
describe('what a dropped path that could not be attached leaves behind', () => {
  const serverTab = sessionKey({ serverId: 'studio', sessionId: 's1' })

  it('on a server tab, a path of this Mac is never put in the message', () => {
    expect(droppedPathFallback(serverTab, '/Users/me/Projects/site')).toBe('refuse')
  })

  it('on this Mac’s tab, the path goes in the message as before', () => {
    expect(droppedPathFallback('local-tab-1', '/Users/me/Projects/site')).toBe('insert')
  })

  it('a server’s own file, dragged by its key, keeps the old fallback', () => {
    expect(droppedPathFallback(serverTab, resourceKey('file', 'studio', '/srv/site'))).toBe(
      'insert'
    )
  })
})

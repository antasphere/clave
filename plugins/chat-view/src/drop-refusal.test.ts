import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { sessionKey } from '@clave/contract/fleet'
import {
  reduceDropRefusal,
  refusedOnThisMac,
  serverNameOf,
  type DropRefusalState
} from '../../../src/renderer/src/lib/drop-refusal'
import { ownerOf } from '../../../src/renderer/src/lib/fleet-identity'
import { DropRefusal } from './DropRefusal'

/**
 * The refusal card above the composer (PRDCT-4329), driven the way the
 * composer drives it (`useComposerAttachments`: each drop numbered,
 * `refusedOnThisMac` deciding, `reduceDropRefusal` holding the card) and
 * drawn as the views draw it. Fails if a folder dropped on a server tab
 * shows no card or not the server's name, if this Mac's tab shows one, or if
 * Escape or a later attach that lands leaves it standing.
 */
const connections = [{ id: 'studio', name: 'Personal VPS 1', url: 'http://x', enabled: true }]
const folderRefused = new Error(
  "Error invoking remote method 'sessions:files': Error: Folders cannot be attached."
)

/** A drop of `paths` on `sessionId`, every one refused as a folder. */
function dropFolders(
  state: DropRefusalState | null,
  sessionId: string,
  batch: number,
  paths: string[]
): DropRefusalState | null {
  for (const path of paths) {
    const item = refusedOnThisMac(sessionId, path, folderRefused, path.split('/').pop()!)
    if (item) state = reduceDropRefusal(state, { type: 'refused', batch, item })
  }
  return state
}

const card = (state: DropRefusalState | null, sessionId: string): string =>
  state
    ? renderToStaticMarkup(
        createElement(DropRefusal, {
          refusal: state,
          server: serverNameOf(connections, ownerOf(sessionId)),
          onClose: () => {}
        })
      )
    : ''

describe('the refusal card', () => {
  const serverTab = sessionKey({ serverId: 'studio', sessionId: 's1' })

  it('appears for a folder dropped on a server tab, naming the server', () => {
    const html = card(dropFolders(null, serverTab, 1, ['/Users/me/site']), serverTab)
    expect(html).toContain('data-drop-refusal="1"')
    expect(html).toContain('data-placement="docked"')
    expect(html).toContain('Folders stay on this Mac')
    expect(html).toContain(
      'This session runs on Personal VPS 1, which can&#x27;t open the folders on your Mac. Drop files instead: they are copied to the server.'
    )
    // The drawing of the family, and the way out by the keyboard.
    expect(html).toContain('drop-refused-drawing')
    expect(html).toContain('aria-keyshortcuts="Escape"')
  })

  it('is one card with a plural title for several folders of one drop', () => {
    const html = card(
      dropFolders(null, serverTab, 1, ['/Users/me/a', '/Users/me/b', '/Users/me/c']),
      serverTab
    )
    expect(html).toContain('data-drop-refusal="3"')
    expect(html).toContain('3 folders stay on this Mac')
  })

  it('never appears on this Mac’s tab', () => {
    expect(dropFolders(null, 'local-tab-1', 1, ['/Users/me/site'])).toBeNull()
  })

  it('goes on Escape', () => {
    const shown = dropFolders(null, serverTab, 1, ['/Users/me/site'])
    expect(card(reduceDropRefusal(shown, { type: 'dismissed' }), serverTab)).toBe('')
  })

  it('goes when a later drop or attach lands, not when a file of the same drop does', () => {
    const shown = dropFolders(null, serverTab, 1, ['/Users/me/site'])
    expect(card(reduceDropRefusal(shown, { type: 'landed', batch: 1 }), serverTab)).toContain(
      'Folders stay on this Mac'
    )
    expect(card(reduceDropRefusal(shown, { type: 'landed', batch: 2 }), serverTab)).toBe('')
  })
})

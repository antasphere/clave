import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  copyOfferToClipboard,
  createOffer,
  dismissSessionOffers,
  installCopyOfferShell,
  listOfferViews
} from './copy-offer-manager'

// The store imports no Electron (PRDCT-3293): the clipboard and the windows
// come from the shell through `installCopyOfferShell`.
vi.mock('electron', () => {
  throw new Error('the copy offer store imported electron')
})

afterEach(() => {
  for (const view of listOfferViews()) dismissSessionOffers(view.callerSessionId)
  installCopyOfferShell(null)
})

describe('the copy offer store on the shell it is given', () => {
  it('copies the exact bytes through the shell and tells the windows', () => {
    const clipboard: string[] = []
    const broadcasts: unknown[] = []
    installCopyOfferShell({
      writeClipboard: (text) => clipboard.push(text),
      broadcast: (views) => broadcasts.push(views.map((v) => v.copiedAt !== undefined))
    })
    const offer = createOffer({
      callerSessionId: 's1',
      label: 'key',
      value: 'a\nb',
      sensitive: true
    })
    const view = copyOfferToClipboard(offer.id)
    expect(clipboard).toEqual(['a\nb'])
    expect(view.copiedAt).toBeTypeOf('number')
    expect(view.preview).toBe('')
    expect(broadcasts).toEqual([[false], [true]])
  })
  it('with no shell, keeps the offer and refuses the copy with the reason', () => {
    const offer = createOffer({ callerSessionId: 's1', label: 'key', value: 'v', sensitive: false })
    expect(listOfferViews().map((v) => v.id)).toEqual([offer.id])
    expect(() => copyOfferToClipboard(offer.id)).toThrow(/no clipboard/)
    expect(listOfferViews()[0].copiedAt).toBeUndefined()
  })
})

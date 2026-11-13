import { describe, expect, it } from 'vitest'
import { resourceKey, sessionKey } from '@clave/contract/fleet'
import {
  dropRefusalWords,
  reduceDropRefusal,
  refusedKind,
  refusedOnThisMac,
  serverNameOf,
  type RefusedItem
} from './drop-refusal'

/** The refusal card's words and rules (PRDCT-4329); the card itself is
 *  pinned by plugins/chat-view/src/drop-refusal.test.ts. */
const serverTab = sessionKey({ serverId: 'studio', sessionId: 's1' })
const ipc = (sentence: string): Error =>
  new Error(`Error invoking remote method 'sessions:files': Error: ${sentence}`)
const folder = (name: string): RefusedItem => ({
  name,
  kind: 'folder',
  reason: 'Folders cannot be attached.'
})

describe('refusedKind', () => {
  it('reads the kind off the sentence readBounded and the upload use', () => {
    expect(refusedKind('Folders cannot be attached.')).toBe('folder')
    expect(refusedKind('Special files cannot be attached.')).toBe('special')
    expect(
      refusedKind('File is too large for a preview or a direct image. Send it as a file reference.')
    ).toBe('large')
    expect(refusedKind("EACCES: permission denied, open '/x'")).toBe('other')
  })
})

describe('refusedOnThisMac', () => {
  it('a folder of this Mac refused on a server tab is a card item', () => {
    expect(
      refusedOnThisMac(serverTab, '/Users/me/site', ipc('Folders cannot be attached.'), 'site')
    ).toEqual({ name: 'site', kind: 'folder', reason: 'Folders cannot be attached.' })
  })
  it('never on this Mac’s tab: the path goes in the message there', () => {
    expect(
      refusedOnThisMac('local-tab', '/Users/me/site', ipc('Folders cannot be attached.'), 'site')
    ).toBeNull()
  })
  it('never for another server’s file: it is not on this Mac', () => {
    const other = resourceKey('file', 'other', '/srv/site')
    expect(
      refusedOnThisMac(serverTab, other, new Error('This file belongs to another server.'), 'site')
    ).toBeNull()
  })
})

describe('reduceDropRefusal', () => {
  it('one drop’s refusals make one card; a newer drop’s replace it', () => {
    let state = reduceDropRefusal(null, { type: 'refused', batch: 1, item: folder('a') })
    state = reduceDropRefusal(state, { type: 'refused', batch: 1, item: folder('b') })
    expect(state?.items.map((i) => i.name)).toEqual(['a', 'b'])
    state = reduceDropRefusal(state, { type: 'refused', batch: 2, item: folder('c') })
    expect(state).toEqual({ batch: 2, items: [folder('c')] })
  })
  it('a later drop that lands takes the card away; a file of the same drop does not', () => {
    const state = reduceDropRefusal(null, { type: 'refused', batch: 3, item: folder('a') })
    expect(reduceDropRefusal(state, { type: 'landed', batch: 3 })).toBe(state)
    expect(reduceDropRefusal(state, { type: 'landed', batch: 4 })).toBeNull()
  })
  it('Escape, the X and a sent message dismiss it', () => {
    const state = reduceDropRefusal(null, { type: 'refused', batch: 1, item: folder('a') })
    expect(reduceDropRefusal(state, { type: 'dismissed' })).toBeNull()
  })
})

describe('dropRefusalWords', () => {
  it('a folder: the title and the sentence, with the server’s name', () => {
    expect(dropRefusalWords([folder('site')], 'Studio')).toEqual({
      title: 'Folders stay on this Mac',
      sentence:
        "This session runs on Studio, which can't open the folders on your Mac. Drop files instead: they are copied to the server."
    })
  })
  it('several folders: one card, the title in the plural', () => {
    expect(dropRefusalWords([folder('a'), folder('b'), folder('c')], 'Studio').title).toBe(
      '3 folders stay on this Mac'
    )
  })
  it('a special file: its name in the title, the reason in plain words', () => {
    const words = dropRefusalWords(
      [{ name: 'agent.sock', kind: 'special', reason: 'Special files cannot be attached.' }],
      'Studio'
    )
    expect(words.title).toBe('agent.sock stayed on this Mac')
    expect(words.sentence).toBe(
      'This session runs on Studio, and agent.sock is not a regular file: a socket, a pipe or a device has no contents to copy there.'
    )
  })
  it('several of mixed kinds: each named with its reason', () => {
    const words = dropRefusalWords(
      [folder('site'), { name: 'big.mov', kind: 'large', reason: 'File is too large.' }],
      'Studio'
    )
    expect(words.title).toBe('2 items stayed on this Mac')
    expect(words.sentence).toBe(
      'This session runs on Studio, and these could not be copied there: site (a folder), big.mov (too large).'
    )
  })
})

describe('serverNameOf', () => {
  it('the name the person gave the server, or a plain fallback', () => {
    const connections = [{ id: 'studio', name: 'Studio', url: 'http://x', enabled: true }]
    expect(serverNameOf(connections, 'studio')).toBe('Studio')
    expect(serverNameOf(connections, 'gone')).toBe('a Clave server')
  })
})

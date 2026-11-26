import { describe, expect, it } from 'vitest'
import * as publisher from '../routines/publisher'
import {
  firstLine,
  isGone,
  parseJsonOutput,
  parsePush,
  parseShare,
  parseSharedLink
} from './slideless-json'

/**
 * The readers of the command's `--json` answers (PRDCT-4266), shared by the
 * routines' publisher and an artefact's links: the publisher exports the
 * same four it always did, and a share's token says what it is.
 */
describe('the readers of the command’s answers', () => {
  it('are the ones the routines’ publisher still exports', () => {
    expect(publisher.parseJsonOutput).toBe(parseJsonOutput)
    expect(publisher.parsePush).toBe(parsePush)
    expect(publisher.parseShare).toBe(parseShare)
    expect(publisher.isGone).toBe(isGone)
  })

  it('read what a share’s token says of the link, and what it does not as unsaid', () => {
    const created = {
      url: 'https://decks.example.test/s/secret',
      shareToken: {
        id: 't1',
        name: 'For a client',
        createdAt: '2026-11-26T10:00:00.000Z',
        expiresAt: null,
        pinnedVersion: 4,
        hasPassword: true
      },
      embed: {}
    }
    expect(parseSharedLink(JSON.stringify(created))).toEqual({
      tokenId: 't1',
      url: 'https://decks.example.test/s/secret',
      name: 'For a client',
      createdAt: '2026-11-26T10:00:00.000Z',
      expiresAt: null,
      pinnedVersion: 4,
      hasPassword: true
    })
    const bare = { url: 'https://decks.example.test/s/secret', shareToken: { id: 't2' } }
    expect(parseSharedLink(JSON.stringify(bare))).toEqual({
      tokenId: 't2',
      url: 'https://decks.example.test/s/secret',
      name: undefined,
      createdAt: undefined,
      expiresAt: undefined,
      pinnedVersion: undefined,
      hasPassword: undefined
    })
    expect(parseSharedLink('{"url":"https://decks.example.test/s/x"}')).toBeNull()
    expect(parseSharedLink('not json')).toBeNull()
  })

  it('tell a deck that is gone from any other refusal, and keep a first line short', () => {
    expect(isGone({ code: 1, stderr: 'Error: not_found: no such deck' })).toBe(true)
    expect(isGone({ code: 1, stderr: 'Error: the key was refused' })).toBe(false)
    expect(isGone({ code: null, stderr: 'not found' })).toBe(false)
    expect(firstLine('\n\n  Error: first  \nsecond')).toBe('Error: first')
    expect(firstLine('x'.repeat(400))).toHaveLength(300)
  })
})

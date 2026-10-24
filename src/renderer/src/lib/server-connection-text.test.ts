import { describe, expect, it } from 'vitest'
import type { ServerConnectionStatus } from '@clave/contract/fleet'
import { describeAddError, describeServerState } from './server-connection-text'

describe('describeServerState', () => {
  it('says Connecting while an enabled connection has no status', () => {
    expect(describeServerState(undefined, true)).toEqual({ label: 'Connecting…', error: null })
  })

  it.each<[ServerConnectionStatus['state'], string]>([
    ['connecting', 'Connecting…'],
    ['reconnecting', 'Reconnecting…'],
    ['connected', 'Connected'],
    ['disconnected', 'Disconnected'],
    ['offline', 'Unreachable'],
    ['unauthorized', 'Token refused']
  ])('describes the %s state', (state, label) => {
    expect(describeServerState({ serverId: 'fixture', state }, true)).toEqual({
      label,
      error: null
    })
  })

  it.each<[NonNullable<ServerConnectionStatus['error']>, string]>([
    [
      'unauthorized',
      'The server refused the token. Remove this server and add it again with its current token.'
    ],
    [
      'unreachable',
      'The server did not answer at this address. Check the address and that the server is running.'
    ],
    [
      'credentials-unavailable',
      'The saved token could not be read from this Mac. Remove this server and add it again.'
    ]
  ])('gives an actionable sentence for %s', (error, sentence) => {
    expect(describeServerState({ serverId: 'fixture', state: 'offline', error }, true)).toEqual({
      label: 'Unreachable',
      error: sentence
    })
  })

  it('disabling a connection overrides its old status and error', () => {
    expect(describeServerState(undefined, false)).toEqual({ label: 'Disconnected', error: null })
    expect(
      describeServerState(
        { serverId: 'fixture', state: 'unauthorized', error: 'unauthorized' },
        false
      )
    ).toEqual({ label: 'Disconnected', error: null })
    expect(describeServerState({ serverId: 'fixture', state: 'connected' }, false)).toEqual({
      label: 'Disconnected',
      error: null
    })
  })
})

describe('describeAddError', () => {
  const addressError =
    'Enter a valid Clave server base address without credentials, path, query or fragment.'
  const fallback = 'The server operation failed. Check its connection and try again.'

  it.each([
    'Enter a server name of at most 120 characters.',
    'Enter a valid Clave server address.',
    addressError,
    'Too many saved server connections.',
    'Enter a valid bearer token of at most 8192 characters.',
    'A bearer token is required.',
    'Secure credential storage is unavailable. The connection was not saved.',
    'Could not allocate a server connection identity.',
    'Unknown server connection.',
    'Could not save server connections. Previous settings were retained.',
    'Saved server connections could not be read. The document was left unchanged.'
  ])('returns the curated registry sentence: %s', (sentence) => {
    expect(describeAddError(new Error(sentence))).toBe(sentence)
    expect(describeAddError(sentence)).toBe(sentence)
    expect(
      describeAddError(
        new Error(`Error invoking remote method 'server:fleet:save': Error: ${sentence}`)
      )
    ).toBe(sentence)
  })

  it('takes the sentence after the last Error prefix of the save wrapper', () => {
    expect(
      describeAddError(
        `Error invoking remote method 'server:fleet:save': Error: Error: ${addressError}`
      )
    ).toBe(addressError)
  })

  it.each([
    undefined,
    null,
    { message: addressError },
    new Error('private adapter details and a fixture token'),
    "Error invoking remote method 'server:fleet:save': Error: private details",
    `Error invoking remote method 'other': Error: ${addressError}`,
    `Error: ${addressError}`,
    `${addressError} private details`
  ])('hides unexpected failures instead of exposing their details', (error) => {
    expect(describeAddError(error)).toBe(fallback)
  })
})

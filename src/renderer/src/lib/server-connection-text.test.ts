import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ServerConnectionStatus, ServerVersionStatus } from '@clave/contract/fleet'
import {
  describeAddError,
  describeServerState,
  describeServerVersion,
  SAVE_ERRORS,
  UPGRADE_NOW_WARNING
} from './server-connection-text'

describe('describeServerState', () => {
  it('says Connecting while an enabled connection has no status', () => {
    expect(describeServerState(undefined, true)).toEqual({
      label: 'Connecting…',
      error: null,
      tone: 'connecting'
    })
  })

  it.each<[ServerConnectionStatus['state'], string, 'connected' | 'connecting' | 'error' | 'idle']>(
    [
      ['connecting', 'Connecting…', 'connecting'],
      ['reconnecting', 'Reconnecting…', 'connecting'],
      ['connected', 'Connected', 'connected'],
      ['disconnected', 'Disconnected', 'idle'],
      ['offline', 'Unreachable', 'error'],
      ['unauthorized', 'Token refused', 'error']
    ]
  )('describes the %s state', (state, label, tone) => {
    expect(describeServerState({ serverId: 'fixture', state }, true)).toEqual({
      label,
      error: null,
      tone
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
      error: sentence,
      tone: 'error'
    })
  })

  it('disabling a connection overrides its old status and error', () => {
    expect(describeServerState(undefined, false)).toEqual({
      label: 'Disconnected',
      error: null,
      tone: 'idle'
    })
    expect(
      describeServerState(
        { serverId: 'fixture', state: 'unauthorized', error: 'unauthorized' },
        false
      )
    ).toEqual({ label: 'Disconnected', error: null, tone: 'idle' })
    expect(describeServerState({ serverId: 'fixture', state: 'connected' }, false)).toEqual({
      label: 'Disconnected',
      error: null,
      tone: 'idle'
    })
  })
})

describe('describeAddError', () => {
  const addressError =
    'Enter a valid Clave server base address without credentials, path, query or fragment.'
  const fallback = 'The server operation failed. Check its connection and try again.'

  it('keeps the safe sentence allow-list in sync with every registry error sentence', () => {
    const registry = readFileSync(
      new URL('../../../main/server-connections/registry.ts', import.meta.url),
      'utf8'
    )
    const sentences = new Set(
      [...registry.matchAll(/throw new Error\(\s*'([^']+)'\s*\)/g)]
        .map((match) => match[1])
        .filter((sentence) => sentence.endsWith('.'))
    )
    expect([...SAVE_ERRORS].sort()).toEqual([...sentences].sort())
  })

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

const status = (overrides: Partial<ServerVersionStatus>): ServerVersionStatus => ({
  serverId: 's',
  kind: 'match',
  appVersion: '3.0.0-beta.8',
  automatic: true,
  serverVersion: '3.0.0-beta.7',
  installRef: 'v3.0.0-beta.7',
  ...overrides
})

describe('describeServerVersion (issue #266)', () => {
  it('says nothing before a read, or for a server that does not answer', () => {
    expect(describeServerVersion(undefined)).toBeNull()
    expect(
      describeServerVersion(status({ kind: 'unreachable', serverVersion: undefined }))
    ).toBeNull()
  })

  it.each<[Partial<ServerVersionStatus>, string, boolean]>([
    [{ kind: 'match', serverVersion: '3.0.0-beta.8' }, 'Same version as this app', false],
    [
      { kind: 'upgrade', target: '3.0.0-beta.8' },
      'Upgrading to 3.0.0-beta.8 once no agent is working',
      true
    ],
    [
      { kind: 'upgrading', target: '3.0.0-beta.8', upgradeState: 'waiting-for-idle' },
      'Upgrading to 3.0.0-beta.8 once no agent is working',
      true
    ],
    [
      { kind: 'upgrading', target: '3.0.0-beta.8', upgradeState: 'running' },
      'Upgrading to 3.0.0-beta.8…',
      false
    ],
    [
      { kind: 'failed', target: '3.0.0-beta.8', error: 'npm ERR! build' },
      'Upgrade to 3.0.0-beta.8 failed: npm ERR! build',
      true
    ],
    [{ kind: 'server-newer', serverVersion: '3.0.0' }, 'Newer than this app', false],
    [
      { kind: 'custom-ref', installRef: 'dev', serverVersion: '2.4.0' },
      'Installed from dev; upgrade it on the server',
      false
    ],
    [
      { kind: 'unsupported', installRef: null, reason: 'not installed by install-server.sh' },
      'This server does not upgrade from the Mac: not installed by install-server.sh',
      false
    ]
  ])('describes %j', (overrides, state, upgradeNow) => {
    const text = describeServerVersion(status(overrides))
    expect(text).toMatchObject({ state, upgradeNow })
    expect(text?.version).toBe(`Version ${overrides.serverVersion ?? '3.0.0-beta.7'}`)
  })

  it('gives an older server the exact command to run on it', () => {
    expect(
      describeServerVersion(
        status({
          kind: 'manual',
          serverVersion: undefined,
          installRef: undefined,
          command: 'bash ~/install-server.sh --ref v3.0.0-beta.8'
        })
      )
    ).toEqual({
      version: null,
      state: 'Older Clave server: run this on the server',
      tone: 'connecting',
      command: 'bash ~/install-server.sh --ref v3.0.0-beta.8',
      upgradeNow: false
    })
  })

  it('tells a daemon the script did not install how to install it, with the command (V1-F1)', () => {
    expect(
      describeServerVersion(
        status({
          kind: 'unsupported',
          installRef: null,
          reason: 'not installed by install-server.sh',
          command: 'bash ~/install-server.sh --ref v3.0.0-beta.8'
        })
      )
    ).toEqual({
      version: 'Version 3.0.0-beta.7',
      state:
        'This server does not upgrade from the Mac: not installed by install-server.sh. Install it with the script, so this Mac keeps it on its version:',
      tone: 'idle',
      command: 'bash ~/install-server.sh --ref v3.0.0-beta.8',
      upgradeNow: false
    })
  })

  it('offers no upgrade from a dev build, and says why', () => {
    for (const kind of ['upgrade', 'failed'] as const)
      expect(
        describeServerVersion(
          status({ kind, target: '3.0.0-beta.8', error: 'x', automatic: false })
        )
      ).toMatchObject({
        state: expect.stringContaining('development build'),
        upgradeNow: false
      })
  })

  it('warns that an upgrade now ends the running sessions', () => {
    expect(UPGRADE_NOW_WARNING).toBe(
      'Upgrading restarts the server: its running sessions end and come back as ended tabs to Resume.'
    )
  })
})

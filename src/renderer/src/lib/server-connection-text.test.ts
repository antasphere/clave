import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ServerConnectionStatus, ServerVersionStatus } from '@clave/contract/fleet'
import {
  SERVER_UPGRADE_FAILURE_CODES,
  SERVER_UPGRADE_PHASES
} from '@clave/contract/upgrade-failure'
import {
  describeAddError,
  describeServerState,
  describeServerVersion,
  describeUpgradeFailure,
  SAVE_ERRORS,
  UPGRADE_FAILURE_SENTENCES,
  UPGRADE_NOW_WARNING,
  UPGRADE_PHASE_WORDS
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
      {
        kind: 'failed',
        target: '3.0.0-beta.8',
        failure: { code: 'no-such-release', phase: 'resolve', exitCode: 1, logPath: '/srv/u.log' }
      },
      'Upgrade to 3.0.0-beta.8 failed: The server could not find the release 3.0.0-beta.8.\nExit 1. Full log on the server: /srv/u.log',
      true
    ],
    [
      {
        kind: 'failed',
        target: '3.0.0-beta.8',
        error: 'This server cannot upgrade itself: not installed by install-server.sh.'
      },
      'Upgrade to 3.0.0-beta.8 failed: This server cannot upgrade itself: not installed by install-server.sh.',
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

  it.each<[Partial<ServerVersionStatus>, string]>([
    [
      { kind: 'upgrading', target: '3.0.0-beta.10', upgradeState: 'waiting-for-idle' },
      'Upgrading to 3.0.0-beta.10 once no agent is working'
    ],
    [
      { kind: 'upgrading', target: '3.0.0-beta.10', upgradeState: 'running' },
      'Upgrading to 3.0.0-beta.10…'
    ],
    [
      { kind: 'failed', target: '3.0.0-beta.10', failure: { code: 'rolled-back', exitCode: 1 } },
      'Upgrade to 3.0.0-beta.10 failed: The new release did not start; the server went back to the previous one.\nExit 1.'
    ]
  ])(
    "shows another Mac's upgrade on an equal or newer server, with no Upgrade now (V2-F2): %j",
    (overrides, state) => {
      expect(
        describeServerVersion(
          status({ serverVersion: '3.0.0-beta.8', ownAction: false, ...overrides })
        )
      ).toMatchObject({ state, upgradeNow: false })
    }
  )

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

  it('has a sentence of its own for every failure code, and none for a code that is not one', () => {
    expect(Object.keys(UPGRADE_FAILURE_SENTENCES).sort()).toEqual(
      [...SERVER_UPGRADE_FAILURE_CODES].sort()
    )
    const sentences = SERVER_UPGRADE_FAILURE_CODES.map((code) =>
      UPGRADE_FAILURE_SENTENCES[code]('3.0.0-beta.10')
    )
    for (const sentence of sentences) expect(sentence).toMatch(/^[A-Z0-9].*\.$/)
    expect(new Set(sentences).size).toBe(sentences.length)
  })

  it.each([
    ['no-such-release', 'The server could not find the release 3.0.0-beta.10.'],
    ['node-too-old', "The server's Node is too old (22 or newer is needed)."],
    ['rolled-back', 'The new release did not start; the server went back to the previous one.']
  ] as const)('words %s as the brief says', (code, sentence) => {
    expect(describeUpgradeFailure({ code }, '3.0.0-beta.10')).toBe(sentence)
  })

  it('names the target this Mac decided on, never anything the server said', () => {
    expect(describeUpgradeFailure({ code: 'build-incomplete' }, '3.0.0-beta.10')).toBe(
      'The build of 3.0.0-beta.10 did not produce the server.'
    )
  })

  it.each(SERVER_UPGRADE_PHASES.map((phase) => [phase]))(
    'words the phase %s of a failure with no code',
    (phase) => {
      expect(describeUpgradeFailure({ code: 'unknown', phase }, '3.0.0')).toBe(
        `The upgrade failed while ${UPGRADE_PHASE_WORDS[phase]}.`
      )
      expect(describeUpgradeFailure({ phase }, '3.0.0')).toBe(
        `The upgrade failed while ${UPGRADE_PHASE_WORDS[phase]}.`
      )
    }
  )

  it('keeps the sentence of a known code whatever the phase', () => {
    expect(describeUpgradeFailure({ code: 'no-such-release', phase: 'build' }, '3.0.0')).toBe(
      'The server could not find the release 3.0.0.'
    )
  })

  it('says the script gave no reason when there is neither a code nor a phase', () => {
    expect(describeUpgradeFailure({}, '3.0.0')).toBe(
      'The install script stopped without saying why.'
    )
  })

  it('puts the exit and the log on a line of their own, each only when known', () => {
    const log = '/home/u/.local/share/clave-server/upgrade/upgrade.log'
    expect(
      describeUpgradeFailure(
        { code: 'unknown', phase: 'dependencies', exitCode: 3, logPath: log },
        '3.0.0'
      )
    ).toBe(
      `The upgrade failed while installing dependencies.\nExit 3. Full log on the server: ${log}`
    )
    expect(describeUpgradeFailure({ code: 'launch-failed', logPath: log }, '3.0.0')).toBe(
      `The server could not start the install script.\nFull log on the server: ${log}`
    )
    expect(describeUpgradeFailure({ code: 'unknown', exitCode: 0 }, '3.0.0')).toBe(
      'The install script stopped without saying why.\nExit 0.'
    )
  })

  it('shows a failed status with no failure at all, as an older server sends it', () => {
    expect(describeServerVersion(status({ kind: 'failed', target: '3.0.0-beta.8' }))).toMatchObject(
      {
        state: 'Upgrade to 3.0.0-beta.8 failed: The install script stopped without saying why.'
      }
    )
  })

  it('warns that an upgrade now ends the running sessions', () => {
    expect(UPGRADE_NOW_WARNING).toBe(
      'Upgrading restarts the server: its running sessions end and come back as ended tabs to Resume.'
    )
  })
})

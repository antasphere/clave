import { describe, expect, it } from 'vitest'
import { Either, Schema } from 'effect'
import {
  isReleaseTag,
  isReleaseVersion,
  SERVER_UPGRADE_FAILURE_CODES,
  SERVER_UPGRADE_PHASES,
  ServerInfo,
  ServerUpgradeStatus
} from './server-info'
import { ServerEvent } from './events'

describe('the release version an upgrade accepts', () => {
  it.each(['3.0.0', '3.0.0-beta.9', '0.0.1', '10.20.30', '1.0.0-rc.1', '1.0.0-alpha-1', '1.0.0-0'])(
    'accepts %s',
    (version) => expect(isReleaseVersion(version)).toBe(true)
  )

  it.each([
    '',
    'v3.0.0',
    '3.0',
    '3',
    '03.0.0',
    '3.00.0',
    '3.0.0-01',
    '3.0.0+build.1',
    '3.0.0-',
    '3.0.0-beta..1',
    'latest',
    'dev',
    '--force',
    '3.0.0 --repo x',
    '3.0.0\n',
    '3.0.0;rm -rf ~',
    '../3.0.0',
    'https://example.com/clave.git',
    `1.0.0-${'a'.repeat(64)}`
  ])('refuses %j', (version) => expect(isReleaseVersion(version)).toBe(false))

  it('refuses what is not a string', () => {
    for (const value of [undefined, null, 3, {}, ['3.0.0']])
      expect(isReleaseVersion(value)).toBe(false)
  })

  it('reads a release tag as v<semver> and nothing else', () => {
    expect(isReleaseTag('v3.0.0-beta.6')).toBe(true)
    expect(isReleaseTag('v3.0.0')).toBe(true)
    for (const ref of ['3.0.0', 'dev', 'main', 'vdev', 'v3.0', 'feature/v3.0.0', null])
      expect(isReleaseTag(ref)).toBe(false)
  })
})

describe('the server info and its event on the wire', () => {
  it('round-trips the info of a server installed from a tag', () => {
    const info = {
      version: '3.0.0-beta.9',
      installRef: 'v3.0.0-beta.9',
      upgrade: {
        supported: true,
        state: 'waiting-for-idle',
        target: '3.0.0-beta.10',
        mode: 'when-idle',
        since: 1
      }
    }
    expect(Schema.decodeUnknownEither(ServerInfo)(info)).toEqual(Either.right(info))
  })

  it('carries the upgrade state as a server event', () => {
    const event = {
      _tag: 'server.upgrade_changed',
      status: {
        supported: true,
        state: 'failed',
        target: '3.0.0',
        failure: {
          code: 'no-such-release',
          phase: 'resolve',
          exitCode: 1,
          logPath: '/srv/data/upgrade/upgrade.log'
        }
      }
    }
    expect(Schema.decodeUnknownEither(ServerEvent)(event)).toEqual(Either.right(event))
  })
})

describe('a failed upgrade on the wire: codes and phases from closed lists', () => {
  const decode = Schema.decodeUnknownEither(ServerUpgradeStatus)
  const encode = Schema.encodeEither(ServerUpgradeStatus)
  const failed = (failure: unknown): unknown => ({
    supported: true,
    state: 'failed',
    target: '3.0.0',
    failure
  })

  it.each(SERVER_UPGRADE_FAILURE_CODES.map((code) => [code]))('decodes and encodes %s', (code) => {
    const status = failed({ code, exitCode: 3, logPath: '/srv/upgrade.log' })
    const decoded = decode(status)
    expect(decoded).toEqual(Either.right(status))
    expect(encode(Either.getOrThrow(decoded))).toEqual(Either.right(status))
  })

  it.each(SERVER_UPGRADE_PHASES.map((phase) => [phase]))('decodes the phase %s', (phase) => {
    expect(decode(failed({ code: 'unknown', phase }))).toEqual(
      Either.right(failed({ code: 'unknown', phase }))
    )
  })

  it.each([
    'Could not reach https://user:secret@example.com/clave.git',
    'no-such-thing',
    'NO-SUCH-RELEASE',
    'no-such-release\nsecret',
    ''
  ])('reads a code it does not know (%j) as absent, the rest intact', (code) => {
    expect(
      decode(failed({ code, phase: 'not a phase', exitCode: 1, logPath: '/srv/upgrade.log' }))
    ).toEqual(Either.right(failed({ exitCode: 1, logPath: '/srv/upgrade.log' })))
  })

  it('never encodes a code or a phase outside the lists: a server cannot send text in them', () => {
    for (const failure of [{ code: 'npm ERR! token=secret' }, { phase: 'npm ERR! token=secret' }])
      expect(Either.isLeft(encode(failed(failure) as ServerUpgradeStatus))).toBe(true)
  })

  it('carries no text field: an error a server put beside the failure is dropped', () => {
    expect(
      decode({ ...(failed({ code: 'unknown' }) as object), error: 'npm ERR! token=secret' })
    ).toEqual(Either.right(failed({ code: 'unknown' })))
  })

  it('decodes a failed status with no failure at all, as an older server sends it', () => {
    expect(decode({ supported: true, state: 'failed', target: '3.0.0' })).toEqual(
      Either.right({ supported: true, state: 'failed', target: '3.0.0' })
    )
  })
})

import { describe, expect, it } from 'vitest'
import { Either, Schema } from 'effect'
import { isReleaseTag, isReleaseVersion, ServerInfo } from './server-info'
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
      status: { supported: true, state: 'failed', target: '3.0.0', error: 'npm ci failed' }
    }
    expect(Schema.decodeUnknownEither(ServerEvent)(event)).toEqual(Either.right(event))
  })
})

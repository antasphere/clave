import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { apnsFileProblem, fcmFileProblem, loadPushPorts, type LoadedPushPorts } from './credentials'

/**
 * The push credentials, read once at boot from `push/` under the server's
 * data directory (the mobile wave, lane B): a missing file leaves that
 * transport off and is said once, a broken one too, and no line ever
 * carries a value of the file.
 */
const dirs: string[] = []
const loaded: LoadedPushPorts[] = []
afterEach(() => {
  for (const l of loaded.splice(0)) l.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const dataDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clave-push-'))
  dirs.push(dir)
  return dir
}
const load = (dir: string, fake = false): { ports: LoadedPushPorts; lines: string[] } => {
  const lines: string[] = []
  const ports = loadPushPorts({
    dataDir: dir,
    fake,
    log: (line) => lines.push(line),
    serverName: 'Mac'
  })
  loaded.push(ports)
  return { ports, lines }
}
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const P8 = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const RSA_PEM = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string

describe('loading the push credentials', () => {
  it('leaves both transports off, said once each, when the files are missing', () => {
    const { ports, lines } = load(dataDir())
    expect(ports.report).toEqual({ ios: false, android: false, fake: false })
    expect(ports.ports.pushTransports).toEqual({})
    expect(ports.ports.pushTargets).toBeUndefined()
    expect(ports.ports.notify).toEqual({ serverName: 'Mac' })
    expect(lines).toEqual([
      'push: APNs off (no push/apns.json under the data directory)',
      'push: FCM off (no push/fcm-service-account.json under the data directory)'
    ])
  })
  it('turns APNs and FCM on from valid files, naming the topic and the project', () => {
    const dir = dataDir()
    mkdirSync(path.join(dir, 'push'))
    writeFileSync(path.join(dir, 'push', 'AuthKey_KEY1.p8'), P8)
    writeFileSync(
      path.join(dir, 'push', 'apns.json'),
      JSON.stringify({
        keyId: 'KEY1',
        teamId: 'TEAM1',
        bundleId: 'com.antasphere.clave',
        keyFile: 'AuthKey_KEY1.p8',
        sandbox: true
      })
    )
    writeFileSync(
      path.join(dir, 'push', 'fcm-service-account.json'),
      JSON.stringify({
        type: 'service_account',
        project_id: 'clave-beta',
        client_email: 'push@clave-beta.iam',
        private_key: RSA_PEM,
        token_uri: 'https://oauth2.example/token'
      })
    )
    const { ports, lines } = load(dir)
    expect(ports.report).toEqual({ ios: true, android: true, fake: false })
    expect(ports.ports.pushTransports.ios).toBeDefined()
    expect(ports.ports.pushTransports.android).toBeDefined()
    expect(lines).toEqual([
      'push: APNs on (topic com.antasphere.clave, sandbox)',
      'push: FCM on (project clave-beta)'
    ])
    expect(lines.join('\n').includes('PRIVATE KEY')).toBe(false)
  })
  it('names the field a file lacks, and never a value of it', () => {
    const dir = dataDir()
    mkdirSync(path.join(dir, 'push'))
    writeFileSync(
      path.join(dir, 'push', 'apns.json'),
      JSON.stringify({ keyId: 'KEY-VALUE-1', teamId: 'TEAM1', bundleId: 'b' })
    )
    writeFileSync(
      path.join(dir, 'push', 'fcm-service-account.json'),
      JSON.stringify({ project_id: 'p', client_email: 'e', private_key: 'PRIVATE-VALUE' })
    )
    const { ports, lines } = load(dir)
    expect(ports.report).toEqual({ ios: false, android: false, fake: false })
    expect(lines).toEqual([
      'push: APNs off (push/apns.json: apns.json is not valid (keyFile))',
      'push: FCM off (push/fcm-service-account.json: fcm-service-account.json is not valid (token_uri))'
    ])
    expect(lines.join('\n').includes('KEY-VALUE-1')).toBe(false)
    expect(lines.join('\n').includes('PRIVATE-VALUE')).toBe(false)
  })
  it('says a file is not JSON, a key file is missing, or a key is not an EC key, without their content', () => {
    const dir = dataDir()
    mkdirSync(path.join(dir, 'push'))
    writeFileSync(path.join(dir, 'push', 'apns.json'), '{not json SECRET-IN-FILE')
    expect(load(dir).lines[0]).toBe('push: APNs off (push/apns.json: not valid JSON)')
    writeFileSync(
      path.join(dir, 'push', 'apns.json'),
      JSON.stringify({ keyId: 'K', teamId: 'T', bundleId: 'b', keyFile: 'missing.p8' })
    )
    expect(load(dir).lines[0]).toBe(
      'push: APNs off (push/apns.json: the key file named is missing)'
    )
    writeFileSync(path.join(dir, 'push', 'rsa.p8'), RSA_PEM)
    writeFileSync(
      path.join(dir, 'push', 'apns.json'),
      JSON.stringify({ keyId: 'K', teamId: 'T', bundleId: 'b', keyFile: 'rsa.p8' })
    )
    expect(load(dir).lines[0]).toBe(
      'push: APNs off (push/apns.json: the key file is not an EC key (rsa))'
    )
    writeFileSync(
      path.join(dir, 'push', 'fcm-service-account.json'),
      JSON.stringify({
        project_id: 'p',
        client_email: 'e',
        private_key: 'not a key',
        token_uri: 'u'
      })
    )
    const { lines } = load(dir)
    expect(lines[1].startsWith('push: FCM off (push/fcm-service-account.json: ')).toBe(true)
    expect(lines.join('\n').includes('SECRET-IN-FILE')).toBe(false)
  })
  it('puts the recording fake and a fake phone registry in place under the flag', async () => {
    const { ports, lines } = load(dataDir(), true)
    expect(ports.report).toEqual({ ios: true, android: true, fake: true })
    expect(ports.ports.notify).toEqual({ serverName: 'Mac', fake: true })
    expect(lines).toEqual(['push: the recording fake stands in for APNs and FCM (--push-fake)'])
    const hooks = ports.hooks!
    hooks.targets.add({ deviceId: 'phone-1', platform: 'ios', token: 't1' })
    expect(hooks.targets.list()).toEqual([{ deviceId: 'phone-1', platform: 'ios', token: 't1' }])
    expect(hooks.sent()).toEqual([])
    hooks.answer('gone')
    hooks.targets.remove('phone-1')
    expect(hooks.targets.list()).toEqual([])
  })
})

describe('what a credentials file must carry', () => {
  it('names the first missing field of each file', () => {
    expect(apnsFileProblem(null)).toBe('not an object')
    expect(apnsFileProblem({})).toBe('keyId')
    expect(
      apnsFileProblem({ keyId: 'k', teamId: 't', bundleId: 'b', keyFile: 'f', sandbox: 'yes' })
    ).toBe('sandbox')
    expect(apnsFileProblem({ keyId: 'k', teamId: 't', bundleId: 'b', keyFile: 'f' })).toBeNull()
    expect(fcmFileProblem([])).toBe('project_id')
    expect(
      fcmFileProblem({ project_id: 'p', client_email: 'e', private_key: 'k', token_uri: 'u' })
    ).toBeNull()
  })
})

import { parsePushFixtureArgs } from './credentials'
import { startEmbedded } from '../embedded'
import { FakeSource } from '../test-support'
import { memoryDeviceStorage } from '../devices/port'
import { DeviceStore } from '../devices/store'

describe('push fixture flags', () => {
  it('preserves normal and legacy full fake boot', () => {
    expect(parsePushFixtureArgs([])).toEqual({ fake: false, fakeTargets: true })
    expect(parsePushFixtureArgs(['--push-fake'])).toEqual({ fake: true, fakeTargets: true })
  })
  it('gates transport-only recording and refuses ambiguous modes', () => {
    expect(() => parsePushFixtureArgs(['--push-fake-transports'])).toThrow('--test-no-activate')
    expect(parsePushFixtureArgs(['--push-fake-transports', '--test-no-activate'])).toEqual({
      fake: true,
      fakeTargets: false
    })
    for (const flags of [[], ['--test-no-activate']])
      expect(() =>
        parsePushFixtureArgs(['--push-fake', '--push-fake-transports', ...flags])
      ).toThrow('only one')
  })
})

describe('recording transports with the real device registry', () => {
  it('records a real phone send, follows token rotation and forgets gone tokens in DeviceSessions', async () => {
    const push = loadPushPorts({
      dataDir: dataDir(),
      fake: true,
      fakeTargets: false,
      log: () => {}
    })
    loaded.push(push)
    expect(push.ports.pushTargets).toBeUndefined()
    expect(push.report).toEqual({ ios: true, android: true, fake: true })
    const sends = vi.spyOn(push.ports.pushTransports.ios!, 'send')
    const storage = memoryDeviceStorage()
    // Create the credential through the real device store, not a fabricated document.
    const paired = new DeviceStore(storage).create({
      name: 'Phone',
      platform: 'ios',
      appVersion: '0.1.0'
    })
    const server = await startEmbedded({
      ports: {
        sessions: new FakeSource(),
        ...push.ports,
        devices: {
          storage,
          owner: () => 'owner',
          issuer: 'https://hub.example',
          serverName: () => 'Mac'
        }
      }
    })
    const call = (route: string, body: unknown, token = server.token): Promise<Response> =>
      fetch(`${server.url}${route}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    try {
      for (const token of ['apns-first', 'apns-rotated']) {
        expect(
          (await call('/devices/me/push-token', { token, platform: 'ios' }, paired.token)).status
        ).toBe(204)
        expect((await call('/notify/test', { deviceId: paired.device.id })).status).toBe(200)
        expect(new DeviceStore(storage).pushTargets()).toEqual([
          { deviceId: paired.device.id, platform: 'ios', token }
        ])
      }
      expect(sends.mock.calls.map(([target]) => target.token)).toEqual([
        'apns-first',
        'apns-rotated'
      ])
      expect(push.hooks!.sent()).toHaveLength(2)
      expect(push.hooks!.sent().map((send) => send.deviceId)).toEqual([
        paired.device.id,
        paired.device.id
      ])
      push.hooks!.answer('gone')
      expect((await call('/notify/test', { deviceId: paired.device.id })).status).toBe(200)
      expect(new DeviceStore(storage).pushTargets()).toEqual([])
      expect(push.hooks!.sent().map((send) => send.outcome)).toEqual(['sent', 'sent', 'gone'])
      expect(push.hooks!.targets.list()).toEqual([])
      expect(push.hooks!.targets.forgotten()).toEqual([])
    } finally {
      await server.stop()
    }
  })
})

/**
 * The push credentials, read once at boot from the server's data directory
 * (the mobile wave, lane B): `push/apns.json` with the team's .p8 key beside
 * it, and `push/fcm-service-account.json`. A missing file leaves that
 * transport off, said once in the log as one line that carries no value; a
 * file that does not parse, or lacks a field, is said the same way with the
 * field's name. `docs/mobile-push.md` says what a teammate must obtain.
 *
 * `fake: true` (the entry's `--push-fake` flag) puts the recording transport
 * and the fake phone registry in place of both, for the end-to-end suite and
 * for a machine with no credentials yet; the status route says so.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createPrivateKey } from 'node:crypto'
import type { NotificationPayload } from '@clave/contract/notify'
import { apnsTransport } from './apns'
import { fcmTransport } from './fcm'
import { type FakePush, fakePush } from './fake'
import { machineName } from './live'
import type { NotifyOptions, PushTarget, PushTargets, PushTransports } from './port'

export const PUSH_DIR = 'push'
export const APNS_FILE = 'apns.json'
export const FCM_FILE = 'fcm-service-account.json'

/** What the end-to-end suite reaches through the fixture route under
 *  `--push-fake`: the sends recorded so far, and the fake phones. */
export interface NotifyE2eHooks {
  readonly sent: () => Array<{
    at: number
    deviceId: string
    platform: PushTarget['platform']
    payload: NotificationPayload
    outcome: string
  }>
  readonly targets: {
    readonly add: (target: PushTarget) => void
    readonly remove: (deviceId: string) => void
    readonly list: () => PushTarget[]
    readonly forgotten: () => Array<{ deviceId: string; token: string }>
  }
  /** What the next sends answer: `sent` (the default), `gone` or `failed`. */
  readonly answer: (outcome: 'sent' | 'gone' | 'failed') => void
}

export interface PushPortsReport {
  readonly ios: boolean
  readonly android: boolean
  readonly fake: boolean
}

export interface LoadedPushPorts {
  /** What the entry spreads into `ServerPorts`. */
  readonly ports: {
    readonly pushTargets?: PushTargets
    readonly pushTransports: PushTransports
    readonly notify: NotifyOptions
  }
  readonly report: PushPortsReport
  /** Under `--push-fake` only. */
  readonly hooks?: NotifyE2eHooks
  readonly close: () => void
}

export interface LoadPushPortsInput {
  readonly dataDir: string
  readonly fake?: boolean
  readonly log: (line: string) => void
  readonly serverName?: string
}

interface ApnsFile {
  keyId: string
  teamId: string
  bundleId: string
  keyFile: string
  sandbox?: boolean
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** The field the file lacks, or null when it has them all. */
export function apnsFileProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'not an object'
  const v = value as Record<string, unknown>
  for (const field of ['keyId', 'teamId', 'bundleId', 'keyFile'] as const)
    if (!nonEmpty(v[field])) return field
  if (v.sandbox !== undefined && typeof v.sandbox !== 'boolean') return 'sandbox'
  return null
}

export function fcmFileProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'not an object'
  const v = value as Record<string, unknown>
  for (const field of ['project_id', 'client_email', 'private_key', 'token_uri'] as const)
    if (!nonEmpty(v[field])) return field
  return null
}

export function loadPushPorts(input: LoadPushPortsInput): LoadedPushPorts {
  const serverName = input.serverName ?? machineName()
  if (input.fake) {
    const fake = fakePush()
    input.log('push: the recording fake stands in for APNs and FCM (--push-fake)')
    return {
      ports: {
        pushTargets: fake.targets,
        pushTransports: fake.transports,
        notify: { serverName, fake: true }
      },
      report: { ios: true, android: true, fake: true },
      hooks: hooksOf(fake),
      close: () => {}
    }
  }
  const dir = path.join(input.dataDir, PUSH_DIR)
  const closers: Array<() => void> = []
  const transports: { ios?: PushTransports['ios']; android?: PushTransports['android'] } = {}

  const apnsFile = path.join(dir, APNS_FILE)
  if (!fs.existsSync(apnsFile)) {
    input.log(`push: APNs off (no ${PUSH_DIR}/${APNS_FILE} under the data directory)`)
  } else {
    try {
      const parsed = readJson(apnsFile)
      const problem = apnsFileProblem(parsed)
      if (problem) throw new Error(`${APNS_FILE} is not valid (${problem})`)
      const file = parsed as ApnsFile
      const keyPath = path.isAbsolute(file.keyFile) ? file.keyFile : path.join(dir, file.keyFile)
      const privateKey = createPrivateKey(fs.readFileSync(keyPath, 'utf8'))
      if (privateKey.asymmetricKeyType !== 'ec')
        throw new Error(`the key file is not an EC key (${privateKey.asymmetricKeyType})`)
      const transport = apnsTransport({
        keyId: file.keyId,
        teamId: file.teamId,
        bundleId: file.bundleId,
        privateKey,
        sandbox: file.sandbox === true,
        log: input.log
      })
      transports.ios = transport
      closers.push(() => transport.close())
      input.log(
        `push: APNs on (topic ${file.bundleId}, ${file.sandbox === true ? 'sandbox' : 'production'})`
      )
    } catch (error) {
      input.log(`push: APNs off (${PUSH_DIR}/${APNS_FILE}: ${reasonOf(error)})`)
    }
  }

  const fcmFile = path.join(dir, FCM_FILE)
  if (!fs.existsSync(fcmFile)) {
    input.log(`push: FCM off (no ${PUSH_DIR}/${FCM_FILE} under the data directory)`)
  } else {
    try {
      const parsed = readJson(fcmFile)
      const problem = fcmFileProblem(parsed)
      if (problem) throw new Error(`${FCM_FILE} is not valid (${problem})`)
      const file = parsed as {
        project_id: string
        client_email: string
        private_key: string
        token_uri: string
      }
      // The key must at least parse: a broken PEM is said now, not at the first push.
      createPrivateKey(file.private_key)
      const transport = fcmTransport({
        projectId: file.project_id,
        clientEmail: file.client_email,
        privateKey: file.private_key,
        tokenUri: file.token_uri,
        log: input.log
      })
      transports.android = transport
      closers.push(() => transport.close())
      input.log(`push: FCM on (project ${file.project_id})`)
    } catch (error) {
      input.log(`push: FCM off (${PUSH_DIR}/${FCM_FILE}: ${reasonOf(error)})`)
    }
  }

  return {
    ports: { pushTransports: transports, notify: { serverName } },
    report: {
      ios: transports.ios !== undefined,
      android: transports.android !== undefined,
      fake: false
    },
    close: () => {
      for (const close of closers) close()
    }
  }
}

/** The reason a file was refused, with no content of the file in it: a
 *  parse error names a position, a key error its own words, never a value. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/JSON/i.test(message)) return 'not valid JSON'
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'the key file named is missing'
  return message.split('\n')[0].slice(0, 120)
}

function hooksOf(fake: FakePush): NotifyE2eHooks {
  return {
    sent: () =>
      fake.transport.sent.map((s) => ({
        at: s.at,
        deviceId: s.target.deviceId,
        platform: s.target.platform,
        payload: s.payload,
        outcome: s.result.outcome
      })),
    targets: {
      add: (target) => fake.targets.add(target),
      remove: (deviceId) => fake.targets.remove(deviceId),
      list: () => fake.targets.snapshot(),
      forgotten: () => [...fake.targets.forgotten]
    },
    answer: (outcome) => {
      fake.transport.answer =
        outcome === 'failed'
          ? () => ({ outcome: 'failed', reason: 'the fake was told to fail' })
          : () => ({ outcome })
    }
  }
}

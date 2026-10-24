import { describe, expect, it } from 'vitest'
import { Either, Schema } from 'effect'
import { ClaveApi } from './api'
import { CapabilityUnavailable } from './errors'
import {
  PluginRecord,
  PluginRefused,
  PluginSecretRequest,
  PluginViewLease,
  RefusedOrUnavailable,
  ReportPluginContext
} from './plugins'

const decodeRecord = Schema.decodeUnknownSync(PluginRecord)
const encodeRecord = Schema.encodeSync(PluginRecord)

const bare = {
  id: 'clave.hello',
  version: '1.0.0',
  source: 'bundled',
  enabled: false,
  permissionsGranted: [],
  installedAt: '2026-10-12T10:00:00.000Z',
  directory: '/plugins/clave.hello',
  status: 'disabled',
  panels: [],
  commands: [],
  toolbar: [],
  generation: 0
} as const

const full = {
  ...bare,
  source: 'link',
  enabled: true,
  enabledBeforeEngineRefusal: true,
  permissionsGranted: ['sessions.read', 'net'],
  contentDigest: 'sha256-a',
  reviewDigest: 'sha256-b',
  declaredPermissions: ['sessions.read', 'net', 'shell'],
  needsReview: 'permission-growth',
  manifest: { id: 'clave.hello', name: 'Hello', contributes: { panels: [{ id: 'main' }] } },
  error: 'main threw at activation',
  status: 'error',
  panels: ['main'],
  commands: ['hello.say'],
  toolbar: ['hello.say'],
  generation: 3,
  lastNotification: { title: 'Done', body: 'The build finished.' }
} as const

describe('PluginRecord', () => {
  it('round-trips with every optional field present', () => {
    const decoded = decodeRecord(full)
    expect(decoded).toEqual(full)
    expect(decodeRecord(encodeRecord(decoded))).toEqual(full)
  })
  it('round-trips with no optional field', () => {
    const decoded = decodeRecord(bare)
    expect(decoded).toEqual(bare)
    expect(Object.keys(encodeRecord(decoded)).sort()).toEqual(Object.keys(bare).sort())
  })
  it('drops a field the schema does not name', () => {
    const decoded = decodeRecord({ ...bare, secretToken: 'leak' })
    expect('secretToken' in decoded).toBe(false)
    expect(decoded).toEqual(bare)
  })
  it('refuses a status the host does not have', () => {
    const decoded = Schema.decodeUnknownEither(PluginRecord)({ ...bare, status: 'paused' })
    expect(Either.isLeft(decoded)).toBe(true)
  })
  it('refuses a permission the SDK does not declare', () => {
    const decoded = Schema.decodeUnknownEither(PluginRecord)({
      ...bare,
      permissionsGranted: ['root']
    })
    expect(Either.isLeft(decoded)).toBe(true)
  })
})

describe('PluginViewLease and PluginSecretRequest', () => {
  it('round-trip a lease', () => {
    const lease = {
      leaseId: 'l1',
      sessionId: 's1',
      file: '/p/view.html',
      csp: "default-src 'self'"
    }
    const decoded = Schema.decodeUnknownSync(PluginViewLease)(lease)
    expect(Schema.encodeSync(PluginViewLease)(decoded)).toEqual(lease)
  })
  it('round-trip a secret request, with and without a description', () => {
    const decode = Schema.decodeUnknownSync(PluginSecretRequest)
    const encode = Schema.encodeSync(PluginSecretRequest)
    const withText = { id: 'q1', pluginId: 'p', title: 'API key', description: 'For the feed.' }
    const without = { id: 'q2', pluginId: 'p', title: 'API key' }
    expect(encode(decode(withText))).toEqual(withText)
    expect(encode(decode(without))).toEqual(without)
  })
})

describe('RefusedOrUnavailable', () => {
  const decode = Schema.decodeUnknownSync(RefusedOrUnavailable)
  it('decodes a refusal as PluginRefused, its sentence as the message', () => {
    const error = decode({ _tag: 'PluginRefused', message: 'That plugin is not installed.' })
    expect(error).toBeInstanceOf(PluginRefused)
    expect(error.message).toBe('That plugin is not installed.')
  })
  it('decodes a missing capability as CapabilityUnavailable', () => {
    const error = decode({
      _tag: 'CapabilityUnavailable',
      capability: 'plugins',
      message: 'This server runs no plugins.'
    })
    expect(error).toBeInstanceOf(CapabilityUnavailable)
  })
})

describe('ReportPluginContext', () => {
  it('takes a window with no active session', () => {
    expect(
      Schema.decodeUnknownSync(ReportPluginContext.payload)({ windowKey: 'w1', sessionId: null })
    ).toEqual({ windowKey: 'w1', sessionId: null })
  })
})

describe('the plugins group', () => {
  it('carries its thirteen endpoints on ClaveApi', () => {
    const group = ClaveApi.groups.plugins
    expect(group).toBeDefined()
    const routes = Object.values(group.endpoints).map((e) => [e.name, e.method, e.path])
    expect(routes.sort()).toEqual(
      [
        ['list', 'GET', '/plugins'],
        ['panel', 'GET', '/plugins/panel'],
        ['secrets', 'GET', '/plugins/secrets'],
        ['enable', 'POST', '/plugins/enable'],
        ['disable', 'POST', '/plugins/disable'],
        ['link', 'POST', '/plugins/link'],
        ['remove', 'POST', '/plugins/remove'],
        ['command', 'POST', '/plugins/command'],
        ['context', 'POST', '/plugins/context'],
        ['leaseView', 'POST', '/plugins/views/lease'],
        ['requestView', 'POST', '/plugins/views/request'],
        ['revokeView', 'POST', '/plugins/views/revoke'],
        ['replySecret', 'POST', '/plugins/secrets/reply']
      ].sort()
    )
  })
})

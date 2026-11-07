import { beforeEach, expect, it, vi } from 'vitest'
import { MemoryKeyValueStore } from '../chat/drafts'
import { MemorySecureStore, SecureCredentialStore } from '../machines/credentials'
import { EnrollmentRecords } from '../enroll/records'
import type { IncomingResponse } from '../notifications/port'

const native = vi.hoisted(() => ({
  owner: {} as {
    namespace: string
    kv: MemoryKeyValueStore
    credentials: SecureCredentialStore
    assertCurrentAccount: () => void
  },
  state: { currentState: 'background' },
  post: vi.fn(async (request: unknown) => {
    void request
    return 'fallback-notification'
  }),
  categories: vi.fn(),
  task: vi.fn()
}))
vi.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  AndroidImportance: { HIGH: 4 },
  scheduleNotificationAsync: native.post,
  setNotificationChannelAsync: vi.fn(),
  setNotificationCategoryAsync: native.categories,
  registerTaskAsync: vi.fn()
}))
vi.mock('expo-task-manager', () => ({ defineTask: native.task }))
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: native.state }))
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  digestStringAsync: async () => 'fallback-id'
}))
vi.mock('./account', () => ({
  nativeAccount: () => ({ restore: async () => {}, status: () => ({ account: { subject: 'A' } }) }),
  nativeOwnerStores: async () => native.owner
}))
import {
  configureNativeNotifications,
  nativeNotificationResponse,
  ownerNotificationResponse
} from './notifications'

const response = (actionIdentifier = 'clave.allow'): IncomingResponse => ({
  actionIdentifier,
  notification: {
    date: 1,
    request: {
      identifier: 'original-notification',
      content: {
        title: 'Fixture',
        body: 'Fixture',
        data: {
          category: 'permission',
          serverId: 'server',
          serverName: 'Fixture',
          sessionId: 'session',
          sessionTitle: 'Chat',
          requestId: 'request',
          text: 'DO-NOT-PUBLISH',
          actions: ['allow', 'deny'],
          access_token: 'DO-NOT-PUBLISH'
        }
      }
    }
  }
})

beforeEach(async () => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  native.post.mockResolvedValue('fallback-notification')
  native.state.currentState = 'background'
  native.owner = {
    namespace: 'owner-A',
    kv: new MemoryKeyValueStore(),
    credentials: new SecureCredentialStore(new MemorySecureStore()),
    assertCurrentAccount: () => {}
  }
  await native.owner.credentials.set('machine', {
    serverUrl: 'http://127.0.0.1:43202',
    bearer: 'fixture-credential'
  })
  await new EnrollmentRecords(native.owner.kv).set({
    machineId: 'machine',
    serverId: 'server',
    deviceId: 'phone',
    serverName: 'Fixture',
    pairedAt: 1
  })
  vi.stubGlobal('__DEV__', true)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline fixture')
    })
  )
})

it('posts a sanitized Android fallback when a background action cannot settle', async () => {
  expect(await nativeNotificationResponse(response())).toEqual({
    kind: 'requests',
    machineId: 'machine',
    requestId: 'request'
  })
  expect(native.post).toHaveBeenCalledOnce()
  expect(native.post.mock.calls[0]?.[0]).toMatchObject({
    content: { title: 'Open Clave to answer' },
    trigger: null
  })
  expect(JSON.stringify(native.post.mock.calls)).not.toContain('DO-NOT-PUBLISH')
  expect(JSON.stringify(native.post.mock.calls)).not.toContain('fixture-credential')
})

function fallbackTap(): IncomingResponse {
  const posted = native.post.mock.calls[0]![0] as {
    identifier: string
    content: IncomingResponse['notification']['request']['content']
  }
  return {
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    notification: { date: 2, request: { identifier: posted.identifier, content: posted.content } }
  }
}
const owner = (): Parameters<typeof ownerNotificationResponse>[1] => ({
  ...native.owner,
  machines: new EnrollmentRecords(native.owner.kv),
  build: 'development'
})

it('binds the fallback tap to its exact notification and owner, then reads current requests', async () => {
  await nativeNotificationResponse(response())
  const tap = fallbackTap()
  const fetcher = vi.fn(async () =>
    Response.json({
      revision: 1,
      pending: [
        {
          id: 'request',
          sessionId: 'session',
          kind: 'permission',
          description: 'Fixture',
          createdAt: 1,
          options: []
        }
      ]
    })
  )
  vi.stubGlobal('fetch', fetcher)
  expect(
    await ownerNotificationResponse(tap, { ...owner(), kv: new MemoryKeyValueStore() })
  ).toBeNull()
  expect(
    await ownerNotificationResponse(
      {
        ...tap,
        notification: {
          ...tap.notification,
          request: { ...tap.notification.request, identifier: 'other-notification' }
        }
      },
      owner()
    )
  ).toBeNull()
  expect(fetcher).not.toHaveBeenCalled()
  expect(await ownerNotificationResponse(tap, owner())).toEqual({
    kind: 'requests',
    machineId: 'machine',
    requestId: 'request'
  })
  expect(fetcher).toHaveBeenCalledOnce()
})

it('does not open a form for a request settled after the fallback was posted', async () => {
  await nativeNotificationResponse(response())
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ revision: 2, pending: [] }))
  )
  expect(await ownerNotificationResponse(fallbackTap(), owner())).toBeNull()
})

it('keeps the cold-resume link and surfaces a posting failure', async () => {
  native.post.mockRejectedValueOnce(new Error('Posting failed'))
  await expect(nativeNotificationResponse(response())).rejects.toThrow('Posting failed')
  expect(await native.owner.kv.getItem('clave.pending-notification')).toBe(
    JSON.stringify({ kind: 'requests', machineId: 'machine', requestId: 'request' })
  )
})

it('does not post when a simple answer settled, the app is foregrounded, or the user tapped the notification', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('/requests/resolve')
        ? Response.json({ accepted: true })
        : Response.json({
            revision: 1,
            pending: [
              {
                id: 'request',
                sessionId: 'session',
                kind: 'permission',
                description: 'Fixture',
                createdAt: 1,
                options: [
                  { id: 'allow-once', label: 'Allow' },
                  { id: 'deny', label: 'Deny' }
                ]
              }
            ]
          })
    )
  )
  expect(await nativeNotificationResponse(response())).toBeNull()
  expect(native.post).not.toHaveBeenCalled()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline')
    })
  )
  native.state.currentState = 'active'
  await nativeNotificationResponse(response())
  native.state.currentState = 'background'
  await nativeNotificationResponse(response('expo.modules.notifications.actions.DEFAULT'))
  expect(native.post).not.toHaveBeenCalled()
})

it('registers a foreground Activity action for the fallback while simple Android answers stay headless', async () => {
  await configureNativeNotifications()
  expect(native.categories).toHaveBeenCalledWith('clave.open-request', [
    expect.objectContaining({ options: expect.objectContaining({ opensAppToForeground: true }) })
  ])
  expect(native.categories).toHaveBeenCalledWith(
    'clave.permission',
    expect.arrayContaining([
      expect.objectContaining({
        identifier: 'clave.allow',
        options: expect.objectContaining({ opensAppToForeground: false })
      })
    ])
  )
})

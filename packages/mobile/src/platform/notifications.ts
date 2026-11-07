import * as Notifications from 'expo-notifications'
import * as TaskManager from 'expo-task-manager'
import * as Crypto from 'expo-crypto'
import { AppState, Platform } from 'react-native'
import { ClaveServerClient } from '../api/client'
import { EnrollmentRecords } from '../enroll/records'
import { categoryDeclarations } from '../notifications/categories'
import { handleResponse } from '../notifications/handler'
import type { IncomingResponse } from '../notifications/port'
import type { DeepLink } from '../notifications/deeplink'
import { nativeAccount, nativeOwnerStores } from './account'
import { PENDING_NOTIFICATION_KEY, pendingLink } from '../notifications/inbox'
import { parsePayload } from '../notifications/payload'
import type { KeyValueStore } from '../chat/drafts'
import type { CredentialStore } from '../machines/types'
import type { MachineResolver } from '../notifications/deeplink'
import type { BuildKind } from '../machines/transport-policy'

const TASK = 'clave.notification-response'
export const FALLBACK_CATEGORY = 'clave.open-request'
const FALLBACK_PREFIX = 'clave-fallback-'
const fallbackKey = (id: string): string => `${PENDING_NOTIFICATION_KEY}.${id}`

export async function ownerNotificationResponse(
  response: IncomingResponse,
  owner: {
    kv: KeyValueStore
    credentials: CredentialStore
    machines: MachineResolver
    build: BuildKind
  }
): Promise<DeepLink | null> {
  const data = response.notification.request.content.data as { claveFallbackId?: unknown } | null
  if (data && typeof data.claveFallbackId === 'string') {
    const id = data.claveFallbackId
    if (!id.startsWith(FALLBACK_PREFIX) || id !== response.notification.request.identifier)
      return null
    // Only the owner's immutable store holds the route. A notification from
    // another account has no row here and cannot select that owner's credential.
    const raw = await owner.kv.getItem(fallbackKey(id))
    if (!raw) return null
    const saved = JSON.parse(raw) as { serverId?: unknown; link?: unknown }
    const link = pendingLink(JSON.stringify(saved.link))
    if (!link || typeof saved.serverId !== 'string') return null
    if (link.kind === 'requests') {
      const machine = await owner.machines.byServerId(saved.serverId)
      if (machine?.machineId !== link.machineId) return null
      const credential = await owner.credentials.get(machine.machineId)
      if (!credential) return { kind: 'machines', reason: 'Pair this phone again.' }
      const current = await new ClaveServerClient(credential, {
        build: owner.build
      }).requests.list()
      if (!current.pending.some((request) => request.id === link.requestId)) {
        await owner.kv.removeItem(fallbackKey(id))
        return null
      }
    }
    return link
  }
  const result = await handleResponse(response, {
    machines: owner.machines,
    credentials: owner.credentials,
    client: (credential) => new ClaveServerClient(credential, { build: owner.build })
  })
  return result.link ?? null
}

export async function nativeNotificationResponse(
  response: IncomingResponse
): Promise<DeepLink | null> {
  const auth = nativeAccount()
  await auth.restore()
  if (!auth.status().account) return null
  const owner = await nativeOwnerStores(auth)
  owner.assertCurrentAccount()
  const link = await ownerNotificationResponse(response, {
    kv: owner.kv,
    machines: new EnrollmentRecords(owner.kv),
    credentials: owner.credentials,
    build: __DEV__ ? 'development' : 'release'
  })
  if (link) {
    owner.assertCurrentAccount()
    await owner.kv.setItem(PENDING_NOTIFICATION_KEY, JSON.stringify(link))
    if (
      Platform.OS === 'android' &&
      AppState.currentState !== 'active' &&
      response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER
    ) {
      const payload = parsePayload(response.notification.request.content.data)
      if (payload) {
        const id =
          FALLBACK_PREFIX +
          (await Crypto.digestStringAsync(
            Crypto.CryptoDigestAlgorithm.SHA256,
            JSON.stringify([
              owner.namespace,
              response.notification.request.identifier,
              response.actionIdentifier
            ])
          ))
        owner.assertCurrentAccount()
        await owner.kv.setItem(
          fallbackKey(id),
          JSON.stringify({ serverId: payload.serverId, link })
        )
        owner.assertCurrentAccount()
        // Expo creates an Activity PendingIntent for this tap. Android 12+
        // forbids launching an Activity from the headless action receiver.
        // Posting errors propagate; the owner-scoped cold-resume link remains.
        await Notifications.scheduleNotificationAsync({
          identifier: id,
          content: {
            title: 'Open Clave to answer',
            body: 'This action needs the app. Tap to open Clave.',
            categoryIdentifier: FALLBACK_CATEGORY,
            data: { claveFallbackId: id }
          },
          trigger: null
        })
      }
    }
  }
  return link
}

// Android can run action responses in a headless task. The SDK cannot deliver
// killed-app iOS action responses to that task, so iOS actions foreground the app.
TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data, error }) => {
  if (!error && data && 'actionIdentifier' in data) await nativeNotificationResponse(data)
})

export async function configureNativeNotifications(): Promise<void> {
  if (Platform.OS === 'android')
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Agent updates',
      importance: Notifications.AndroidImportance.HIGH
    })
  for (const category of categoryDeclarations()) {
    await Notifications.setNotificationCategoryAsync(
      category.identifier,
      category.actions.map((action) => ({
        ...action,
        options: { ...action.options, opensAppToForeground: Platform.OS === 'ios' }
      }))
    )
  }
  await Notifications.setNotificationCategoryAsync(FALLBACK_CATEGORY, [
    {
      identifier: 'clave.open-request',
      buttonTitle: 'Open Clave',
      options: { opensAppToForeground: true, isAuthenticationRequired: true }
    }
  ])
  await Notifications.registerTaskAsync(TASK)
}

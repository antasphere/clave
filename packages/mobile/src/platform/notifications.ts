import * as Notifications from 'expo-notifications'
import * as TaskManager from 'expo-task-manager'
import { Platform } from 'react-native'
import { ClaveServerClient } from '../api/client'
import { EnrollmentRecords } from '../enroll/records'
import { categoryDeclarations } from '../notifications/categories'
import { handleResponse } from '../notifications/handler'
import type { IncomingResponse } from '../notifications/port'
import type { DeepLink } from '../notifications/deeplink'
import { nativeAccount, nativeOwnerStores } from './account'
import { PENDING_NOTIFICATION_KEY } from '../notifications/inbox'
import type { KeyValueStore } from '../chat/drafts'
import type { CredentialStore } from '../machines/types'
import type { MachineResolver } from '../notifications/deeplink'
import type { BuildKind } from '../machines/transport-policy'

const TASK = 'clave.notification-response'

export async function ownerNotificationResponse(
  response: IncomingResponse,
  owner: {
    kv: KeyValueStore
    credentials: CredentialStore
    machines: MachineResolver
    build: BuildKind
  }
): Promise<DeepLink | null> {
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
  const link = await ownerNotificationResponse(response, {
    kv: owner.kv,
    machines: new EnrollmentRecords(owner.kv),
    credentials: owner.credentials,
    build: __DEV__ ? 'development' : 'release'
  })
  if (link) await owner.kv.setItem(PENDING_NOTIFICATION_KEY, JSON.stringify(link))
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
  await Notifications.registerTaskAsync(TASK)
}

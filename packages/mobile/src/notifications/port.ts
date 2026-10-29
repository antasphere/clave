/**
 * The subset of expo-notifications the phone uses, as an interface the
 * wiring implements over the real module (expo-notifications 58.1.7, the
 * SDK 58 line) and the tests over a stub. The shapes mirror the module's
 * own types (`Notifications.types.d.ts`, `Tokens.types.d.ts`) so the wiring
 * is a pass-through: a response carries the notification with its content
 * (`data` is where a push's custom payload lands, under the key the
 * platform chooses, `payload.ts` reads both), the action the person took
 * (`DEFAULT_ACTION_IDENTIFIER` for a plain tap) and the text typed into a
 * reply field.
 */
export const DEFAULT_ACTION_IDENTIFIER = 'expo.modules.notifications.actions.DEFAULT'

/** `getDevicePushTokenAsync`: the raw APNs or FCM token, `type` the platform. */
export interface DevicePushToken {
  readonly type: string
  readonly data: unknown
}

export interface NotificationActionSpec {
  readonly identifier: string
  readonly buttonTitle: string
  readonly textInput?: {
    readonly submitButtonTitle: string
    readonly placeholder: string
  }
  readonly options?: {
    readonly isDestructive?: boolean
    readonly isAuthenticationRequired?: boolean
    readonly opensAppToForeground?: boolean
  }
}

export interface NotificationCategorySpec {
  readonly identifier: string
  readonly actions: readonly NotificationActionSpec[]
}

export interface IncomingContent {
  readonly title: string | null
  readonly body: string | null
  readonly data: unknown
  readonly categoryIdentifier?: string | null
}

export interface IncomingNotification {
  readonly date: number
  readonly request: {
    readonly identifier: string
    readonly content: IncomingContent
  }
}

export interface IncomingResponse {
  readonly notification: IncomingNotification
  readonly actionIdentifier: string
  readonly userText?: string
}

export interface NotificationSubscription {
  remove(): void
}

export interface NotificationsPort {
  getDevicePushTokenAsync(): Promise<DevicePushToken>
  setNotificationCategoryAsync(
    identifier: string,
    actions: readonly NotificationActionSpec[]
  ): Promise<unknown>
  addNotificationResponseReceivedListener(
    listener: (response: IncomingResponse) => void
  ): NotificationSubscription
  /** The tap that launched the app cold, once; null when the launch was the person's. */
  getLastNotificationResponseAsync(): Promise<IncomingResponse | null>
  requestPermissionsAsync(): Promise<{ readonly granted: boolean }>
  getPermissionsAsync(): Promise<{ readonly granted: boolean }>
}

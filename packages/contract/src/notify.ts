/**
 * The notify domain (the mobile wave, lane B; decision 9 of the spec
 * `knowledge/specs/2026-10-29-mobile-app.md` on clave-os): what the server
 * sends to a paired phone when an agent needs the person, and the two
 * owner's routes that say whether it can send at all.
 *
 * The server sends one notification per event of these categories, to every
 * push target it holds: `question` (a new pending request of kind
 * clarification, or a permission_request frame carrying questions),
 * `permission` (a new pending request of kind permission, or a
 * permission_request frame), `secret` (a pending request of kind secret),
 * `finished` (a session's state reaching done), `failed` (a fatal error
 * frame, or a process ending with a code other than 0 that no stop or
 * restart asked for) and `account_limit` (a usage read whose tightest window
 * has about five percent left, once per account and window). `test` is the
 * one category nothing in the server's flow produces: it is what
 * `POST /notify/test` sends, so a teammate can tell a delivered test push
 * from a real one.
 *
 * The payload carries the machine's name, the session's title and its
 * workspace, the question's text or the request's description, the request
 * id and the session id so a tap opens the conversation, and the actions the
 * phone may offer. Never a secret value, never a token, never a path to a
 * credential, never the answer of a question: `payload.test.ts` in the
 * server package asserts every category against a list of forbidden fields.
 * The keys are closed (`NOTIFICATION_PAYLOAD_KEYS`): a transport serialises
 * exactly these and nothing else.
 *
 * `sessionId` and `sessionTitle` are empty strings on an `account_limit`,
 * which is about an account and not a conversation; `requestId` is the id
 * the phone resolves the request with ON THAT SERVER: the pending request's
 * id where the server has a requests service (`POST /requests/resolve`), the
 * stream frame's id in-process (`POST /sessions/write`, a permission_response).
 */
import { Schema } from 'effect'
import { Command, Query } from '@structure-ai/cqrs'
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import { CapabilityUnavailable } from './errors'

export const NotificationCategory = Schema.Literal(
  'question',
  'permission',
  'secret',
  'finished',
  'failed',
  'account_limit',
  'test'
)
export type NotificationCategory = typeof NotificationCategory.Type

/** What the phone may offer on the notification itself: allow and deny on a
 *  permission, a reply field on a free-text question, open everywhere. */
export const NotificationAction = Schema.Literal('allow', 'deny', 'reply', 'open')
export type NotificationAction = typeof NotificationAction.Type

export const NotificationPayload = Schema.Struct({
  category: NotificationCategory,
  serverId: Schema.String,
  /** The machine's name as the server knows it (its hostname). */
  serverName: Schema.String,
  sessionId: Schema.String,
  sessionTitle: Schema.String,
  workspaceName: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  /** The question's text, the permission's description, the secret request's
   *  description (what is asked, never a value), the session's title with
   *  "finished" or "failed", the account's label with its window. */
  text: Schema.String,
  actions: Schema.Array(NotificationAction)
})
export type NotificationPayload = typeof NotificationPayload.Type

/** The closed list of keys a payload may carry, in the order a transport
 *  writes them. A key not here never reaches a phone. */
export const NOTIFICATION_PAYLOAD_KEYS = [
  'category',
  'serverId',
  'serverName',
  'sessionId',
  'sessionTitle',
  'workspaceName',
  'requestId',
  'text',
  'actions'
] as const

/** The action category a phone registers its buttons under, per category:
 *  `clave.permission` carries allow and deny, `clave.question` the reply
 *  field. iOS reads it as `aps.category`; Android (expo-notifications)
 *  reads it as `categoryId` in the data map, so a data-only transport
 *  carries it beside the payload's keys (`NOTIFICATION_DATA_KEYS`). */
export const notificationCategoryId = (category: NotificationCategory): string =>
  `clave.${category}`

/** The closed keys of a data-only transport's map (FCM's `data`): the
 *  payload's keys, each as a string, plus the action category. */
export const NOTIFICATION_DATA_KEYS = [...NOTIFICATION_PAYLOAD_KEYS, 'categoryId'] as const

export const PushPlatform = Schema.Literal('ios', 'android')
export type PushPlatform = typeof PushPlatform.Type

/** What the owner reads: which transports are configured, whether the
 *  recording fake stands in for them, how many push targets the server holds,
 *  and the name it signs its notifications with. */
export const NotifyStatus = Schema.Struct({
  transports: Schema.Struct({ ios: Schema.Boolean, android: Schema.Boolean }),
  fake: Schema.Boolean,
  targets: Schema.Number,
  serverName: Schema.String
})
export type NotifyStatus = typeof NotifyStatus.Type

/** What one send answered: delivered to the platform, the token gone (the
 *  phone's record forgets it), or failed with the reason (never a token). */
export const SendResultView = Schema.Union(
  Schema.Struct({ outcome: Schema.Literal('sent') }),
  Schema.Struct({ outcome: Schema.Literal('gone') }),
  Schema.Struct({ outcome: Schema.Literal('failed'), reason: Schema.String })
)
export type SendResultView = typeof SendResultView.Type

/** No push target carries that device id on this server. */
export class PushTargetNotFound extends Schema.TaggedError<PushTargetNotFound>()(
  'PushTargetNotFound',
  { deviceId: Schema.String }
) {}

/** `GET /notify/status`, the owner's: what this server can send with. */
export const GetNotifyStatus = Query.define('GetNotifyStatus', {
  payload: Schema.Struct({}),
  success: NotifyStatus,
  failure: CapabilityUnavailable
})

/** `POST /notify/test`, the owner's: one test notification to one paired
 *  phone, answered with what the platform said. */
export const SendTestNotification = Command.define('SendTestNotification', {
  payload: Schema.Struct({
    deviceId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256))
  }),
  success: Schema.Struct({
    deviceId: Schema.String,
    platform: PushPlatform,
    result: SendResultView
  }),
  failure: Schema.Union(PushTargetNotFound, CapabilityUnavailable)
})

export const notifyGroup = ApiGroup.make('notify')
  .add(HttpCqrs.queryEndpoint('status', '/notify/status', GetNotifyStatus))
  .add(HttpCqrs.commandEndpoint('test', '/notify/test', SendTestNotification))

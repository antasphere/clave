/**
 * What a notification says, per category (the mobile wave, lane B). Every
 * payload a phone receives is built here and nowhere else, from the fields
 * named below and from nothing else: not the request's input, not a
 * question's answers, not a secret request's action, not an error's message.
 * `payload.test.ts` holds every category against a list of forbidden fields.
 *
 * The texts are the lane's decision (recorded on its workstream): a question
 * is its first question and how many more; a permission and a secret are
 * their description, what is asked; a session finished or failed is its
 * title with the word; an account limit is the account's label with its
 * window and what is left. Each text is bounded, since a platform refuses a
 * payload past 4 KiB.
 */
import {
  NOTIFICATION_PAYLOAD_KEYS,
  notificationCategoryId,
  type NotificationAction,
  type NotificationPayload
} from '@clave/contract/notify'

/** The session the notification is about, as the dispatcher knows it. */
export interface NotificationSubject {
  readonly serverId: string
  readonly serverName: string
  readonly sessionId: string
  readonly sessionTitle: string
  readonly workspaceName?: string
}

/** A text longer than this is cut, with an ellipsis: a platform's payload
 *  limit is 4 KiB, and a notification is read on a lock screen. */
export const TEXT_MAX = 500
export const TITLE_MAX = 120

const ALLOW_OPTION = /^(allow|allow-once|allow-always|approve|accept|yes|ok)$/i
const DENY_OPTION = /^(deny|decline|reject|cancel|no)$/i

export const bounded = (text: string, max = TEXT_MAX): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Allow and deny when the options carry one of each; open always. */
export function permissionActions(
  options: ReadonlyArray<{ readonly id: string }>
): NotificationAction[] {
  const allow = options.some((o) => ALLOW_OPTION.test(o.id))
  const deny = options.some((o) => DENY_OPTION.test(o.id))
  return allow && deny ? ['allow', 'deny', 'open'] : ['open']
}

/** A reply field on one free-text question (no options to choose from);
 *  open otherwise: a choice or several questions are made in the app. */
export function questionActions(
  questions: ReadonlyArray<{ readonly options: ReadonlyArray<unknown> }>
): NotificationAction[] {
  return questions.length === 1 && questions[0].options.length === 0 ? ['reply', 'open'] : ['open']
}

export function questionText(questions: ReadonlyArray<{ readonly question: string }>): string {
  const first = questions[0]?.question ?? ''
  const more = questions.length - 1
  return bounded(more > 0 ? `${first} (and ${more} more)` : first)
}

const subjectFields = (
  subject: NotificationSubject
): Pick<
  NotificationPayload,
  'serverId' | 'serverName' | 'sessionId' | 'sessionTitle' | 'workspaceName'
> => ({
  serverId: subject.serverId,
  serverName: bounded(subject.serverName, TITLE_MAX),
  sessionId: subject.sessionId,
  sessionTitle: bounded(subject.sessionTitle, TITLE_MAX),
  ...(subject.workspaceName !== undefined && {
    workspaceName: bounded(subject.workspaceName, TITLE_MAX)
  })
})

export function questionPayload(
  subject: NotificationSubject,
  requestId: string,
  questions: ReadonlyArray<{ readonly question: string; readonly options: ReadonlyArray<unknown> }>
): NotificationPayload {
  return {
    category: 'question',
    ...subjectFields(subject),
    requestId,
    text: questionText(questions),
    actions: questionActions(questions)
  }
}

export function permissionPayload(
  subject: NotificationSubject,
  requestId: string,
  description: string,
  options: ReadonlyArray<{ readonly id: string }>,
  toolName?: string
): NotificationPayload {
  return {
    category: 'permission',
    ...subjectFields(subject),
    requestId,
    text: bounded(description.trim() || toolName || 'Permission requested'),
    actions: permissionActions(options)
  }
}

export function secretPayload(
  subject: NotificationSubject,
  requestId: string,
  description: string
): NotificationPayload {
  return {
    category: 'secret',
    ...subjectFields(subject),
    requestId,
    text: bounded(description.trim() || 'A secret is requested'),
    actions: ['open']
  }
}

export function finishedPayload(subject: NotificationSubject): NotificationPayload {
  return {
    category: 'finished',
    ...subjectFields(subject),
    text: bounded(`${subject.sessionTitle} finished`),
    actions: ['open']
  }
}

export function failedPayload(subject: NotificationSubject): NotificationPayload {
  return {
    category: 'failed',
    ...subjectFields(subject),
    text: bounded(`${subject.sessionTitle} failed`),
    actions: ['open']
  }
}

/** About an account, not a conversation: the session fields are empty. */
export function accountLimitPayload(
  server: { readonly serverId: string; readonly serverName: string },
  label: string,
  windowLabel: string,
  leftPercent: number
): NotificationPayload {
  return {
    category: 'account_limit',
    serverId: server.serverId,
    serverName: bounded(server.serverName, TITLE_MAX),
    sessionId: '',
    sessionTitle: '',
    text: bounded(`${label}: ${windowLabel} has ${leftPercent}% left`),
    actions: ['open']
  }
}

export function testPayload(
  server: { readonly serverId: string; readonly serverName: string },
  deviceId: string
): NotificationPayload {
  return {
    category: 'test',
    serverId: server.serverId,
    serverName: bounded(server.serverName, TITLE_MAX),
    sessionId: '',
    sessionTitle: '',
    text: bounded(`Test notification from ${server.serverName} to ${deviceId}`),
    actions: ['open']
  }
}

/** The payload with exactly the contract's keys, in the contract's order:
 *  what a transport serialises. A key the contract does not name never
 *  reaches a phone, whatever a builder was handed. */
export function closedPayload(payload: NotificationPayload): NotificationPayload {
  const out: Record<string, unknown> = {}
  for (const key of NOTIFICATION_PAYLOAD_KEYS) {
    const value = (payload as Record<string, unknown>)[key]
    if (value !== undefined) out[key] = value
  }
  return out as unknown as NotificationPayload
}

/** The action category both platforms register the buttons under, one
 *  value: `aps.category` on iOS, `categoryId` in the data map on Android. */
export const categoryIdOf = (payload: NotificationPayload): string =>
  notificationCategoryId(payload.category)

/** The payload's fields as strings, for FCM's `data` (strings only): the
 *  actions joined by a comma, an absent field left out, and `categoryId`,
 *  which the Android client reads the action buttons from (lane D's finding
 *  of 29 October: expo-notifications shows them from that key alone). The
 *  keys are the contract's `NOTIFICATION_DATA_KEYS`. */
export function payloadAsStrings(payload: NotificationPayload): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of NOTIFICATION_PAYLOAD_KEYS) {
    const value = (payload as Record<string, unknown>)[key]
    if (value === undefined) continue
    out[key] = Array.isArray(value) ? value.join(',') : String(value)
  }
  out.categoryId = categoryIdOf(payload)
  return out
}

/** The title a lock screen shows above the text: the session's title, the
 *  machine's name on a notification about an account or a test. */
export function payloadTitle(payload: NotificationPayload): string {
  return payload.sessionTitle || payload.serverName
}

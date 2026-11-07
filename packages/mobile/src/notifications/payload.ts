/**
 * Lane B's payload, as the phone reads it (decision 9 of the spec; the
 * shape verbatim from `packages/contract/src/notify.ts` on lane B's branch,
 * `NotificationPayload`): the category, the machine, the session, the text
 * and the actions the phone may offer. Never a secret, never a token: the
 * server's own test holds every category to that.
 *
 * Where it lands on the phone differs by platform, and this file reads
 * both. On iOS the APNs body carries it under a top-level `clave` key beside
 * `aps`, and expo-notifications hands the whole user info as the content's
 * `data`. On Android the FCM message carries every field as a string in its
 * `data` map (the actions joined by commas) and the content's `data` is that
 * map; `categoryId` beside them is what makes the action buttons appear
 * there (lane B adds it on the wave's finding of 29 October). A JSON string
 * in either place is read too.
 */
export const CATEGORIES = [
  'question',
  'permission',
  'secret',
  'finished',
  'failed',
  'account_limit',
  'test'
] as const
export type NotificationCategory = (typeof CATEGORIES)[number]

export const ACTIONS = ['allow', 'deny', 'reply', 'open'] as const
export type NotificationAction = (typeof ACTIONS)[number]

export interface NotificationPayload {
  readonly category: NotificationCategory
  readonly serverId: string
  readonly serverName: string
  readonly sessionId: string
  readonly sessionTitle: string
  readonly workspaceName?: string
  readonly requestId?: string
  readonly text: string
  readonly actions: readonly NotificationAction[]
}

/** The key the APNs body carries the payload under, beside `aps`. */
export const APNS_KEY = 'clave'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isCategory = (value: unknown): value is NotificationCategory =>
  typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)

const isAction = (value: unknown): value is NotificationAction =>
  typeof value === 'string' && (ACTIONS as readonly string[]).includes(value)

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

function actionsOf(value: unknown): NotificationAction[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',').map((a) => a.trim())
      : []
  const actions = raw.filter(isAction)
  return actions.length ? [...new Set(actions)] : ['open']
}

/** The payload in a push's `data`, whichever platform delivered it; null
 *  when nothing readable is there (a push that is not Clave's). */
export function parsePayload(data: unknown, depth = 0): NotificationPayload | null {
  if (depth > 3) return null
  if (typeof data === 'string') {
    try {
      return parsePayload(JSON.parse(data), depth + 1)
    } catch {
      return null
    }
  }
  if (!isRecord(data)) return null
  if (data[APNS_KEY] !== undefined) return parsePayload(data[APNS_KEY], depth + 1)
  if (!isCategory(data.category)) return null
  const serverId = text(data.serverId)
  if (!serverId) return null
  const workspaceName = text(data.workspaceName)
  const requestId = text(data.requestId)
  return {
    category: data.category,
    serverId,
    serverName: text(data.serverName),
    sessionId: text(data.sessionId),
    sessionTitle: text(data.sessionTitle),
    ...(workspaceName ? { workspaceName } : {}),
    ...(requestId ? { requestId } : {}),
    text: text(data.text),
    actions: actionsOf(data.actions)
  }
}

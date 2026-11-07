/**
 * The notification categories the phone declares to the platform and the
 * actions each carries (decision 9 of the spec): allow and deny on a
 * permission, a reply field on a question, a plain tap everywhere. The
 * identifiers are the ones the server names, `clave.<category>` (lane B's
 * `aps.category` on iOS, `categoryId` in the FCM data on Android), so a
 * push lands on its buttons without the phone touching it.
 *
 * Allow and reply answer in the background and need the phone unlocked:
 * an agent's permission or a typed answer is the person's word, not a
 * pocket's. Deny needs nothing: refusing is safe from the lock screen.
 */
import type { NotificationCategorySpec, NotificationsPort } from './port'
import { CATEGORIES, type NotificationCategory } from './payload'

export const CATEGORY_PREFIX = 'clave.'

export const categoryIdentifier = (category: NotificationCategory): string =>
  `${CATEGORY_PREFIX}${category}`

export const ACTION_IDS = {
  allow: 'clave.allow',
  deny: 'clave.deny',
  reply: 'clave.reply'
} as const

export function categoryDeclarations(): NotificationCategorySpec[] {
  return CATEGORIES.map((category) => {
    switch (category) {
      case 'permission':
        return {
          identifier: categoryIdentifier(category),
          actions: [
            {
              identifier: ACTION_IDS.allow,
              buttonTitle: 'Allow',
              options: { isAuthenticationRequired: true, opensAppToForeground: false }
            },
            {
              identifier: ACTION_IDS.deny,
              buttonTitle: 'Deny',
              options: { isDestructive: true, opensAppToForeground: false }
            }
          ]
        }
      case 'question':
        return {
          identifier: categoryIdentifier(category),
          actions: [
            {
              identifier: ACTION_IDS.reply,
              buttonTitle: 'Reply',
              textInput: { submitButtonTitle: 'Send', placeholder: 'Your answer' },
              options: { isAuthenticationRequired: true, opensAppToForeground: false }
            }
          ]
        }
      default:
        return { identifier: categoryIdentifier(category), actions: [] }
    }
  })
}

/** Declares every category to the platform, at boot. */
export async function declareCategories(
  port: Pick<NotificationsPort, 'setNotificationCategoryAsync'>
): Promise<void> {
  for (const category of categoryDeclarations())
    await port.setNotificationCategoryAsync(category.identifier, category.actions)
}

/** The category of a notification's own identifier (`clave.permission`), or null. */
export function categoryOfIdentifier(
  identifier: string | null | undefined
): NotificationCategory | null {
  if (!identifier || !identifier.startsWith(CATEGORY_PREFIX)) return null
  const rest = identifier.slice(CATEGORY_PREFIX.length)
  return (CATEGORIES as readonly string[]).includes(rest) ? (rest as NotificationCategory) : null
}

package com.clave.core.notifications

import com.clave.core.contract.NotificationCategory

/**
 * The notification categories the phone declares and the actions each carries (decision 9
 * of the spec): allow and deny on a permission, a reply field on a question, a plain tap
 * everywhere. The identifiers are the ones the server names, `clave.<category>` (the FCM
 * data's `categoryId`), so a push lands on its buttons without the phone touching it.
 *
 * Allow and reply need the phone unlocked: an agent's permission or a typed answer is the
 * person's word, not a pocket's. Deny needs nothing: refusing is safe from the lock screen.
 */
public const val CATEGORY_PREFIX: String = "clave."

public fun categoryIdentifier(category: NotificationCategory): String = "$CATEGORY_PREFIX${category.wire}"

public object ActionIds {
    public const val allow: String = "clave.allow"
    public const val deny: String = "clave.deny"
    public const val reply: String = "clave.reply"

    public val all: List<String> = listOf(allow, deny, reply)
}

public data class TextInputSpec(val submitButtonTitle: String, val placeholder: String)

public data class ActionOptions(
    val isDestructive: Boolean? = null,
    val isAuthenticationRequired: Boolean? = null,
    val opensAppToForeground: Boolean? = null,
)

public data class NotificationActionSpec(
    val identifier: String,
    val buttonTitle: String,
    val textInput: TextInputSpec? = null,
    val options: ActionOptions? = null,
)

public data class NotificationCategorySpec(val identifier: String, val actions: List<NotificationActionSpec>)

/** Every category, in the contract's order, with its actions. */
public fun categoryDeclarations(): List<NotificationCategorySpec> =
    NotificationCategory.entries.map { category ->
        val actions = when (category) {
            NotificationCategory.Permission -> listOf(
                NotificationActionSpec(
                    identifier = ActionIds.allow,
                    buttonTitle = "Allow",
                    options = ActionOptions(isAuthenticationRequired = true, opensAppToForeground = false),
                ),
                NotificationActionSpec(
                    identifier = ActionIds.deny,
                    buttonTitle = "Deny",
                    options = ActionOptions(isDestructive = true, opensAppToForeground = false),
                ),
            )
            NotificationCategory.Question -> listOf(
                NotificationActionSpec(
                    identifier = ActionIds.reply,
                    buttonTitle = "Reply",
                    textInput = TextInputSpec(submitButtonTitle = "Send", placeholder = "Your answer"),
                    options = ActionOptions(isAuthenticationRequired = true, opensAppToForeground = false),
                ),
            )
            else -> emptyList()
        }
        NotificationCategorySpec(categoryIdentifier(category), actions)
    }

/** The category of a notification's own identifier (`clave.permission`), or null. */
public fun categoryOfIdentifier(identifier: String?): NotificationCategory? {
    if (identifier == null || !identifier.startsWith(CATEGORY_PREFIX)) return null
    return NotificationCategory.of(identifier.removePrefix(CATEGORY_PREFIX))
}

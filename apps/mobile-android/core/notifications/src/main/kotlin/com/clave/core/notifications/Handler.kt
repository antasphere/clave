package com.clave.core.notifications

import com.clave.core.devices.Credential

/** What became of a notification response: nothing Clave's, answered in the background, or
 *  the app to open on a link. */
public sealed interface HandleResult {
    public data object Ignored : HandleResult
    public data object Settled : HandleResult
    public data class Open(val link: DeepLink) : HandleResult
}

/**
 * One response, end to end. The credential is the one of the machine the notification's own
 * server resolves to, and nothing else: a server this phone is not paired with never gets a
 * client built at all, so another machine's device session cannot answer for it. An action
 * button that cannot settle opens the request it was about, a plain tap the conversation.
 */
public suspend fun handleResponse(
    response: IncomingResponse,
    machines: MachineResolver,
    credentials: suspend (machineId: String) -> Credential?,
    client: (Credential) -> SettleClient,
): HandleResult {
    val intent = interpretResponse(response) ?: return HandleResult.Ignored
    val machine = machines.byServerId(intent.payload.serverId)
        ?: return HandleResult.Open(deepLinkOf(intent.payload, machines))
    val credential = credentials(machine.machineId) ?: return HandleResult.Open(DeepLink.Machines("Pair this phone again."))
    if (intent !is NotificationIntent.Open) {
        return when (settleFromNotification(intent, client(credential))) {
            SettleOutcome.Settled, SettleOutcome.AlreadySettled -> HandleResult.Settled
            else -> HandleResult.Open(deepLinkOf(intent.payload, machines, DeepLinkTarget.Request))
        }
    }
    val actionNeedsForm = response.actionIdentifier in ActionIds.all
    return HandleResult.Open(
        deepLinkOf(intent.payload, machines, if (actionNeedsForm) DeepLinkTarget.Request else DeepLinkTarget.Conversation),
    )
}

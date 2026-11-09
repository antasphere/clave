package com.clave.core.notifications

import com.clave.core.contract.AgentQuestion
import com.clave.core.contract.IdLabel
import com.clave.core.contract.NotificationAction
import com.clave.core.contract.NotificationPayload
import com.clave.core.contract.PendingRequest
import com.clave.core.contract.RequestKind
import com.clave.core.contract.RequestResponse
import com.clave.core.contract.RequestSnapshot
import com.clave.core.contract.ResolveOutcome
import com.clave.core.contract.WriteAnswer
import com.clave.core.contract.WriteAnswerStatus
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.json.JsonElement

/**
 * What a notification's action means and how its answer reaches the server (decision 9 of
 * the spec): allow and deny on a permission, a typed reply on a question, through
 * `POST /requests/resolve` with the device session, in the background; anything the
 * notification cannot settle opens the app on the request.
 *
 * The answer is shaped from the pending request fetched by its id, never from the payload:
 * a permission's option ids are the adapter's (`allow-once` and `deny` for Claude, `approve`
 * and `deny` for an MCP approval, native strings for Codex), and a clarification's answer
 * is keyed by `q.id ?: q.question`, which the payload's bounded text cannot give. A server
 * without the requests port (the Mac app's in-process server) holds the prompt as a stream
 * frame instead, and names that frame's id as the `requestId`: there, allow and deny go
 * through `POST /sessions/write` as a `permission_response`, and a reply opens the app,
 * since the question's key is only in the frame.
 */

/** The identifier of a plain tap; any identifier outside [ActionIds] reads as one. */
public const val DEFAULT_ACTION_IDENTIFIER: String = "clave.open"

/** The person's answer to a notification, as the app's receiver hands it over. */
public data class IncomingResponse(
    val notificationId: String,
    /** When the notification was posted, epoch milliseconds: with the id and the action,
     *  what tells a second delivery of one tap from a new one. */
    val date: Long,
    val actionIdentifier: String,
    /** The push's data, as [parsePayload] reads it. */
    val data: JsonElement?,
    val userText: String? = null,
)

public sealed interface NotificationIntent {
    public val payload: NotificationPayload

    public data class Allow(override val payload: NotificationPayload) : NotificationIntent
    public data class Deny(override val payload: NotificationPayload) : NotificationIntent
    public data class Reply(override val payload: NotificationPayload, val text: String) : NotificationIntent
    public data class Open(override val payload: NotificationPayload) : NotificationIntent
}

/** What the person did on the notification, as the payload allows it: an action the
 *  payload did not offer is a plain open. Null when the push carried no readable payload. */
public fun interpretResponse(response: IncomingResponse): NotificationIntent? {
    val payload = parsePayload(response.data) ?: return null
    return when (response.actionIdentifier) {
        ActionIds.allow ->
            if (NotificationAction.Allow in payload.actions) NotificationIntent.Allow(payload) else NotificationIntent.Open(payload)
        ActionIds.deny ->
            if (NotificationAction.Deny in payload.actions) NotificationIntent.Deny(payload) else NotificationIntent.Open(payload)
        ActionIds.reply -> {
            val text = response.userText?.trim().orEmpty()
            if (NotificationAction.Reply in payload.actions && text.isNotEmpty()) NotificationIntent.Reply(payload, text)
            else NotificationIntent.Open(payload)
        }
        else -> NotificationIntent.Open(payload)
    }
}

public enum class PermissionChoice { Allow, Deny }

/** The server's own rule for which option ids are an allow and a deny
 *  (`packages/server/src/notify/payload.ts`), so the phone answers what the server offered. */
private val ALLOW_OPTION = Regex("^(allow|allow-once|approve|accept|yes|ok)$", RegexOption.IGNORE_CASE)
private val DENY_OPTION = Regex("^(deny|decline|reject|cancel|no)$", RegexOption.IGNORE_CASE)

/** The option id to answer with: the request's own when it is known, else the Claude
 *  adapter's `allow-once` and `deny`. A request offering several allows (`allow-once`,
 *  `allow-always`) gets the narrower one. */
public fun permissionOptionId(options: List<IdLabel>?, choice: PermissionChoice): String {
    val pattern = if (choice == PermissionChoice.Allow) ALLOW_OPTION else DENY_OPTION
    val own = (if (choice == PermissionChoice.Allow) options?.firstOrNull { it.id == "allow-once" } else null)?.id
        ?: options?.firstOrNull { pattern.matches(it.id) }?.id
    return own ?: if (choice == PermissionChoice.Allow) "allow-once" else "deny"
}

public fun permissionResponse(options: List<IdLabel>?, choice: PermissionChoice): RequestResponse.Permission =
    RequestResponse.Permission(permissionOptionId(options, choice))

/** The key the server reads an answer under (requests/answers.ts). */
private fun questionKey(q: AgentQuestion): String = q.id ?: q.question

/** A request held under a provider's id answers like a permission even as a
 *  clarification: the server reads `permission` with the option `answer` (answers.ts). */
private fun answersAsPermission(request: PendingRequest): Boolean =
    request.kind == RequestKind.Permission || request.providerRequestId != null

/** A typed reply to the one question of the request, keyed as the server reads it; null
 *  when the request asks more than one question or none, which the app answers. */
public fun replyResponse(request: PendingRequest, text: String): RequestResponse? {
    val questions = request.questions.orEmpty()
    if (questions.size != 1) return null
    val answers = mapOf(questionKey(questions[0]) to text)
    return if (answersAsPermission(request)) RequestResponse.Permission("answer", answers)
    else RequestResponse.Clarification(answers)
}

public sealed interface SettleOutcome {
    public data object Settled : SettleOutcome
    /** Somebody else answered first, or the request is gone. */
    public data object AlreadySettled : SettleOutcome
    /** The notification cannot settle this: the app opens on it. */
    public data class OpenApp(val reason: String) : SettleOutcome
    public data class Failed(val reason: String) : SettleOutcome
}

/** The server has no requests port (the in-process server): the transport module adapts its
 *  own `CapabilityUnavailable` refusal to this, and the answer goes through the write route. */
public open class CapabilityUnavailableException(message: String) : Exception(message)

/** The server refused the answer (a 422 the transport reads as refused): on the write route,
 *  the prompt is not waiting any more. */
public open class RefusedException(message: String) : Exception(message)

/** What [settleFromNotification] needs of the server client. */
public interface SettleClient {
    public suspend fun listRequests(): RequestSnapshot
    public suspend fun resolve(requestId: String, response: RequestResponse): ResolveOutcome
    /** `POST /sessions/write` with `{type: 'permission_response', id, optionId}`. */
    public suspend fun writePermissionResponse(sessionId: String, requestId: String, optionId: String): WriteAnswer
}

private fun reasonOf(error: Exception): String = error.message?.takeIf { it.isNotEmpty() } ?: "The machine could not be reached."

public suspend fun settleFromNotification(intent: NotificationIntent, client: SettleClient): SettleOutcome {
    if (intent is NotificationIntent.Open) return SettleOutcome.OpenApp("The notification was opened.")
    val payload = intent.payload
    val requestId = payload.requestId
    if (requestId.isNullOrEmpty()) return SettleOutcome.OpenApp("The notification names no request to answer.")
    val snapshot = try {
        client.listRequests()
    } catch (e: CancellationException) {
        throw e
    } catch (_: CapabilityUnavailableException) {
        return settleInChat(intent, client)
    } catch (e: Exception) {
        return SettleOutcome.Failed(reasonOf(e))
    }
    val request = snapshot.pending.firstOrNull { it.id == requestId } ?: return SettleOutcome.AlreadySettled
    if (request.sessionId != payload.sessionId) {
        return SettleOutcome.OpenApp("The notification no longer matches this conversation.")
    }
    val response: RequestResponse = when (intent) {
        is NotificationIntent.Reply -> replyResponse(request, intent.text)
            ?: return SettleOutcome.OpenApp("This question needs the app to be answered.")
        else -> {
            if (request.kind != RequestKind.Permission) return SettleOutcome.OpenApp("This request needs the app.")
            val choice = if (intent is NotificationIntent.Allow) PermissionChoice.Allow else PermissionChoice.Deny
            val permission = permissionResponse(request.options, choice)
            val options = request.options
            if (!options.isNullOrEmpty() && options.none { it.id == permission.optionId }) {
                return SettleOutcome.OpenApp("Choose the permission in the app.")
            }
            permission
        }
    }
    return try {
        if (client.resolve(request.id, response).accepted) SettleOutcome.Settled else SettleOutcome.AlreadySettled
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        SettleOutcome.Failed(reasonOf(e))
    }
}

/** The in-process server's way: the prompt is a stream frame of the session, answered
 *  through the write route. */
private suspend fun settleInChat(intent: NotificationIntent, client: SettleClient): SettleOutcome {
    val payload = intent.payload
    if (intent is NotificationIntent.Reply) return SettleOutcome.OpenApp("This question needs the app to be answered.")
    val requestId = payload.requestId
    if (payload.sessionId.isEmpty() || requestId.isNullOrEmpty()) {
        return SettleOutcome.OpenApp("The notification names no conversation to answer in.")
    }
    val choice = if (intent is NotificationIntent.Allow) PermissionChoice.Allow else PermissionChoice.Deny
    return try {
        val answer = client.writePermissionResponse(payload.sessionId, requestId, permissionOptionId(null, choice))
        if (answer.status == WriteAnswerStatus.Pending) SettleOutcome.OpenApp("The answer is still pending. Check it in the app.")
        else SettleOutcome.Settled
    } catch (e: CancellationException) {
        throw e
    } catch (_: RefusedException) {
        SettleOutcome.AlreadySettled
    } catch (e: Exception) {
        SettleOutcome.Failed(reasonOf(e))
    }
}

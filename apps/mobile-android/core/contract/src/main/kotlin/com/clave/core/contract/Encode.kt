/**
 * What the phone sends, as the contract's command payloads decode it. An optional field
 * that is null is left out, never written as JSON null: the contract's
 * `Schema.optional` refuses a null where it accepts an absence.
 */
package com.clave.core.contract

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

object Encode {
    private fun JsonObjectBuilder.opt(key: String, value: String?) {
        if (value != null) put(key, value)
    }

    private fun JsonObjectBuilder.opt(key: String, value: Boolean?) {
        if (value != null) put(key, value)
    }

    private fun JsonObjectBuilder.opt(key: String, value: Long?) {
        if (value != null) put(key, value)
    }

    private fun JsonObjectBuilder.opt(key: String, value: JsonElement?) {
        if (value != null) put(key, value)
    }

    private fun strings(values: List<String>): JsonArray = JsonArray(values.map { JsonPrimitive(it) })

    private fun answers(values: Map<String, String>): JsonObject =
        JsonObject(values.mapValues { JsonPrimitive(it.value) })

    fun launchProfile(profile: LaunchProfileView): JsonObject = buildJsonObject {
        put("id", profile.id)
        put("name", profile.name)
        put("family", profile.family.wire)
        put("command", strings(profile.command))
        put("additionalArgs", strings(profile.additionalArgs))
        opt("builtIn", profile.builtIn)
        opt("sourceProfileId", profile.sourceProfileId)
        opt(
            "pi",
            profile.pi?.let { pi ->
                buildJsonObject {
                    opt("provider", pi.provider)
                    opt("model", pi.model)
                    opt("thinking", pi.thinking?.wire)
                }
            },
        )
    }

    private fun spawnOptions(options: SpawnOptions): JsonObject = buildJsonObject {
        opt("claudeMode", options.claudeMode)
        opt("antigravityMode", options.antigravityMode)
        opt("codexMode", options.codexMode)
        opt("piMode", options.piMode)
        opt("launchProfileId", options.launchProfileId)
        opt("launchProfile", options.launchProfile?.let(::launchProfile))
        opt("workspaceId", options.workspaceId)
    }

    /** `POST /sessions/start`. */
    fun startSession(input: StartSessionInput): JsonObject = buildJsonObject {
        put("cwd", input.cwd)
        opt("windowKey", input.windowKey)
        opt("options", input.options?.let(::spawnOptions))
    }

    fun attachment(attachment: Attachment): JsonObject = when (attachment) {
        is FileAttachment -> buildJsonObject {
            put("id", attachment.id)
            opt("label", attachment.label)
            put("path", attachment.path)
            put("name", attachment.name)
            put("mimeType", attachment.mimeType)
            put("size", attachment.size)
            put("delivery", attachment.delivery.wire)
            opt("entries", attachment.entries)
        }
        is SessionAttachment -> buildJsonObject {
            put("id", attachment.id)
            opt("label", attachment.label)
            put("delivery", "session")
            put("sessionId", attachment.sessionId)
            put("name", attachment.name)
            put("agent", attachment.agent)
            put("cwd", attachment.cwd)
        }
    }

    fun sessionWriteInput(input: SessionWriteInput): JsonObject = when (input) {
        is SessionEvent.UserMessage -> buildJsonObject {
            put("type", "user_message")
            put("text", input.text)
            opt("clientMessageId", input.clientMessageId)
            opt("attachments", input.attachments?.let { list -> JsonArray(list.map(::attachment)) })
            opt("parent", input.parent)
            opt("form", input.form)
        }
        is PermissionResponse -> buildJsonObject {
            put("type", "permission_response")
            put("id", input.id)
            put("optionId", input.optionId)
            val lists = input.lists.orEmpty()
            if (input.answers != null || lists.isNotEmpty()) {
                put(
                    "answers",
                    JsonObject(
                        input.answers.orEmpty().mapValues { JsonPrimitive(it.value) } +
                            lists.mapValues { (_, labels) -> JsonArray(labels.map(::JsonPrimitive)) },
                    ),
                )
            }
        }
        Interrupt -> buildJsonObject { put("type", "interrupt") }
        is SetModel -> buildJsonObject {
            put("type", "set_model")
            // Null is the contract's own value here (`Schema.NullOr`): the provider's default.
            put("model", input.model?.let(::JsonPrimitive) ?: kotlinx.serialization.json.JsonNull)
            opt("remember", input.remember)
        }
        is SetEffort -> buildJsonObject {
            put("type", "set_effort")
            put("effort", input.effort)
        }
        is SetPermissionMode -> buildJsonObject {
            put("type", "set_permission_mode")
            put("mode", input.mode)
        }
        is StopTask -> buildJsonObject {
            put("type", "stop_task")
            put("taskId", input.taskId)
        }
    }

    /** `POST /sessions/write`. */
    fun writeSession(id: String, input: SessionWriteInput): JsonObject = buildJsonObject {
        put("id", id)
        put("input", sessionWriteInput(input))
    }

    fun requestResponse(response: RequestResponse): JsonObject = when (response) {
        is RequestResponse.Permission -> buildJsonObject {
            put("type", "permission")
            put("optionId", response.optionId)
            opt("answers", response.answers?.let(::answers))
        }
        is RequestResponse.Clarification -> buildJsonObject {
            put("type", "clarification")
            put("answers", answers(response.answers))
        }
        is RequestResponse.Secret -> buildJsonObject {
            put("type", "secret")
            put("value", response.value)
        }
        RequestResponse.Dismiss -> buildJsonObject { put("type", "dismiss") }
    }

    /** `POST /requests/resolve`. */
    fun resolveRequest(input: ResolveRequestInput): JsonObject = buildJsonObject {
        put("requestId", input.requestId)
        put("response", requestResponse(input.response))
    }

    /** One frame on the push socket, the phone's side. */
    fun clientFrame(frame: ClientFrame): JsonObject = when (frame) {
        is ClientFrame.Hello -> buildJsonObject {
            put("_tag", "hello")
            put("token", frame.token)
            opt("client", frame.client)
        }
        is ClientFrame.Subscribe -> buildJsonObject {
            put("_tag", "subscribe")
            put("sessionId", frame.sessionId)
        }
        is ClientFrame.Unsubscribe -> buildJsonObject {
            put("_tag", "unsubscribe")
            put("sessionId", frame.sessionId)
        }
        ClientFrame.Ping -> buildJsonObject { put("_tag", "ping") }
    }

    /** `POST /devices/pair`: the hub's ID token is the proof, so the body is the credential. */
    fun pairingRequest(idToken: String, clientId: String, device: DeviceDescription): JsonObject = buildJsonObject {
        put("idToken", idToken)
        put("clientId", clientId)
        put(
            "device",
            buildJsonObject {
                put("name", device.name)
                put("platform", device.platform.wire)
                put("appVersion", device.appVersion)
            },
        )
    }

    /** `POST /devices/me/push-token`. */
    fun pushToken(token: String, platform: DevicePlatform): JsonObject = buildJsonObject {
        put("token", token)
        put("platform", platform.wire)
    }
}

/** The JSON text of an element, compact, as a request body or a socket frame. */
fun JsonElement.toText(): String = Json.encodeToString(JsonElement.serializer(), this)

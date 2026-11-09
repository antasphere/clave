package com.clave.core.notifications

import com.clave.core.contract.AgentQuestion
import com.clave.core.contract.DevicePlatform
import com.clave.core.contract.IdLabel
import com.clave.core.contract.NotificationAction
import com.clave.core.contract.NotificationCategory
import com.clave.core.contract.NotificationPayload
import com.clave.core.contract.PendingRequest
import com.clave.core.contract.RequestKind
import com.clave.core.contract.RequestResponse
import com.clave.core.contract.RequestSnapshot
import com.clave.core.contract.ResolveOutcome
import com.clave.core.contract.WriteAnswer
import com.clave.core.contract.WriteAnswerStatus
import com.clave.core.ports.MemoryKeyValueStore
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PayloadTest {
    @Test
    fun `reads the iOS shape, under the clave key beside aps`() {
        assertEquals(permission, parsePayload(iosData(permission)))
    }

    @Test
    fun `reads the Android shape, every field a string and the actions joined by commas`() {
        assertEquals(permission, parsePayload(androidData(permission)))
        assertEquals(permission, parsePayload(androidJson(permission)))
        val account = NotificationPayload(
            category = NotificationCategory.AccountLimit,
            serverId = "srv-1",
            serverName = "Mac",
            sessionId = "",
            sessionTitle = "",
            text = "Claude: 5h window has 5% left",
            actions = listOf(NotificationAction.Open),
        )
        assertEquals(account, parsePayload(androidData(account)))
    }

    @Test
    fun `reads a JSON string in either place`() {
        assertEquals(question, parsePayload(JsonPrimitive(iosData(question).toString())))
        assertEquals(question, parsePayload(buildJsonObject { put("aps", buildJsonObject {}); put("clave", payloadJson(question).toString()) }))
    }

    @Test
    fun `answers null for a push that is not Clave's, and open for actions it does not know`() {
        assertNull(parsePayload(buildJsonObject { put("foo", 1) }))
        assertNull(parsePayload(buildJsonObject { put("category", "party"); put("serverId", "x") }))
        assertNull(parsePayload(buildJsonObject { put("category", "finished") }))
        assertNull(parsePayload(JsonPrimitive("not json")))
        assertNull(parsePayload(null as kotlinx.serialization.json.JsonElement?))
        assertNull(parsePayload(JsonNull))
        val jumpy = JsonArray(listOf("jump", "allow", "allow").map { JsonPrimitive(it) })
        assertEquals(listOf(NotificationAction.Allow), parsePayload(payloadJson(permission, jumpy))?.actions)
        assertEquals(listOf(NotificationAction.Open), parsePayload(payloadJson(permission, JsonPrimitive("launch")))?.actions)
        assertEquals(listOf(NotificationAction.Open), parsePayload(payloadJson(permission, JsonNull))?.actions)
        assertEquals(
            listOf(NotificationAction.Reply, NotificationAction.Open),
            parsePayload(payloadJson(permission, JsonPrimitive(" reply , open,party")))?.actions,
        )
    }

    @Test
    fun `a payload nested deeper than three levels is not read`() {
        var nested: kotlinx.serialization.json.JsonElement = payloadJson(permission)
        repeat(3) { nested = buildJsonObject { put(APNS_KEY, nested) } }
        assertEquals(permission, parsePayload(nested))
        nested = buildJsonObject { put(APNS_KEY, nested) }
        assertNull(parsePayload(nested))
    }

    @Test
    fun `an empty request id or workspace name is absent`() {
        val bare = androidData(permission) + mapOf("requestId" to "", "workspaceName" to "")
        val read = parsePayload(bare)!!
        assertNull(read.requestId)
        assertNull(read.workspaceName)
    }
}

class CategoriesTest {
    @Test
    fun `declares allow and deny on a permission, a reply field on a question, a tap elsewhere`() {
        val declared = categoryDeclarations()
        assertEquals(
            listOf("clave.question", "clave.permission", "clave.secret", "clave.finished", "clave.failed", "clave.account_limit", "clave.test"),
            declared.map { it.identifier },
        )
        val perm = declared.first { it.identifier == categoryIdentifier(NotificationCategory.Permission) }
        assertEquals(listOf(ActionIds.allow, ActionIds.deny), perm.actions.map { it.identifier })
        assertEquals(listOf("Allow", "Deny"), perm.actions.map { it.buttonTitle })
        assertEquals(ActionOptions(isAuthenticationRequired = true, opensAppToForeground = false), perm.actions[0].options)
        assertEquals(ActionOptions(isDestructive = true, opensAppToForeground = false), perm.actions[1].options)
        val q = declared.first { it.identifier == categoryIdentifier(NotificationCategory.Question) }
        assertEquals(1, q.actions.size)
        assertEquals(TextInputSpec(submitButtonTitle = "Send", placeholder = "Your answer"), q.actions[0].textInput)
        assertEquals(false, q.actions[0].options?.opensAppToForeground)
        assertEquals(true, q.actions[0].options?.isAuthenticationRequired)
        for (other in listOf("secret", "finished", "failed", "account_limit", "test")) {
            assertEquals(emptyList<NotificationActionSpec>(), declared.first { it.identifier == "clave.$other" }.actions)
        }
    }

    @Test
    fun `reads a category off the notification's own identifier`() {
        assertEquals(NotificationCategory.Question, categoryOfIdentifier("clave.question"))
        assertNull(categoryOfIdentifier("clave.party"))
        assertNull(categoryOfIdentifier("other.question"))
        assertNull(categoryOfIdentifier(null))
    }
}

class InterpretTest {
    @Test
    fun `a tap opens, an action the payload offers is that action`() {
        assertEquals(NotificationIntent.Open(permission), interpretResponse(response(iosData(permission))))
        assertEquals(NotificationIntent.Allow(permission), interpretResponse(response(androidJson(permission), ActionIds.allow)))
        assertEquals(NotificationIntent.Deny(permission), interpretResponse(response(iosData(permission), ActionIds.deny)))
        assertEquals(NotificationIntent.Reply(question, "main"), interpretResponse(response(iosData(question), ActionIds.reply, " main ")))
    }

    @Test
    fun `an action the payload did not offer, or a reply without text, is an open`() {
        assertTrue(interpretResponse(response(iosData(question), ActionIds.allow)) is NotificationIntent.Open)
        assertTrue(interpretResponse(response(iosData(question), ActionIds.deny)) is NotificationIntent.Open)
        assertTrue(interpretResponse(response(iosData(permission), ActionIds.reply, "x")) is NotificationIntent.Open)
        assertTrue(interpretResponse(response(iosData(question), ActionIds.reply, "  ")) is NotificationIntent.Open)
        assertTrue(interpretResponse(response(iosData(question), ActionIds.reply, null)) is NotificationIntent.Open)
        assertTrue(interpretResponse(response(iosData(permission), "something.else")) is NotificationIntent.Open)
    }

    @Test
    fun `a push without a readable payload is nothing`() {
        assertNull(interpretResponse(response(buildJsonObject { put("foo", 1) })))
    }
}

private val base = PendingRequest(id = "r-1", sessionId = "s-1", kind = RequestKind.Permission, description = "Run npm test?", createdAt = 1)

class AnswerShapingTest {
    @Test
    fun `answers with the request's own option ids, the Claude ones when none are known`() {
        val claude = listOf(IdLabel("allow-once", "Allow"), IdLabel("allow-always", "Always"), IdLabel("deny", "Deny"))
        assertEquals("allow-once", permissionOptionId(claude, PermissionChoice.Allow))
        assertEquals("deny", permissionOptionId(claude, PermissionChoice.Deny))
        val mcp = listOf(IdLabel("approve", "Approve"), IdLabel("deny", "Deny"))
        assertEquals("approve", permissionOptionId(mcp, PermissionChoice.Allow))
        assertEquals("allow-once", permissionOptionId(null, PermissionChoice.Allow))
        assertEquals("deny", permissionOptionId(null, PermissionChoice.Deny))
        assertEquals("Reject", permissionOptionId(listOf(IdLabel("Reject", "No")), PermissionChoice.Deny))
        assertEquals(RequestResponse.Permission("approve"), permissionResponse(mcp, PermissionChoice.Allow))
    }

    @Test
    fun `keys a reply by the question's id, else its text, as the server reads it`() {
        val clarification = base.copy(id = "r-2", kind = RequestKind.Clarification, questions = listOf(AgentQuestion("q-branch", "Which branch?", options = emptyList())))
        assertEquals(RequestResponse.Clarification(mapOf("q-branch" to "main")), replyResponse(clarification, "main"))
        val noId = clarification.copy(questions = listOf(AgentQuestion(question = "Which branch?", options = emptyList())))
        assertEquals(RequestResponse.Clarification(mapOf("Which branch?" to "main")), replyResponse(noId, "main"))
    }

    @Test
    fun `a native question held under a provider id answers as a permission with answer`() {
        val native = base.copy(kind = RequestKind.Clarification, providerRequestId = "p-1", questions = listOf(AgentQuestion("q1", "Which branch?", options = emptyList())))
        assertEquals(RequestResponse.Permission("answer", mapOf("q1" to "main")), replyResponse(native, "main"))
    }

    @Test
    fun `a request with several questions, or none, is the app's to answer`() {
        val two = base.copy(
            kind = RequestKind.Clarification,
            questions = listOf(AgentQuestion("a", "A?", options = emptyList()), AgentQuestion("b", "B?", options = emptyList())),
        )
        assertNull(replyResponse(two, "x"))
        assertNull(replyResponse(base.copy(kind = RequestKind.Clarification), "x"))
    }
}

/** A settle client the test scripts: what the list answers, whether a resolve is accepted,
 *  what the write route does. */
class FakeSettleClient(
    var list: suspend () -> RequestSnapshot = { RequestSnapshot(1, PENDING) },
    var accepted: Boolean = true,
    var write: suspend () -> WriteAnswer = { WriteAnswer(WriteAnswerStatus.Accepted) },
) : SettleClient {
    val resolved = mutableListOf<Pair<String, RequestResponse>>()
    val written = mutableListOf<Triple<String, String, String>>()

    override suspend fun listRequests(): RequestSnapshot = list()

    override suspend fun resolve(requestId: String, response: RequestResponse): ResolveOutcome {
        resolved += requestId to response
        return ResolveOutcome(accepted)
    }

    override suspend fun writePermissionResponse(sessionId: String, requestId: String, optionId: String): WriteAnswer {
        val answer = write()
        written += Triple(sessionId, requestId, optionId)
        return answer
    }

    companion object {
        val PENDING = listOf(
            PendingRequest(
                id = "r-1", sessionId = "s-1", kind = RequestKind.Permission, description = "Run npm test?", createdAt = 1,
                options = listOf(IdLabel("approve", "Approve"), IdLabel("deny", "Deny")),
            ),
            PendingRequest(
                id = "r-2", sessionId = "s-1", kind = RequestKind.Clarification, description = "Which branch?", createdAt = 2,
                questions = listOf(AgentQuestion("q-branch", "Which branch should the fix land on?", options = emptyList())),
            ),
        )
    }
}

class SettleTest {
    @Test
    fun `allows with the request's own option id, through the resolve route`() = runTest {
        val client = FakeSettleClient()
        assertEquals(SettleOutcome.Settled, settleFromNotification(NotificationIntent.Allow(permission), client))
        assertEquals(listOf("r-1" to RequestResponse.Permission("approve")), client.resolved)
    }

    @Test
    fun `denies the same way`() = runTest {
        val client = FakeSettleClient()
        settleFromNotification(NotificationIntent.Deny(permission), client)
        assertEquals(RequestResponse.Permission("deny"), client.resolved.single().second)
    }

    @Test
    fun `replies to the one question, keyed as the server reads it`() = runTest {
        val client = FakeSettleClient()
        assertEquals(SettleOutcome.Settled, settleFromNotification(NotificationIntent.Reply(question, "main"), client))
        assertEquals(listOf("r-2" to RequestResponse.Clarification(mapOf("q-branch" to "main"))), client.resolved)
    }

    @Test
    fun `a first answer that came from elsewhere is said as already settled`() = runTest {
        assertEquals(SettleOutcome.AlreadySettled, settleFromNotification(NotificationIntent.Allow(permission), FakeSettleClient(accepted = false)))
        val gone = FakeSettleClient(list = { RequestSnapshot(2, emptyList()) })
        assertEquals(SettleOutcome.AlreadySettled, settleFromNotification(NotificationIntent.Allow(permission), gone))
        assertEquals(emptyList<Any>(), gone.resolved)
    }

    @Test
    fun `what the notification cannot settle opens the app`() = runTest {
        val client = FakeSettleClient()
        assertTrue(settleFromNotification(NotificationIntent.Open(permission), client) is SettleOutcome.OpenApp)
        assertTrue(settleFromNotification(NotificationIntent.Allow(permission.copy(requestId = null)), client) is SettleOutcome.OpenApp)
        val twoQuestions = FakeSettleClient(
            list = {
                RequestSnapshot(
                    1,
                    listOf(
                        FakeSettleClient.PENDING[1].copy(
                            questions = listOf(AgentQuestion("a", "A?", options = emptyList()), AgentQuestion("b", "B?", options = emptyList())),
                        ),
                    ),
                )
            },
        )
        assertEquals(
            SettleOutcome.OpenApp("This question needs the app to be answered."),
            settleFromNotification(NotificationIntent.Reply(question, "x"), twoQuestions),
        )
        assertEquals(emptyList<Any>(), client.resolved)
        assertEquals(emptyList<Any>(), twoQuestions.resolved)
    }

    @Test
    fun `a request of another session opens the app`() = runTest {
        val client = FakeSettleClient()
        assertEquals(
            SettleOutcome.OpenApp("The notification no longer matches this conversation."),
            settleFromNotification(NotificationIntent.Allow(permission.copy(sessionId = "s-other")), client),
        )
        assertEquals(emptyList<Any>(), client.resolved)
    }

    @Test
    fun `allow on a clarification, or an option the request does not offer, opens the app`() = runTest {
        val client = FakeSettleClient()
        assertEquals(
            SettleOutcome.OpenApp("This request needs the app."),
            settleFromNotification(NotificationIntent.Allow(permission.copy(requestId = "r-2")), client),
        )
        val alwaysOnly = FakeSettleClient(list = { RequestSnapshot(1, listOf(FakeSettleClient.PENDING[0].copy(options = listOf(IdLabel("allow-always", "Always"))))) })
        assertEquals(
            SettleOutcome.OpenApp("Choose the permission in the app."),
            settleFromNotification(NotificationIntent.Allow(permission), alwaysOnly),
        )
        assertEquals(emptyList<Any>(), alwaysOnly.resolved)
    }

    @Test
    fun `on a server without the requests port, allow and deny go through the write route`() = runTest {
        val unavailable: suspend () -> RequestSnapshot = { throw CapabilityUnavailableException("No requests here.") }
        val client = FakeSettleClient(list = unavailable)
        assertEquals(SettleOutcome.Settled, settleFromNotification(NotificationIntent.Allow(permission), client))
        assertEquals(listOf(Triple("s-1", "r-1", "allow-once")), client.written)
        assertTrue(settleFromNotification(NotificationIntent.Reply(question, "x"), client) is SettleOutcome.OpenApp)
        val refusedWrite = FakeSettleClient(list = unavailable, write = { throw RefusedException("Not waiting.") })
        assertEquals(SettleOutcome.AlreadySettled, settleFromNotification(NotificationIntent.Deny(permission), refusedWrite))
        val pendingWrite = FakeSettleClient(list = unavailable, write = { WriteAnswer(WriteAnswerStatus.Pending) })
        assertEquals(
            SettleOutcome.OpenApp("The answer is still pending. Check it in the app."),
            settleFromNotification(NotificationIntent.Allow(permission), pendingWrite),
        )
        assertEquals(
            SettleOutcome.OpenApp("The notification names no conversation to answer in."),
            settleFromNotification(NotificationIntent.Allow(permission.copy(sessionId = "")), client),
        )
    }

    @Test
    fun `a machine that cannot be reached is a failure, not a settled answer`() = runTest {
        val client = FakeSettleClient(list = { throw IllegalStateException("The server could not be reached.") })
        assertEquals(SettleOutcome.Failed("The server could not be reached."), settleFromNotification(NotificationIntent.Allow(permission), client))
        assertEquals(emptyList<Any>(), client.resolved)
    }
}

class DeepLinkTest {
    private val machines = MachineResolver { serverId -> if (serverId == "srv-1") MachineRef("m-1") else null }

    @Test
    fun `a tap opens the conversation, cold as warm`() = runTest {
        val link = deepLinkOf(permission, machines)
        assertEquals(DeepLink.Chat("m-1", "s-1", "Fix the flaky test"), link)
        assertEquals(
            InitialRoute(
                2,
                listOf(
                    Route("Machines"),
                    Route("Workspaces", mapOf("machineId" to "m-1")),
                    Route("Chat", mapOf("machineId" to "m-1", "sessionId" to "s-1", "title" to "Fix the flaky test")),
                ),
            ),
            navigationStateOf(link),
        )
        assertEquals(Route("Chat", mapOf("machineId" to "m-1", "sessionId" to "s-1", "title" to "Fix the flaky test")), routeOf(link))
    }

    @Test
    fun `a request the notification could not settle opens the app on the requests`() = runTest {
        val link = deepLinkOf(question, machines, DeepLinkTarget.Request)
        assertEquals(DeepLink.Requests("m-1", "r-2"), link)
        assertEquals(Route("Requests", mapOf("machineId" to "m-1", "requestId" to "r-2")), routeOf(link))
        assertEquals(Route("Requests", mapOf("machineId" to "m-1")), routeOf(DeepLink.Requests("m-1", null)))
    }

    @Test
    fun `a notification about an account opens the machine's workspaces`() = runTest {
        val link = deepLinkOf(
            permission.copy(category = NotificationCategory.AccountLimit, sessionId = "", sessionTitle = "", requestId = null),
            machines,
        )
        assertEquals(DeepLink.Workspaces("m-1"), link)
        assertEquals(1, navigationStateOf(link).index)
    }

    @Test
    fun `a server this phone is not paired with lands on Machines with the reason`() = runTest {
        val link = deepLinkOf(permission.copy(serverId = "srv-9"), machines)
        assertEquals(DeepLink.Machines("Valentin’s Mac is not paired with this phone."), link)
        assertEquals(Route("Machines"), routeOf(link))
        assertEquals(DeepLink.Machines("That machine is not paired with this phone."), deepLinkOf(permission.copy(serverId = "srv-9", serverName = ""), machines))
    }

    @Test
    fun `every link survives its uri`() {
        val links = listOf(
            DeepLink.Chat("m 1/é", "s?1&x", "Fix the flaky test"),
            DeepLink.Chat("m-1", "s-1", ""),
            DeepLink.Requests("m-1", "r-2"),
            DeepLink.Requests("m-1", null),
            DeepLink.Workspaces("dev:127.0.0.1:43201"),
            DeepLink.Machines(""),
        )
        for (link in links) assertEquals(link, parseDeepLink(link.toUri()))
        assertEquals("clave-android://chat/m%201%2F%C3%A9/s%3F1%26x?title=Fix%20the%20flaky%20test", links[0].toUri())
        assertEquals("clave-android://requests/m-1", links[3].toUri())
        assertEquals("clave-android://machines", DeepLink.Machines("A reason").toUri())
        assertEquals(DeepLink.Machines(""), parseDeepLink("clave-android://machines"))
        assertEquals("clave://chat/m/s", DeepLink.Chat("m", "s", "").toUri("clave"))
    }

    @Test
    fun `a uri this app does not know is no link`() {
        assertNull(parseDeepLink("clave://chat/m/s"))
        assertNull(parseDeepLink("clave-android://chat/m"))
        assertNull(parseDeepLink("clave-android://chat/m/%E0%A4%A"))
        assertNull(parseDeepLink("clave-android://party/m"))
        assertNull(parseDeepLink("clave-android://"))
        assertEquals(DeepLink.Chat("m", "s", ""), parseDeepLink("clave-android://chat/m/s#frag"))
    }

    @Test
    fun `the enrollment records resolve a server`() = runTest {
        val records = com.clave.core.devices.EnrollmentRecords(MemoryKeyValueStore())
        records.set(com.clave.core.devices.EnrollmentRecord("m-1", "d", "srv-1", "Mac", 1))
        assertEquals(MachineRef("m-1"), records.asMachineResolver().byServerId("srv-1"))
        assertNull(records.asMachineResolver().byServerId("srv-2"))
    }
}

class TokenTest {
    private class Ports(token: Any? = DeviceToken("android", "fcm-1"), failSet: Boolean = false) {
        val sets = mutableListOf<Triple<String, String, DevicePlatform>>()
        val clears = mutableListOf<String>()
        val kv = MemoryKeyValueStore()
        val source = PushTokenSource {
            if (token is Exception) throw token
            token as DeviceToken?
        }
        val client = object : PushTokenClient {
            override suspend fun setPushToken(bearer: String, token: String, platform: DevicePlatform) {
                if (failSet) throw IllegalStateException("refused")
                sets += Triple(bearer, token, platform)
            }

            override suspend fun clearPushToken(bearer: String) {
                clears += bearer
            }
        }
    }

    private val target = TokenTarget("m-1", "ds-1", DevicePlatform.Android)
    private suspend fun register(p: Ports) = registerDeviceToken(target, p.source, p.client, p.kv)

    @Test
    fun `registers the raw token once, and again only when it changes`() = runTest {
        val p = Ports()
        assertEquals(TokenRegistration.Registered("fcm-1"), register(p))
        assertEquals(listOf(Triple("ds-1", "fcm-1", DevicePlatform.Android)), p.sets)
        assertEquals("fcm-1", p.kv.get(pushTokenKey("m-1")))
        assertEquals(TokenRegistration.Unchanged, register(p))
        assertEquals(1, p.sets.size)
        val changed = Ports(DeviceToken("android", "fcm-2"))
        changed.kv.set(pushTokenKey("m-1"), "fcm-1")
        assertEquals(TokenRegistration.Registered("fcm-2"), register(changed))
    }

    @Test
    fun `a platform without a native token, or one that refuses, is unsupported, not a failure`() = runTest {
        assertTrue(register(Ports(DeviceToken("web", null))) is TokenRegistration.Unsupported)
        assertTrue(register(Ports(DeviceToken("android", ""))) is TokenRegistration.Unsupported)
        assertTrue(register(Ports(IllegalStateException("no Firebase in this build"))) is TokenRegistration.Unsupported)
        assertTrue(register(Ports(null)) is TokenRegistration.Unsupported)
        val mismatch = Ports(DeviceToken("ios", "apns-1"))
        assertEquals(TokenRegistration.Unsupported("The token is ios's and the device registered as android."), register(mismatch))
        assertEquals(emptyList<Any>(), mismatch.sets)
    }

    @Test
    fun `a machine that refuses the token is a failure, and nothing is remembered`() = runTest {
        val p = Ports(failSet = true)
        assertEquals(TokenRegistration.Failed("refused"), register(p))
        assertNull(p.kv.get(pushTokenKey("m-1")))
    }

    @Test
    fun `clearing forgets the token on the machine and here`() = runTest {
        val p = Ports()
        register(p)
        clearDeviceToken("m-1", "ds-1", p.client, p.kv)
        assertEquals(listOf("ds-1"), p.clears)
        assertNull(p.kv.get(pushTokenKey("m-1")))
    }

    @Test
    fun `a token printed says nothing of its value`() {
        assertTrue("fcm-secret" !in DeviceToken("android", "fcm-secret").toString())
        assertTrue("fcm-secret" !in TokenRegistration.Registered("fcm-secret").toString())
        assertTrue("ds-secret" !in TokenTarget("m", "ds-secret", DevicePlatform.Android).toString())
    }
}

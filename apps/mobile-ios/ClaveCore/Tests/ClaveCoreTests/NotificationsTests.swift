import XCTest
@testable import ClaveCore

/// A machine's server for the notification logic, by script.
actor FakeNotificationServer: NotificationServer {
  var snapshot: Result<RequestSnapshot, ServerError>
  var accepted = true
  var writeAnswer: Result<WriteAnswer, ServerError> = .success(WriteAnswer(status: .accepted))
  var sessionAnswer: Result<Session, ServerError>?
  private(set) var resolved: [(String, RequestResponse)] = []
  private(set) var written: [(String, SessionWriteInput)] = []
  private(set) var sessionReads = 0

  init(pending: [PendingRequest] = []) {
    snapshot = .success(RequestSnapshot(revision: 1, pending: pending))
  }

  func configure(_ change: @Sendable (isolated FakeNotificationServer) -> Void) { change(self) }

  func pendingRequests() async throws -> RequestSnapshot { try snapshot.get() }

  func resolve(_ requestId: String, _ response: RequestResponse) async throws -> ResolveOutcome {
    resolved.append((requestId, response))
    return ResolveOutcome(accepted: accepted)
  }

  func write(_ sessionId: String, _ input: SessionWriteInput) async throws -> WriteAnswer {
    written.append((sessionId, input))
    return try writeAnswer.get()
  }

  func session(_ id: String) async throws -> Session {
    sessionReads += 1
    if let sessionAnswer { return try sessionAnswer.get() }
    return try ContractJSON.decode(Session.self, from: FakePushServer.sessionJSON)
  }
}

/// A resolver from a fixed table.
struct TableResolver: MachineResolver {
  let table: [String: String]
  func machineId(forServer serverId: String) async throws -> String? { table[serverId] }
}

/// Categories, payload, deep link, intents and answers: notifications.test.ts and handler.test.ts.
final class NotificationsTests: XCTestCase {
  let permission = NotificationPayload(
    category: .permission, serverId: "srv-1", serverName: "Valentin's Mac", sessionId: "s-1",
    sessionTitle: "Fix the flaky test", workspaceName: "clave", requestId: "r-1", text: "Run npm test in /Users/v/clave?",
    actions: [.allow, .deny, .open])
  var question: NotificationPayload {
    NotificationPayload(
      category: .question, serverId: "srv-1", serverName: "Valentin's Mac", sessionId: "s-1",
      sessionTitle: "Fix the flaky test", workspaceName: "clave", requestId: "r-2", text: "Which branch should the fix land on?",
      actions: [.reply, .open])
  }
  let pending = [
    PendingRequest(
      id: "r-1", sessionId: "s-1", kind: .permission, description: "Run npm test?", createdAt: 1,
      options: [PermissionOption(id: "approve", label: "Approve"), PermissionOption(id: "deny", label: "Deny")]),
    PendingRequest(
      id: "r-2", sessionId: "s-1", kind: .clarification, description: "Which branch?", createdAt: 2,
      questions: [AgentQuestion(id: "q-branch", question: "Which branch should the fix land on?", options: [])]),
  ]
  let tap = "com.apple.UNNotificationDefaultActionIdentifier"

  private func payloadJSON(_ payload: NotificationPayload) -> String { try! ContractJSON.encodeToString(payload) }

  // MARK: the categories

  func testDeclaresAllowAndDenyOnAPermissionAReplyFieldOnAQuestionATapElsewhere() throws {
    let declared = notificationCategories()
    XCTAssertEqual(declared.map(\.identifier), [
      "clave.question", "clave.permission", "clave.secret", "clave.finished", "clave.failed", "clave.account_limit", "clave.test",
    ])
    let permission = try XCTUnwrap(declared.first { $0.category == .permission })
    XCTAssertEqual(permission.actions.map(\.identifier), ["clave.allow", "clave.deny"])
    XCTAssertEqual(permission.actions.map(\.title), ["Allow", "Deny"])
    XCTAssertTrue(permission.actions[0].requiresAuthentication)
    XCTAssertFalse(permission.actions[0].opensApp)
    XCTAssertTrue(permission.actions[1].destructive)
    XCTAssertFalse(permission.actions[1].requiresAuthentication)
    let question = try XCTUnwrap(declared.first { $0.category == .question })
    XCTAssertEqual(question.actions.map(\.title), ["Reply"])
    XCTAssertTrue(question.actions[0].takesTextInput)
    XCTAssertEqual(question.actions[0].textInputButtonTitle, "Send")
    XCTAssertEqual(question.actions[0].textInputPlaceholder, "Your answer")
    for other in declared where other.category != .permission && other.category != .question {
      XCTAssertEqual(other.actions, [], other.identifier)
    }
    XCTAssertEqual(NotificationAction.allCases.map(\.spec.title), ["Allow", "Deny", "Reply", "Open"])
    XCTAssertEqual(NotificationAction.allCases.filter(\.spec.takesTextInput), [.reply])
  }

  func testReadsACategoryOffTheNotificationsOwnIdentifier() {
    XCTAssertEqual(notificationCategory(ofIdentifier: "clave.question"), .question)
    XCTAssertEqual(notificationCategory(ofIdentifier: "clave.account_limit"), .accountLimit)
    XCTAssertNil(notificationCategory(ofIdentifier: "clave.party"))
    XCTAssertNil(notificationCategory(ofIdentifier: "other.question"))
    XCTAssertNil(notificationCategory(ofIdentifier: nil))
    XCTAssertEqual(NotificationAction(identifier: "clave.reply"), .reply)
    XCTAssertNil(NotificationAction(identifier: tap))
  }

  // MARK: the payload (h)

  func testReadsThePayloadFromADictionaryUnderTheClaveKey() throws {
    let dictionary = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(payloadJSON(permission).utf8)) as? [String: Any])
    let userInfo: [AnyHashable: Any] = [
      "aps": ["alert": ["title": "Fix the flaky test", "body": "Run?"], "category": "clave.permission"],
      "clave": dictionary,
    ]
    XCTAssertEqual(notificationPayload(from: userInfo), permission)
  }

  func testReadsThePayloadFromAJSONString() {
    XCTAssertEqual(notificationPayload(from: ["clave": payloadJSON(question)]), question)
  }

  func testDropsAnUnknownActionAndRefusesWhatIsNotClaves() {
    let raw = #"{"category":"permission","serverId":"srv-1","serverName":"M","sessionId":"s-1","sessionTitle":"T","requestId":"r-1","text":"Run?","actions":["jump","allow","later"]}"#
    XCTAssertEqual(notificationPayload(from: ["clave": raw])?.actions, [.allow])
    XCTAssertNil(notificationPayload(from: ["aps": ["alert": "hi"]]))
    XCTAssertNil(notificationPayload(from: ["clave": "not json"]))
    XCTAssertNil(notificationPayload(from: ["clave": #"{"category":"party","serverId":"x"}"#]))
    XCTAssertNil(notificationPayload(from: ["clave": 42]))
    XCTAssertNil(notificationPayload(from: ["clave": raw.replacingOccurrences(of: #""serverId":"srv-1""#, with: #""serverId":"""#)]))
  }

  // MARK: the deep link (g)

  func testTheDeepLinkRoundTripsIdsThatNeedPercentEncoding() throws {
    let chat = DeepLink.chat(machineId: "dev:127.0.0.1:43201", sessionId: "clave/1 2?x#y%z")
    XCTAssertEqual(chat.url.absoluteString, "clave-ios://chat/dev%3A127.0.0.1%3A43201/clave%2F1%202%3Fx%23y%25z")
    XCTAssertEqual(DeepLink.parse(chat.url), chat)
    let request = DeepLink.request(machineId: "vps 1", requestId: "3a9e/é")
    XCTAssertTrue(request.url.absoluteString.hasPrefix("clave-ios://requests/vps%201/3a9e%2F"))
    XCTAssertEqual(DeepLink.parse(request.url), request)
    XCTAssertEqual(DeepLink.parse(try XCTUnwrap(URL(string: "clave-ios://chat/m-1/s-1"))), .chat(machineId: "m-1", sessionId: "s-1"))
  }

  func testTheDeepLinkRefusesWhatIsNotOneOfTheApps() {
    for text in [
      "clave://chat/m/s", "clave-ios://chat/m", "clave-ios://chat/m/s/extra", "clave-ios://other/m/s", "clave-ios://chat//s",
      "https://example.com/chat/m/s", "clave-ios://chat",
    ] {
      XCTAssertNil(DeepLink.parse(URL(string: text)!), text)
    }
  }

  // MARK: the intents and the answers

  func testATapOpensAndAnActionThePayloadOffersIsThatAction() {
    XCTAssertEqual(interpretNotification(permission, actionIdentifier: tap, userText: nil), .open(permission))
    XCTAssertEqual(interpretNotification(permission, actionIdentifier: "clave.allow", userText: nil), .allow(permission))
    XCTAssertEqual(interpretNotification(permission, actionIdentifier: "clave.deny", userText: nil), .deny(permission))
    XCTAssertEqual(interpretNotification(question, actionIdentifier: "clave.reply", userText: " main "), .reply(question, text: "main"))
    XCTAssertEqual(interpretNotification(question, actionIdentifier: "clave.open", userText: nil), .open(question))
  }

  func testAnActionThePayloadDidNotOfferOrAReplyWithoutTextIsAnOpen() {
    XCTAssertEqual(interpretNotification(question, actionIdentifier: "clave.allow", userText: nil), .open(question))
    XCTAssertEqual(interpretNotification(permission, actionIdentifier: "clave.reply", userText: "x"), .open(permission))
    XCTAssertEqual(interpretNotification(question, actionIdentifier: "clave.reply", userText: "  "), .open(question))
  }

  func testAnswersWithTheRequestsOwnOptionIdsTheClaudeOnesWhenNoneAreKnown() {
    let claude = [PermissionOption(id: "allow-once", label: "Allow"), PermissionOption(id: "allow-always", label: "Always"), PermissionOption(id: "deny", label: "Deny")]
    XCTAssertEqual(permissionOptionId(claude, allow: true), "allow-once")
    XCTAssertEqual(permissionOptionId(claude, allow: false), "deny")
    let mcp = [PermissionOption(id: "approve", label: "Approve"), PermissionOption(id: "deny", label: "Deny")]
    XCTAssertEqual(permissionOptionId(mcp, allow: true), "approve")
    XCTAssertEqual(permissionOptionId(nil, allow: true), "allow-once")
    XCTAssertEqual(permissionOptionId(nil, allow: false), "deny")
  }

  func testKeysAReplyByTheQuestionsIdElseItsTextAndANativeQuestionAnswersAsAPermission() {
    XCTAssertEqual(replyResponse(pending[1], text: "main"), .clarification(answers: ["q-branch": "main"]))
    let noId = PendingRequest(
      id: "r-2", sessionId: "s-1", kind: .clarification, description: "Which branch?", createdAt: 2,
      questions: [AgentQuestion(question: "Which branch?", options: [])])
    XCTAssertEqual(replyResponse(noId, text: "main"), .clarification(answers: ["Which branch?": "main"]))
    let native = PendingRequest(
      id: "r-3", sessionId: "s-1", kind: .clarification, description: "Q", createdAt: 3, providerRequestId: "p-1",
      questions: [AgentQuestion(id: "q1", question: "Which branch?", options: [])])
    XCTAssertEqual(replyResponse(native, text: "main"), .permission(optionId: "answer", answers: ["q1": "main"]))
    let two = PendingRequest(
      id: "r-4", sessionId: "s-1", kind: .clarification, description: "Q", createdAt: 4,
      questions: [AgentQuestion(id: "a", question: "A?", options: []), AgentQuestion(id: "b", question: "B?", options: [])])
    XCTAssertNil(replyResponse(two, text: "x"))
    XCTAssertNil(replyResponse(PendingRequest(id: "r-5", sessionId: "s-1", kind: .clarification, description: "Q", createdAt: 5), text: "x"))
  }

  // MARK: settling from the notification (i)

  func testAllowResolvesWithTheRequestsOwnOptionIdThroughTheResolveRoute() async {
    let server = FakeNotificationServer(pending: pending)
    let outcome = await settleFromNotification(.allow(permission), server: server)
    XCTAssertEqual(outcome, .settled)
    let resolved = await server.resolved
    XCTAssertEqual(resolved.map(\.0), ["r-1"])
    XCTAssertEqual(resolved.map(\.1), [.permission(optionId: "approve", answers: nil)])
  }

  func testDenyResolvesTheSameWay() async {
    let server = FakeNotificationServer(pending: pending)
    let outcome = await settleFromNotification(.deny(permission), server: server)
    XCTAssertEqual(outcome, .settled)
    let resolved = await server.resolved
    XCTAssertEqual(resolved.map(\.1), [.permission(optionId: "deny", answers: nil)])
  }

  func testReplyAnswersTheOneQuestionKeyedAsTheServerReadsIt() async {
    let server = FakeNotificationServer(pending: pending)
    let outcome = await settleFromNotification(.reply(question, text: "main"), server: server)
    XCTAssertEqual(outcome, .settled)
    let resolved = await server.resolved
    XCTAssertEqual(resolved.map(\.0), ["r-2"])
    XCTAssertEqual(resolved.map(\.1), [.clarification(answers: ["q-branch": "main"])])
  }

  func testAFirstAnswerFromElsewhereIsAlreadySettled() async {
    let refused = FakeNotificationServer(pending: pending)
    await refused.configure { $0.accepted = false }
    let refusedOutcome = await settleFromNotification(.allow(permission), server: refused)
    XCTAssertEqual(refusedOutcome, .alreadySettled)
    let gone = FakeNotificationServer(pending: [])
    let goneOutcome = await settleFromNotification(.allow(permission), server: gone)
    XCTAssertEqual(goneOutcome, .alreadySettled)
    let resolved = await gone.resolved
    XCTAssertTrue(resolved.isEmpty)
  }

  func testWhatTheNotificationCannotSettleOpensTheApp() async {
    let server = FakeNotificationServer(pending: pending)
    let opened = await settleFromNotification(.open(permission), server: server)
    guard case .openApp = opened else { return XCTFail("\(opened)") }
    let noRequest = NotificationPayload(
      category: .permission, serverId: "srv-1", serverName: "M", sessionId: "s-1", sessionTitle: "T", text: "Run?", actions: [.allow])
    let unnamed = await settleFromNotification(.allow(noRequest), server: server)
    guard case .openApp = unnamed else { return XCTFail("\(unnamed)") }
    let twoQuestions = FakeNotificationServer(pending: [
      PendingRequest(
        id: "r-2", sessionId: "s-1", kind: .clarification, description: "Q", createdAt: 2,
        questions: [AgentQuestion(id: "a", question: "A?", options: []), AgentQuestion(id: "b", question: "B?", options: [])])
    ])
    let complex = await settleFromNotification(.reply(question, text: "x"), server: twoQuestions)
    guard case .openApp = complex else { return XCTFail("\(complex)") }
    let permanentOnly = FakeNotificationServer(pending: [
      PendingRequest(
        id: "r-1", sessionId: "s-1", kind: .permission, description: "Run?", createdAt: 1,
        options: [PermissionOption(id: "allow-always", label: "Always")])
    ])
    let permanent = await settleFromNotification(.allow(permission), server: permanentOnly)
    XCTAssertEqual(permanent, .openApp(reason: "Choose the permission in the app."))
    let moved = FakeNotificationServer(pending: [
      PendingRequest(id: "r-1", sessionId: "s-9", kind: .permission, description: "Run?", createdAt: 1)
    ])
    let mismatch = await settleFromNotification(.allow(permission), server: moved)
    guard case .openApp = mismatch else { return XCTFail("\(mismatch)") }
    for fake in [server, twoQuestions, permanentOnly, moved] {
      let resolved = await fake.resolved
      XCTAssertTrue(resolved.isEmpty)
    }
  }

  func testOnAServerWithoutTheRequestsPortAllowAndDenyGoThroughTheWriteRoute() async {
    let unavailable = ServerError(
      .refused, "No requests here.", status: 422,
      failure: ServerFailure(tag: "CapabilityUnavailable", message: "No requests here.", capability: "requests"))
    let server = FakeNotificationServer()
    await server.configure { $0.snapshot = .failure(unavailable) }
    let allowed = await settleFromNotification(.allow(permission), server: server)
    XCTAssertEqual(allowed, .settled)
    let written = await server.written
    XCTAssertEqual(written.map(\.0), ["s-1"])
    XCTAssertEqual(written.map(\.1), [.permissionResponse(PermissionResponse(id: "r-1", optionId: "allow-once"))])
    let reply = await settleFromNotification(.reply(question, text: "x"), server: server)
    guard case .openApp = reply else { return XCTFail("\(reply)") }
    await server.configure { $0.writeAnswer = .success(WriteAnswer(status: .pending)) }
    let stillPending = await settleFromNotification(.deny(permission), server: server)
    guard case .openApp = stillPending else { return XCTFail("\(stillPending)") }
    await server.configure { $0.writeAnswer = .failure(ServerError(.refused, "Not waiting.", status: 422)) }
    let refused = await settleFromNotification(.deny(permission), server: server)
    XCTAssertEqual(refused, .alreadySettled)
  }

  func testAMachineThatCannotBeReachedIsAFailureNotASettledAnswer() async {
    let server = FakeNotificationServer()
    await server.configure { $0.snapshot = .failure(ServerError(.network, "The server could not be reached.")) }
    let outcome = await settleFromNotification(.allow(permission), server: server)
    XCTAssertEqual(outcome, .failed(reason: "The server could not be reached."))
    let resolved = await server.resolved
    XCTAssertTrue(resolved.isEmpty)
  }

  // MARK: the destination

  func testWhereAPayloadTakesTheApp() {
    XCTAssertEqual(notificationDestination(permission, machineId: "m-1"), .chat(machineId: "m-1", sessionId: "s-1", title: "Fix the flaky test"))
    XCTAssertEqual(notificationDestination(question, machineId: "m-1", target: .request), .requests(machineId: "m-1", requestId: "r-2"))
    let limit = NotificationPayload(
      category: .accountLimit, serverId: "srv-1", serverName: "M", sessionId: "", sessionTitle: "", text: "5% left", actions: [.open])
    XCTAssertEqual(notificationDestination(limit, machineId: "m-1"), .workspaces(machineId: "m-1"))
    XCTAssertEqual(notificationDestination(permission, machineId: nil), .machines(reason: "Valentin's Mac is not paired with this phone."))
    XCTAssertEqual(
      NotificationDestination.chat(machineId: "m-1", sessionId: "s-1", title: "T").deepLink, .chat(machineId: "m-1", sessionId: "s-1"))
    XCTAssertEqual(NotificationDestination.requests(machineId: "m-1", requestId: "r-1").deepLink, .request(machineId: "m-1", requestId: "r-1"))
    XCTAssertNil(NotificationDestination.workspaces(machineId: "m-1").deepLink)
  }

  // MARK: the handler

  private func credentials(_ entries: [String: Credential] = ["machine": Credential(serverUrl: "https://relay.example/m/machine", bearer: "fixture-device-session")]) async throws -> SecureCredentialStore {
    let store = SecureCredentialStore(InMemorySecureStore())
    for (id, credential) in entries { try await store.set(id, credential) }
    return store
  }

  func testAnUnpairedServerCannotUseAnotherMachinesCredentialToAnswer() async throws {
    let made = Counter()
    let outcome = await respondToNotification(
      permission, actionIdentifier: "clave.allow", userText: nil, machines: TableResolver(table: [:]),
      credentials: try await credentials(), server: { _ in _ = made.next(); return FakeNotificationServer() })
    XCTAssertEqual(made.count, 0)
    XCTAssertEqual(outcome, .open(.machines(reason: "Valentin's Mac is not paired with this phone.")))
  }

  func testAPairedMachineWithoutACredentialSaysToPairAgain() async throws {
    let outcome = await respondToNotification(
      permission, actionIdentifier: tap, userText: nil, machines: TableResolver(table: ["srv-1": "machine"]),
      credentials: try await credentials([:]), server: { _ in FakeNotificationServer() })
    XCTAssertEqual(outcome, .open(.machines(reason: "Pair this phone again.")))
  }

  func testAnswersThePairedServerThroughItsOwnDeviceCredential() async throws {
    let server = FakeNotificationServer(pending: [
      PendingRequest(
        id: "r-1", sessionId: "s-1", kind: .permission, description: "Run?", createdAt: 1,
        options: [PermissionOption(id: "allow-once", label: "Allow"), PermissionOption(id: "deny", label: "Deny")])
    ])
    let seen = Counter()
    let outcome = await respondToNotification(
      permission, actionIdentifier: "clave.allow", userText: nil, machines: TableResolver(table: ["srv-1": "machine"]),
      credentials: try await credentials(),
      server: { credential in
        XCTAssertEqual(credential.bearer, "fixture-device-session")
        _ = seen.next()
        return server
      })
    XCTAssertEqual(outcome, .settled)
    XCTAssertEqual(seen.count, 1)
    let resolved = await server.resolved
    XCTAssertEqual(resolved.map(\.1), [.permission(optionId: "allow-once", answers: nil)])
  }

  func testAPermanentOnlyPermissionOpensTheAppOnItsRequest() async throws {
    let server = FakeNotificationServer(pending: [
      PendingRequest(
        id: "r-1", sessionId: "s-1", kind: .permission, description: "Run?", createdAt: 1,
        options: [PermissionOption(id: "allow-always", label: "Always")])
    ])
    let outcome = await respondToNotification(
      permission, actionIdentifier: "clave.allow", userText: nil, machines: TableResolver(table: ["srv-1": "machine"]),
      credentials: try await credentials(), server: { _ in server })
    XCTAssertEqual(outcome, .open(.requests(machineId: "machine", requestId: "r-1")))
    let resolved = await server.resolved
    XCTAssertTrue(resolved.isEmpty)
  }

  func testAnOfferedButtonThatCannotSettleAComplexQuestionOpensItsRequest() async throws {
    let complex = NotificationPayload(
      category: .question, serverId: "srv-1", serverName: "M", sessionId: "s-1", sessionTitle: "Chat", requestId: "r-2",
      text: "Choose two options", actions: [.open])
    let server = FakeNotificationServer()
    let outcome = await respondToNotification(
      complex, actionIdentifier: "clave.reply", userText: "x", machines: TableResolver(table: ["srv-1": "machine"]),
      credentials: try await credentials(), server: { _ in server })
    XCTAssertEqual(outcome, .open(.requests(machineId: "machine", requestId: "r-2")))
    let resolved = await server.resolved
    XCTAssertTrue(resolved.isEmpty)
  }

  func testOpenNavigatesToTheConversation() async throws {
    let server = FakeNotificationServer()
    let outcome = await respondToNotification(
      permission, actionIdentifier: tap, userText: nil, machines: TableResolver(table: ["srv-1": "machine"]),
      credentials: try await credentials(), server: { _ in server })
    XCTAssertEqual(outcome, .open(.chat(machineId: "machine", sessionId: "s-1", title: "Fix the flaky test")))
    let reads = await server.sessionReads
    XCTAssertEqual(reads, 1)
  }

  func testWhenTheSessionIsGoneTheAppOpensOnTheMachinesRequests() async throws {
    for gone in [
      ServerError(.refused, "The server refused (SessionNotFound).", status: 422, failure: ServerFailure(tag: "SessionNotFound", message: "gone", id: "s-1")),
      ServerError(.notFound, "The server has no such route.", status: 404),
    ] {
      let server = FakeNotificationServer()
      await server.configure { $0.sessionAnswer = .failure(gone) }
      let outcome = await respondToNotification(
        permission, actionIdentifier: tap, userText: nil, machines: TableResolver(table: ["srv-1": "machine"]),
        credentials: try await credentials(), server: { _ in server })
      XCTAssertEqual(outcome, .open(.requests(machineId: "machine", requestId: "r-1")))
    }
    let offline = FakeNotificationServer()
    await offline.configure { $0.sessionAnswer = .failure(ServerError(.network, "The server could not be reached.")) }
    let unreachable = await respondToNotification(
      permission, actionIdentifier: tap, userText: nil, machines: TableResolver(table: ["srv-1": "machine"]),
      credentials: try await credentials(), server: { _ in offline })
    XCTAssertEqual(unreachable, .open(.chat(machineId: "machine", sessionId: "s-1", title: "Fix the flaky test")))
  }

  func testAPushThatIsNotClavesIsIgnored() async throws {
    let outcome = await respondToNotification(
      nil, actionIdentifier: tap, userText: nil, machines: TableResolver(table: [:]), credentials: try await credentials(),
      server: { _ in FakeNotificationServer() })
    XCTAssertEqual(outcome, .ignored)
  }

  func testAFailedAnswerOpensTheAppOnTheRequest() async throws {
    let server = FakeNotificationServer()
    await server.configure { $0.snapshot = .failure(ServerError(.network, "The server could not be reached.")) }
    let outcome = await respondToNotification(
      permission, actionIdentifier: "clave.deny", userText: nil, machines: TableResolver(table: ["srv-1": "machine"]),
      credentials: try await credentials(), server: { _ in server })
    XCTAssertEqual(outcome, .open(.requests(machineId: "machine", requestId: "r-1")))
  }
}

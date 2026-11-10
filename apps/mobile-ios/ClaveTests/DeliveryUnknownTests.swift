@testable import ClaveCore
import XCTest
@testable import Clave

// While a send's outcome is unknown, a second logical message (a plain send under a new id) is
// refused until the person chooses on the bar; the bounded reconciliation of the same id stays.
// Driven at the model-to-transport boundary against ChatModelTests' in-process server, wrapped so
// an answer can be lost after the server kept the message or before it did, the status route can
// be unreadable or answer per id, and the messages the server kept can be read back.

/// ChatModelTests' in-process server with the delivery cases on top.
final class DeliveryChatServer: HTTPTransport, WebSocketTransport, @unchecked Sendable {
  enum Write: Equatable, Sendable {
    /// The server keeps the message and answers.
    case accept
    /// The server keeps the message; its answer is lost on the way back.
    case keepThenLose
    /// The write never reaches the server: nothing kept, the answer lost.
    case loseBeforeKept
    /// The write waits until the test lets it through (`releaseHeldWrites`), then is kept.
    case hold
  }

  enum Status: Equatable, Sendable {
    /// The status route cannot be read.
    case unreadable
    /// The server's answer about the id.
    case answer(String)
    /// The read waits until the test answers it (`answerHeldStatus`).
    case held
  }

  /// The timeline, the capabilities and the push channel are its.
  let chat = FakeChatServer()
  private let lock = NSLock()
  private var plan: [Write] = []
  private var statuses: [String: Status] = [:]
  private var fallback: Status = .answer("unknown")
  private var _attempts: [String] = []
  private var _kept: [String] = []
  private var _asks: [String] = []
  private var heldWrites: [CheckedContinuation<Void, Never>] = []
  private var heldReads: [String: CheckedContinuation<Status, Never>] = [:]
  private var holdingUploads = false
  private var heldUploads: [CheckedContinuation<Void, Never>] = []
  private var _uploads = 0

  /// The id of every write that left the phone, in order, a lost one included.
  var attempts: [String] { lock.withLock { _attempts } }
  /// The id of every message the server kept, in order: what reached the agent.
  var kept: [String] { lock.withLock { _kept } }
  /// The id of every status read, in order.
  var asks: [String] { lock.withLock { _asks } }

  /// The next writes' fates; once spent, a write is accepted.
  func planWrites(_ writes: Write...) { lock.withLock { plan.append(contentsOf: writes) } }
  /// What the status route says about one id.
  func answerStatus(_ status: Status, for id: String) { lock.withLock { statuses[id] = status } }
  /// What it says about any other id.
  func answerStatusByDefault(_ status: Status) { lock.withLock { fallback = status } }

  /// How many writes wait to be let through.
  var writesHeld: Int { lock.withLock { heldWrites.count } }
  /// Lets the waiting writes through, in the order they came.
  func releaseHeldWrites() {
    let waiting = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
      defer { heldWrites = [] }
      return heldWrites
    }
    for write in waiting { write.resume() }
  }

  /// Whether a status read about this id waits for its answer.
  func isHoldingStatus(of id: String) -> Bool { lock.withLock { heldReads[id] != nil } }
  /// Answers the waiting status read about this id.
  func answerHeldStatus(of id: String, _ status: Status) {
    let read = lock.withLock { heldReads.removeValue(forKey: id) }
    read?.resume(returning: status)
  }

  /// Every file upload from now on waits until `releaseHeldUploads`.
  func holdUploads() { lock.withLock { holdingUploads = true } }
  /// How many uploads wait; and how many reached the server in all.
  var uploadsHeld: Int { lock.withLock { heldUploads.count } }
  var uploads: Int { lock.withLock { _uploads } }
  /// Lets the waiting uploads through and holds no more.
  func releaseHeldUploads() {
    let waiting = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
      holdingUploads = false
      defer { heldUploads = [] }
      return heldUploads
    }
    for upload in waiting { upload.resume() }
  }

  func perform(_ request: URLRequest) async throws -> HTTPAnswer {
    let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
    switch (request.httpMethod ?? "GET", components.path) {
    case ("POST", "/sessions/write"):
      return try await write(request)
    case ("GET", "/sessions/writes"):
      let id = components.queryItems?.first { $0.name == "clientMessageId" }?.value ?? ""
      var status = lock.withLock { () -> Status in
        _asks.append(id)
        return statuses[id] ?? fallback
      }
      if status == .held {
        status = await withCheckedContinuation { read in lock.withLock { heldReads[id] = read } }
      }
      switch status {
      case .unreadable, .held:
        throw URLError(.networkConnectionLost)
      case .answer(let value):
        return HTTPAnswer(status: 200, headers: ["Content-Type": "application/json"], body: Data(#"{"status":"\#(value)"}"#.utf8))
      }
    case ("POST", "/files/attachments/prepare"):
      let hold = lock.withLock { () -> Bool in
        _uploads += 1
        return holdingUploads
      }
      if hold { await withCheckedContinuation { upload in lock.withLock { heldUploads.append(upload) } } }
      return HTTPAnswer(
        status: 200, headers: ["Content-Type": "application/json"],
        body: Data(#"{"id":"f-1","path":"/tmp/scratch/notes.txt","name":"notes.txt","mimeType":"text/plain","size":12,"delivery":"reference"}"#.utf8))
    default:
      return try await chat.perform(request)
    }
  }

  private func write(_ request: URLRequest) async throws -> HTTPAnswer {
    let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any] ?? [:]
    let input = body["input"] as? [String: Any] ?? [:]
    let id = input["clientMessageId"] as? String ?? ""
    let fate = lock.withLock { () -> Write in
      _attempts.append(id)
      return plan.isEmpty ? .accept : plan.removeFirst()
    }
    if fate == .loseBeforeKept { throw URLError(.networkConnectionLost) }
    if fate == .hold { await withCheckedContinuation { write in lock.withLock { heldWrites.append(write) } } }
    // The chat server keeps the message in its timeline and pushes it, as a server would.
    let answer = try await chat.perform(request)
    if input["type"] as? String == "user_message", answer.status == 200 { lock.withLock { _kept.append(id) } }
    if fate == .keepThenLose { throw URLError(.networkConnectionLost) }
    return answer
  }

  func connect(_ url: URL, headers: [String: String]) async throws -> any WebSocketConnection {
    let socket = try await chat.connect(url, headers: headers)
    guard let fake = socket as? FakeChatSocket else { return socket }
    return AnySessionSocket(fake)
  }
}

/// A socket of the chat server that also acknowledges a subscription to a session other than
/// s1 (the chat server answers s1's alone), for a second conversation of the machine.
final class AnySessionSocket: WebSocketConnection, @unchecked Sendable {
  private let inner: FakeChatSocket

  init(_ inner: FakeChatSocket) {
    self.inner = inner
  }

  func send(_ text: String) async throws {
    if let frame = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
      frame["_tag"] as? String == "subscribe", let id = frame["sessionId"] as? String, id != "s1"
    {
      let session = FakeChatServer.sessionJSON.replacingOccurrences(of: #""id":"s1""#, with: #""id":"\#(id)""#)
      inner.feed(#"{"_tag":"subscribed","sessionId":"\#(id)","session":\#(session)}"#)
      return
    }
    try await inner.send(text)
  }

  func receive() async throws -> WebSocketMessage { try await inner.receive() }

  func close(code: Int) { inner.close(code: code) }
}

@MainActor
final class DeliveryUnknownTests: XCTestCase {
  private var server: DeliveryChatServer!
  private var push: PushClient!
  private var store: InMemoryKeyValueStore!
  private var parts: MachineDeliveryParts!
  private var models: [ConversationModel] = []

  /// Another conversation's send, put last in the ledger before each reconnection and answered
  /// unknown, so every pass asks about it after every send before it and keeps it.
  private let sentinelId = "m-sentinel-0000000000000000"

  private let session = Session(
    id: "s1", provider: "claude", transport: .events, cwd: "/tmp/scratch", windowKey: "server", state: .idle,
    createdAt: 1, adapterId: "claude-chat", title: "Seeded chat")

  override func setUp() async throws {
    server = DeliveryChatServer()
    store = InMemoryKeyValueStore()
    parts = MachineDeliveryParts(store: store)
    // A reconnection's backoff (a second at most) passes at once; the liveness timers are real
    // and far longer than any test.
    push = try PushClient(
      url: "https://fake.invalid", bearer: { "device-token" }, transport: server,
      sleep: { seconds in
        if seconds <= 1 { return }
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
      })
  }

  override func tearDown() async throws {
    for model in models { model.disappear() }
    models = []
    await push.stop()
  }

  private func makeModel() throws -> ConversationModel {
    let client = try ClaveServerClient(baseURL: "https://fake.invalid", bearer: { "device-token" }, transport: server)
    let push: PushClient = self.push
    let model = ConversationModel(
      machineId: "m1", session: session, client: client, push: push,
      events: { TestPushFanout.shared(for: push).stream() }, delivery: parts.delivery, drafts: parts.drafts,
      attachmentDrafts: parts.attachmentDrafts)
    models.append(model)
    return model
  }

  private func until(_ what: String, timeout: TimeInterval = 20, _ condition: () -> Bool) async {
    let start = Date()
    while Date().timeIntervalSince(start) < timeout {
      if condition() { return }
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
    XCTFail("Timed out waiting for \(what)")
  }

  /// This conversation's sends in the ledger (the sentinel is another conversation's).
  private func ledger() async throws -> [String] {
    try await UnknownSends(store: store).forSession("m1", "s1").map(\.clientMessageId)
  }

  /// A send nobody can tell the outcome of: the write's answer lost, kept by the server or not,
  /// and the status route unreadable. Returns the id it went out under.
  private func unknownSend(_ model: ConversationModel, _ text: String, kept: Bool) async -> String {
    server.planWrites(kept ? .keepThenLose : .loseBeforeKept)
    server.answerStatusByDefault(.unreadable)
    model.draft = text
    await model.send()
    XCTAssertEqual(server.attempts.count, 1, "one write")
    XCTAssertEqual(model.deliveryMark?.kind, .unknown, "the bar shows")
    return server.attempts.first ?? ""
  }

  /// Drops the push socket, and waits until the model's own reconnection pass has gone through
  /// the whole ledger: the sentinel, last in it, has been asked about once more.
  private func reconnectionPass() async throws {
    try await UnknownSends(store: store).add(
      UnknownSend(machineId: "m1", sessionId: "s-sentinel", clientMessageId: sentinelId, text: "another conversation", at: 1))
    server.answerStatus(.answer("unknown"), for: sentinelId)
    let asked = server.asks.filter { $0 == sentinelId }.count
    let sockets = server.chat.sockets.count
    server.chat.sockets.last?.feed(.closed(code: 1006, reason: "gone"))
    await until("the socket reopened") { server.chat.sockets.count == sockets + 1 }
    await until("the pass reached the end of the ledger") { server.asks.filter { $0 == sentinelId }.count == asked + 1 }
    let now = server.asks.filter { $0 == sentinelId }.count
    if now != asked + 1 {
      XCTFail("the pass: sentinel asked \(now) times (\(asked) before), \(server.chat.sockets.count) sockets, \(server.asks.count) status reads")
    }
    // The sentinel's status read is seen before the pass has settled it and returned; a
    // reconnection arriving before the pass let go of the machine would join it, not run its own.
    let start = Date()
    while await parts.delivery.isReconnecting("m1"), Date().timeIntervalSince(start) < 20 {
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
    let running = await parts.delivery.isReconnecting("m1")
    XCTAssertFalse(running, "the pass never let go of the machine")
  }

  // MARK: - The table, same id

  /// Accepted but unacknowledged: the server kept the write and its answer was lost; the status
  /// read says accepted. Sent, one write, one id.
  func testAWriteKeptWithItsAnswerLostIsSentOnceUnderOneId() async throws {
    let model = try makeModel()
    await model.appear()
    server.planWrites(.keepThenLose)
    server.answerStatusByDefault(.answer("accepted"))
    model.draft = "Kept, the answer lost."
    await model.send()
    let ids = server.attempts
    XCTAssertEqual(ids.count, 1, "exactly one write")
    XCTAssertEqual(server.kept, ids, "the server holds the one message")
    XCTAssertEqual(server.asks, ids, "asked once, about that id")
    XCTAssertNil(model.deliveryMark)
    XCTAssertNil(model.sendError)
    XCTAssertEqual(model.draft, "")
    let ledger = try await ledger()
    XCTAssertEqual(ledger, [])
  }

  /// Absent: the answer lost and the server never kept the write; the status says absent. The one
  /// same-id retry writes it under the original id: one message on the server, no new id.
  func testAWriteTheServerNeverKeptIsCompletedOnceUnderTheOriginalId() async throws {
    let model = try makeModel()
    await model.appear()
    server.planWrites(.loseBeforeKept, .accept)
    server.answerStatusByDefault(.answer("absent"))
    model.draft = "Never arrived."
    await model.send()
    let ids = server.attempts
    XCTAssertEqual(ids.count, 2, "the write and its one same-id retry")
    XCTAssertEqual(Set(ids).count, 1, "the retry carries the original id, never a new one")
    XCTAssertEqual(server.kept, [ids[0]], "the server holds exactly one message")
    XCTAssertEqual(server.asks, [ids[0]])
    XCTAssertNil(model.deliveryMark)
    XCTAssertEqual(model.draft, "")
    let ledger = try await ledger()
    XCTAssertEqual(ledger, [])
  }

  // MARK: - Unknown: no second message

  /// The status unreadable: the bar shows, the Send arrow is off, a send writes nothing, and the
  /// draft stays exactly as typed.
  func testWhileTheOutcomeIsUnknownASecondMessageWritesNothingAndTheDraftStays() async throws {
    let model = try makeModel()
    await model.appear()
    let typed = "  Did it land?\n"
    let id = await unknownSend(model, typed, kept: false)
    XCTAssertEqual(model.deliveryMark?.clientMessageId, id)
    XCTAssertEqual(model.draft, typed)
    XCTAssertFalse(model.canSend, "the Send arrow is off while the bar shows, with a draft to send")
    let asks = server.asks.count
    await model.send()
    XCTAssertEqual(server.attempts, [id], "the refused send wrote nothing")
    XCTAssertEqual(server.asks.count, asks, "nor asked anything")
    XCTAssertEqual(model.draft, typed, "the draft stays exactly as typed")
    XCTAssertEqual(model.deliveryMark?.kind, .unknown)
    XCTAssertEqual(model.deliveryMark?.clientMessageId, id)
    XCTAssertNil(model.sendError)
    let ledger = try await ledger()
    XCTAssertEqual(ledger, [id], "the unknown send is still the conversation's")
  }

  /// The mark in the store, none in memory yet (a fresh model over the same store): the send reads
  /// the stored mark, shows the bar and writes nothing; it discards nothing by itself.
  func testAStoredUnknownMarkRefusesTheSendOfAModelThatHadNotReadIt() async throws {
    let first = try makeModel()
    await first.appear()
    let id = await unknownSend(first, "Did it land?", kept: false)
    first.disappear()

    let fresh = try makeModel()
    XCTAssertNil(fresh.deliveryMark)
    fresh.draft = "Another message"
    XCTAssertTrue(fresh.canSend, "nothing in memory says the outcome is unknown")
    await fresh.send()
    XCTAssertEqual(server.attempts, [id], "the second message wrote nothing")
    XCTAssertEqual(fresh.deliveryMark?.kind, .unknown, "the bar shows")
    XCTAssertEqual(fresh.deliveryMark?.clientMessageId, id)
    XCTAssertFalse(fresh.canSend)
    XCTAssertEqual(fresh.draft, "Another message", "the draft stays exactly as typed")
    let ledger = try await ledger()
    XCTAssertEqual(ledger, [id], "nothing discarded by itself")
    let stored = try await DeliveryMarks(store: store).get("m1", "s1")
    XCTAssertEqual(stored?.kind, .unknown)
    XCTAssertEqual(stored?.clientMessageId, id)
  }

  /// A reconnection pass with the status readable settles the unknown send under its original id:
  /// accepted, so nothing is written.
  func testAPassFindingTheUnknownSendAcceptedWritesNothing() async throws {
    let model = try makeModel()
    await model.appear()
    let id = await unknownSend(model, "Kept, the status unreadable.", kept: true)
    XCTAssertEqual(server.kept, [id])
    server.answerStatus(.answer("accepted"), for: id)
    try await reconnectionPass()
    XCTAssertEqual(server.attempts, [id], "no write: the server had it")
    XCTAssertEqual(server.kept, [id])
    XCTAssertEqual(server.asks.filter { $0 == id }.count, 2, "asked by the send, then once by the pass")
    await until("the bar gone") { model.deliveryMark == nil }
    await until("the draft cleared") { model.draft.isEmpty }
    let ledger = try await ledger()
    XCTAssertEqual(ledger, [])
  }

  /// The same pass finding it absent: one write, under the original id.
  func testAPassFindingTheUnknownSendAbsentWritesItOnceUnderItsOriginalId() async throws {
    let model = try makeModel()
    await model.appear()
    let id = await unknownSend(model, "Never kept, the status unreadable.", kept: false)
    XCTAssertEqual(server.kept, [])
    server.answerStatus(.answer("absent"), for: id)
    try await reconnectionPass()
    XCTAssertEqual(server.attempts, [id, id], "one same-id write, no new id")
    XCTAssertEqual(server.kept, [id], "the server holds exactly one message")
    await until("the bar gone") { model.deliveryMark == nil }
    await until("the draft cleared") { model.draft.isEmpty }
    let ledger = try await ledger()
    XCTAssertEqual(ledger, [])
  }

  // MARK: - The person's two choices

  /// Discard: the id leaves the ledger, the Send arrow is back with the draft to edit, and no later
  /// pass writes or asks about that id (the server would say absent, so a pass that kept it would).
  func testAfterDiscardNoLaterPassWritesThatId() async throws {
    let model = try makeModel()
    await model.appear()
    let text = "Forget it."
    let id = await unknownSend(model, text, kept: false)
    server.answerStatus(.answer("absent"), for: id)
    await model.discardUnknownSend()
    let ledger = try await ledger()
    XCTAssertEqual(ledger, [], "the old id left the ledger")
    XCTAssertNil(model.deliveryMark)
    XCTAssertEqual(model.draft, text, "the draft stays to edit")
    XCTAssertTrue(model.canSend, "the Send arrow is back")
    try await reconnectionPass()
    try await reconnectionPass()
    XCTAssertEqual(server.attempts, [id], "no pass wrote the discarded id")
    XCTAssertEqual(server.asks.filter { $0 == id }.count, 1, "no pass asked about it")
    XCTAssertEqual(server.kept, [])
  }

  /// Send again: the old id leaves the ledger, the new id is written once, and no later pass ever
  /// writes the old one. The server received exactly one message, under the new id.
  func testAfterSendAgainNoLaterPassWritesTheOldId() async throws {
    let model = try makeModel()
    await model.appear()
    let old = await unknownSend(model, "Twice maybe.", kept: false)
    server.answerStatus(.answer("absent"), for: old)
    await model.resendUnderNewId()
    let ids = server.attempts
    XCTAssertEqual(ids.count, 2)
    let new = ids.last ?? ""
    XCTAssertNotEqual(new, old, "Send again is a new id")
    XCTAssertEqual(server.kept, [new], "the new id written once")
    let ledger = try await ledger()
    XCTAssertEqual(ledger, [], "the old id left the ledger")
    XCTAssertNil(model.deliveryMark)
    XCTAssertEqual(model.draft, "")
    try await reconnectionPass()
    try await reconnectionPass()
    XCTAssertEqual(server.attempts, [old, new], "no pass wrote the old id")
    XCTAssertEqual(server.kept, [new], "the server received exactly one message, under the new id")
  }

  // MARK: - Two taps

  /// Two sends at the same moment: the second finds the first under way and writes nothing.
  func testTwoSendsAtTheSameMomentWriteOnceUnderOneId() async throws {
    let model = try makeModel()
    await model.appear()
    model.draft = "Tapped twice."
    // Both tasks run on the main actor in order: the second starts at the first's first suspension.
    let first = Task { await model.send() }
    let second = Task { await model.send() }
    await first.value
    await second.value
    XCTAssertEqual(server.attempts.count, 1, "one write")
    XCTAssertEqual(server.kept.count, 1, "one message, under one id")
    XCTAssertEqual(model.draft, "")
  }
}

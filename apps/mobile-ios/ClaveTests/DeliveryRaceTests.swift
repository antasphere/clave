@testable import ClaveCore
import XCTest
@testable import Clave

// Races at the model-to-transport and store boundary, against ChatModelTests' in-process server
// (wrapped as DeliveryChatServer) and the machine's one delivery controller:
// - a reconnection pass holding a send of unknown outcome while the person chooses on the bar
//   (Send again, Discard): the choice waits, and finds the send settled or discards it;
// - two conversations of one machine: one's pass never writes what the other is sending;
// - two sends at once: the second returns before it mints anything, whatever holds the first.

/// A key-value store that holds the writes of one key while told to, until the test lets them
/// through: a send held there waits inside `DeliveryController.begin`, before the ledger has it.
actor HoldingStore: KeyValueStore {
  private let inner = InMemoryKeyValueStore()
  private var holding: String?
  private var held: [CheckedContinuation<Void, Never>] = []

  /// Holds every write of `key` from now on.
  func hold(_ key: String) { holding = key }
  /// How many writes wait.
  var waiting: Int { held.count }
  /// Lets the waiting writes through and holds no more.
  func release() {
    holding = nil
    let waiting = held
    held = []
    for write in waiting { write.resume() }
  }

  func get(_ key: String) async throws -> String? { try await inner.get(key) }

  func set(_ key: String, _ value: String) async throws {
    if key == holding { await withCheckedContinuation { held.append($0) } }
    try await inner.set(key, value)
  }

  func remove(_ key: String) async throws { try await inner.remove(key) }
}

/// Set once a task the test started has returned.
@MainActor
final class Returned {
  var yes = false
}

@MainActor
final class DeliveryRaceTests: XCTestCase {
  private var server: DeliveryChatServer!
  private var push: PushClient!
  private var store: HoldingStore!
  private var parts: MachineDeliveryParts!
  private var models: [ConversationModel] = []

  /// Another conversation's send, last in the ledger and answered unknown: a pass that asked about
  /// it has gone through every send before it.
  private let sentinelId = "m-sentinel-0000000000000000"

  override func setUp() async throws {
    server = DeliveryChatServer()
    store = HoldingStore()
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

  /// A conversation of machine m1 over the machine's shared parts.
  private func makeModel(_ sessionId: String = "s1") throws -> ConversationModel {
    let client = try ClaveServerClient(baseURL: "https://fake.invalid", bearer: { "device-token" }, transport: server)
    let push: PushClient = self.push
    let session = Session(
      id: sessionId, provider: "claude", transport: .events, cwd: "/tmp/scratch", windowKey: "server", state: .idle,
      createdAt: 1, adapterId: "claude-chat", title: "Seeded chat")
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

  /// The same, for a condition read across an actor.
  private func eventually(_ what: String, timeout: TimeInterval = 20, _ condition: () async -> Bool) async {
    let start = Date()
    while Date().timeIntervalSince(start) < timeout {
      if await condition() { return }
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
    XCTFail("Timed out waiting for \(what)")
  }

  private func ledger(_ sessionId: String = "s1") async throws -> [String] {
    try await parts.delivery.sends.forSession("m1", sessionId).map(\.clientMessageId)
  }

  /// A send nobody can tell the outcome of: the write never kept and its answer lost, the status
  /// route unreadable. Returns its id.
  private func unknownSend(_ model: ConversationModel, _ text: String) async -> String {
    server.planWrites(.loseBeforeKept)
    server.answerStatusByDefault(.unreadable)
    model.draft = text
    await model.send()
    XCTAssertEqual(model.deliveryMark?.kind, .unknown, "the bar shows")
    return server.attempts.last ?? ""
  }

  /// Puts the sentinel last in the ledger; returns how often it was asked about so far.
  private func addSentinel() async throws -> Int {
    try await parts.delivery.sends.add(
      UnknownSend(machineId: "m1", sessionId: "s-sentinel", clientMessageId: sentinelId, text: "another conversation", at: 1))
    server.answerStatus(.answer("unknown"), for: sentinelId)
    return server.asks.filter { $0 == sentinelId }.count
  }

  /// Drops the push socket; the models' reconnection pass starts once the new one is welcomed.
  private func dropSocket() async {
    let sockets = server.chat.sockets.count
    server.chat.sockets.last?.feed(.closed(code: 1006, reason: "gone"))
    await until("the socket reopened") { server.chat.sockets.count == sockets + 1 }
  }

  /// Waits until `which` asked about the sentinel once more than `asked`; says what it saw if not.
  private func passFinished(_ asked: Int, _ which: String = "the pass", fetchesBefore: Int? = nil) async {
    await until("\(which) to reach the end of the ledger") { server.asks.filter { $0 == sentinelId }.count == asked + 1 }
    let now = server.asks.filter { $0 == sentinelId }.count
    if now != asked + 1 {
      let claim = await parts.delivery.claimState(sentinelId)
      let ledger = (try? await parts.delivery.sends.list().map(\.clientMessageId)) ?? []
      XCTFail(
        "\(which): sentinel asked \(now) times (\(asked) before), \(server.chat.sockets.count) sockets, "
          + "\(server.asks.count) status reads, timeline reads \(server.chat.timelineFetches) (\(fetchesBefore.map(String.init) ?? "?") before), "
          + "sentinel claim held \(claim.held) waiting \(claim.waiting), ledger \(ledger)")
    }
    // The sentinel's status read is seen before the pass has settled it and returned; a
    // reconnection arriving before the pass let go of the machine would join it, not run its own.
    await eventually("\(which) to let go of the machine") { await !parts.delivery.isReconnecting("m1") }
  }

  /// A full later pass.
  private func laterPass() async throws {
    let asked = try await addSentinel()
    let fetches = server.chat.timelineFetches
    await dropSocket()
    await passFinished(asked, "the later pass", fetchesBefore: fetches)
  }

  /// The unknown send, then a pass started and held at the send's status read.
  private func unknownSendWithAPassHoldingIt(_ model: ConversationModel, _ text: String) async throws -> (old: String, asked: Int) {
    let old = await unknownSend(model, text)
    server.answerStatus(.held, for: old)
    let asked = try await addSentinel()
    await dropSocket()
    await until("the pass holds at the old id's status read") { server.isHoldingStatus(of: old) }
    return (old, asked)
  }

  // MARK: - F1.5: a pass and the person's choices

  /// r1: Send again while a pass holds the send; the pass finds it absent and writes it once under
  /// the old id. Send again waited, found it settled, and wrote nothing.
  func testSendAgainWhileAPassHoldsTheSendWaitsAndTheOldIdLandsOnce() async throws {
    let model = try makeModel()
    await model.appear()
    let (old, asked) = try await unknownSendWithAPassHoldingIt(model, "Racing the pass.")
    let returned = Returned()
    let resend = Task {
      await model.resendUnderNewId()
      returned.yes = true
    }
    try await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertFalse(returned.yes, "Send again returned while the pass held the send")
    XCTAssertEqual(server.attempts, [old], "nothing written while the pass holds")
    server.answerStatus(.answer("absent"), for: old)
    server.answerHeldStatus(of: old, .answer("absent"))
    await resend.value
    await passFinished(asked)
    XCTAssertEqual(server.attempts, [old, old], "the pass's one same-id write; Send again wrote nothing")
    XCTAssertEqual(server.kept, [old], "exactly one message, under the old id")
    await until("the bar gone") { model.deliveryMark == nil }
    let ledger = try await ledger()
    XCTAssertEqual(ledger, [])
  }

  /// r2: the same, the held read answered unreadable: the pass leaves the send unknown, Send again
  /// discards it and sends under a new id. One message, under the new id; a later pass writes nothing.
  func testSendAgainWhileAPassHoldsAnUnreadableSendDeliversOnceUnderTheNewId() async throws {
    let model = try makeModel()
    await model.appear()
    let (old, asked) = try await unknownSendWithAPassHoldingIt(model, "Racing the pass again.")
    let resend = Task { await model.resendUnderNewId() }
    try await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertEqual(server.attempts, [old], "nothing written while the pass holds")
    server.answerStatus(.answer("absent"), for: old)
    server.answerHeldStatus(of: old, .unreadable)
    await resend.value
    await passFinished(asked)
    let ids = server.attempts
    XCTAssertEqual(ids.count, 2)
    let new = ids.last ?? ""
    XCTAssertNotEqual(new, old)
    XCTAssertEqual(server.kept, [new], "exactly one message, under the new id")
    try await laterPass()
    XCTAssertEqual(server.attempts, [old, new], "a later pass wrote nothing")
    XCTAssertEqual(server.kept, [new])
    let ledger = try await ledger()
    XCTAssertEqual(ledger, [])
  }

  /// r3: Discard while a pass holds the send; the pass finds it absent and writes it once. The
  /// discard waited and did nothing.
  func testDiscardWhileAPassHoldsTheSendWaitsAndTheOldIdLandsOnce() async throws {
    let model = try makeModel()
    await model.appear()
    let (old, asked) = try await unknownSendWithAPassHoldingIt(model, "Discard racing the pass.")
    let returned = Returned()
    let discard = Task {
      await model.discardUnknownSend()
      returned.yes = true
    }
    try await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertFalse(returned.yes, "Discard returned while the pass held the send")
    XCTAssertEqual(server.attempts, [old], "nothing written while the pass holds")
    server.answerStatus(.answer("absent"), for: old)
    server.answerHeldStatus(of: old, .answer("absent"))
    await discard.value
    await passFinished(asked)
    XCTAssertEqual(server.attempts, [old, old], "the old id once, by the pass")
    XCTAssertEqual(server.kept, [old])
    await until("the bar gone") { model.deliveryMark == nil }
    let ledger = try await ledger()
    XCTAssertEqual(ledger, [])
  }

  /// r4: Discard while a pass holds the send, the held read answered unreadable: the discard takes
  /// it out once the pass lets go, and nothing is ever written, by this pass or a later one.
  func testDiscardWhileAPassHoldsAnUnreadableSendWritesNothingEver() async throws {
    let model = try makeModel()
    await model.appear()
    let text = "Discard, the status unreadable."
    let (old, asked) = try await unknownSendWithAPassHoldingIt(model, text)
    let discard = Task { await model.discardUnknownSend() }
    try await Task.sleep(nanoseconds: 300_000_000)
    server.answerStatus(.answer("absent"), for: old)
    server.answerHeldStatus(of: old, .unreadable)
    await discard.value
    await passFinished(asked)
    let ledger = try await ledger()
    XCTAssertEqual(ledger, [], "discarded once the pass let go")
    await until("the bar gone") { model.deliveryMark == nil }
    XCTAssertEqual(model.draft, text, "the draft stays to edit")
    try await laterPass()
    XCTAssertEqual(server.attempts, [old], "nothing was ever written")
    XCTAssertEqual(server.kept, [])
  }

  /// r5: two conversations of one machine share its controller. While one sends (its write held
  /// at the server, which would answer absent), the pass both run on the reconnection leaves that
  /// send alone: it is written once, by its composer.
  func testOneConversationsPassNeverWritesWhatAnotherIsSending() async throws {
    let sending = try makeModel("s1")
    let other = try makeModel("s2")
    await sending.appear()
    await other.appear()
    server.planWrites(.hold)
    server.answerStatusByDefault(.answer("absent"))
    sending.draft = "In flight from the first conversation."
    let send = Task { await sending.send() }
    await until("the write is held at the server") { server.writesHeld == 1 }
    let id = server.attempts.first ?? ""
    let asked = try await addSentinel()
    await dropSocket()
    await passFinished(asked)
    XCTAssertFalse(server.asks.contains(id), "no pass asked about the send in flight")
    XCTAssertEqual(server.attempts, [id], "no pass wrote it")
    server.releaseHeldWrites()
    await send.value
    XCTAssertEqual(server.attempts, [id])
    XCTAssertEqual(server.kept, [id], "written once, by its composer")
  }

  // MARK: - F1.6: two sends at once

  /// The first send held inside `delivery.begin` (the ledger's write waits): a second send at the
  /// same moment returns while the first is held, writes nothing and leaves the draft; after the
  /// release, one write under one id.
  func testASecondSendReturnsWhileTheFirstIsHeldBeforeTheLedgerHasIt() async throws {
    let model = try makeModel()
    await model.appear()
    let text = "Held before the ledger."
    model.draft = text
    await model.flushDraft()
    await store.hold(UnknownSends.key)
    let returned = Returned()
    // Both run on the main actor in order: the second starts at the first one's first suspension.
    let first = Task { await model.send() }
    let second = Task {
      await model.send()
      returned.yes = true
    }
    await eventually("the first send held at the ledger") { await store.waiting >= 1 }
    await until("the second send returned") { returned.yes }
    let stillHeld = await store.waiting
    XCTAssertEqual(stillHeld, 1, "the second returned while the first is held, and reached no ledger")
    XCTAssertEqual(server.attempts, [], "the server received no write")
    XCTAssertEqual(model.draft, text, "the draft is unchanged")
    await store.release()
    await first.value
    await second.value
    XCTAssertEqual(server.attempts.count, 1, "exactly one write")
    XCTAssertEqual(server.kept.count, 1, "one message, under one id")
  }

  /// The same with the first send held in its attachment's upload.
  func testASecondSendReturnsWhileTheFirstIsHeldInItsUpload() async throws {
    let model = try makeModel()
    await model.appear()
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("delivery-race-notes.txt")
    try Data("twelve bytes".utf8).write(to: file)
    defer { try? FileManager.default.removeItem(at: file) }
    model.attach(PickedFile(uri: file.absoluteString, name: "notes.txt", mimeType: "text/plain", size: 12, kind: .file))
    XCTAssertEqual(model.pendingFiles.count, 1)
    let text = "With a file."
    model.draft = text
    server.holdUploads()
    let returned = Returned()
    let first = Task { await model.send() }
    let second = Task {
      await model.send()
      returned.yes = true
    }
    await until("the first send held at its upload") { server.uploadsHeld >= 1 }
    await until("the second send returned") { returned.yes }
    XCTAssertEqual(server.uploadsHeld, 1, "one upload under way")
    XCTAssertEqual(server.attempts, [], "the server received no write")
    XCTAssertEqual(model.draft, text, "the draft is unchanged")
    server.releaseHeldUploads()
    await first.value
    await second.value
    XCTAssertEqual(server.uploads, 1, "one upload in all")
    XCTAssertEqual(server.attempts.count, 1, "exactly one write")
    XCTAssertEqual(server.kept.count, 1, "one message, under one id")
  }
}

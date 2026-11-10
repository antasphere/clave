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
  private var holdingReads: String?
  private var readsToPass = 0
  private var heldReads: [CheckedContinuation<Void, Never>] = []

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

  /// Holds the reads of `key` from now on, after letting the next `skipping` through.
  func holdReads(_ key: String, skipping: Int) {
    holdingReads = key
    readsToPass = skipping
  }
  /// How many reads wait.
  var readsWaiting: Int { heldReads.count }
  /// Lets the waiting reads through and holds no more.
  func releaseReads() {
    holdingReads = nil
    let waiting = heldReads
    heldReads = []
    for read in waiting { read.resume() }
  }

  func get(_ key: String) async throws -> String? {
    if key == holdingReads {
      if readsToPass > 0 {
        readsToPass -= 1
      } else {
        await withCheckedContinuation { heldReads.append($0) }
      }
    }
    return try await inner.get(key)
  }

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
  /// The push streams of conversations built deaf to the push channel, kept open.
  private var silences: [AsyncStream<PushEvent>.Continuation] = []

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
    for silence in silences { silence.finish() }
    silences = []
    await push.stop()
  }

  /// A conversation of machine m1 over the machine's shared parts. `hearsPush: false` builds one
  /// that hears nothing of the push channel, so it never runs a reconnection pass of its own: what
  /// it learns of its sends, it learns from the marks.
  private func makeModel(_ sessionId: String = "s1", hearsPush: Bool = true) throws -> ConversationModel {
    let client = try ClaveServerClient(baseURL: "https://fake.invalid", bearer: { "device-token" }, transport: server)
    let push: PushClient = self.push
    let session = Session(
      id: sessionId, provider: "claude", transport: .events, cwd: "/tmp/scratch", windowKey: "server", state: .idle,
      createdAt: 1, adapterId: "claude-chat", title: "Seeded chat")
    let events: @MainActor () -> AsyncStream<PushEvent>
    if hearsPush {
      events = { TestPushFanout.shared(for: push).stream() }
    } else {
      let (silent, continuation) = AsyncStream<PushEvent>.makeStream()
      silences.append(continuation)
      events = { silent }
    }
    let model = ConversationModel(
      machineId: "m1", session: session, client: client, push: push,
      events: events, delivery: parts.delivery, drafts: parts.drafts,
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
  private func unknownSend(_ model: ConversationModel, _ text: String, kept: Bool = false) async -> String {
    server.planWrites(kept ? .keepThenLose : .loseBeforeKept)
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
  private func unknownSendWithAPassHoldingIt(_ model: ConversationModel, _ text: String, kept: Bool = false) async throws -> (old: String, asked: Int) {
    let old = await unknownSend(model, text, kept: kept)
    server.answerStatus(.held, for: old)
    let asked = try await addSentinel()
    await dropSocket()
    await until("the pass holds at the old id's status read") { server.isHoldingStatus(of: old) }
    return (old, asked)
  }

  // MARK: - F1.5: a pass and the person's choices

  /// t2a (r1): Send again while a pass holds the send at its status read, released absent: the
  /// choice was recorded before the pass's same-id write, so the pass writes nothing and Send again
  /// sends under a new id. The old id is never written; one message, under the new id.
  func testSendAgainMadeWhileThePassReadsTheStatusWinsAndTheOldIdIsNeverWritten() async throws {
    let model = try makeModel()
    await model.appear()
    let (old, asked) = try await unknownSendWithAPassHoldingIt(model, "Racing the pass.")
    let resend = Task { await model.resendUnderNewId() }
    await eventually("Send again waits for the pass") { await parts.delivery.claimState(old).waiting == 1 }
    XCTAssertEqual(server.attempts, [old], "nothing written while the pass holds")
    server.answerStatus(.answer("absent"), for: old)
    server.answerHeldStatus(of: old, .answer("absent"))
    await resend.value
    await passFinished(asked)
    let ids = server.attempts
    XCTAssertEqual(ids.count, 2, "the lost original and the new id")
    let new = ids.last ?? ""
    XCTAssertNotEqual(new, old)
    XCTAssertEqual(server.kept, [new], "one message, under the new id")
    try await laterPass()
    XCTAssertEqual(server.attempts, [old, new], "the old id is never written")
    XCTAssertEqual(server.kept, [new])
    XCTAssertNil(model.deliveryNotice, "no delivered notice")
    let ledger = try await ledger()
    XCTAssertEqual(ledger, [])
  }

  /// r2: Send again while a pass holds the send, the held read answered unreadable: the pass stops
  /// for the choice, Send again discards the send and sends under a new id. One message, under the
  /// new id; a later pass writes nothing.
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

  /// t1a (r3): Discard while a pass holds the send at its status read, released absent: the choice
  /// was recorded before the pass's same-id write, so nothing is ever written; the send is
  /// discarded and the draft stays to edit.
  func testDiscardMadeWhileThePassReadsTheStatusWinsAndNothingIsEverWritten() async throws {
    let model = try makeModel()
    await model.appear()
    let text = "Discard racing the pass."
    let (old, asked) = try await unknownSendWithAPassHoldingIt(model, text)
    let discard = Task { await model.discardUnknownSend() }
    await eventually("Discard waits for the pass") { await parts.delivery.claimState(old).waiting == 1 }
    XCTAssertEqual(server.attempts, [old], "nothing written while the pass holds")
    server.answerStatus(.answer("absent"), for: old)
    server.answerHeldStatus(of: old, .answer("absent"))
    await discard.value
    await passFinished(asked)
    XCTAssertEqual(server.attempts, [old], "the old id is never written")
    XCTAssertEqual(server.kept, [])
    await until("the bar gone") { model.deliveryMark == nil }
    XCTAssertEqual(model.draft, text, "the draft stays to edit")
    XCTAssertNil(model.deliveryNotice, "no delivered notice")
    let ledger = try await ledger()
    XCTAssertEqual(ledger, [], "discarded")
    try await laterPass()
    XCTAssertEqual(server.attempts, [old], "nor by a later pass")
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

  // MARK: - Round 4b: what the composer says about a send a pass decided

  /// t1b: Discard while the pass's same-id write is in flight (the request reached the server, its
  /// answer held), released accepted: a write already sent is never withdrawn, so the message is
  /// delivered once, under the old id; the discard finds it so, says so, and the field follows.
  func testDiscardDuringThePassesWriteFindsTheMessageDeliveredAndSaysSo() async throws {
    let model = try makeModel()
    await model.appear()
    let old = await unknownSend(model, "Discard while the write is out.")
    server.planWrites(.hold)
    server.answerStatus(.answer("absent"), for: old)
    let asked = try await addSentinel()
    await dropSocket()
    await until("the pass's write is in flight") { server.writesHeld == 1 }
    let discard = Task { await model.discardUnknownSend() }
    await eventually("Discard waits for the pass") { await parts.delivery.claimState(old).waiting == 1 }
    server.releaseHeldWrites()
    await discard.value
    await passFinished(asked)
    XCTAssertEqual(server.kept, [old], "one message, under the old id")
    XCTAssertEqual(server.attempts, [old, old], "the lost original and the pass's one write")
    XCTAssertEqual(model.deliveryNotice, "This message was delivered before it could be discarded.")
    XCTAssertEqual(model.draft, "", "the field follows the store the delivery cleared")
    XCTAssertNil(model.deliveryMark)
    XCTAssertFalse(model.canSend)
  }

  /// t1c: the status read answers accepted with a Discard pending: the original had landed, so
  /// nothing is written and the person is told it was delivered.
  func testDiscardPendingWhenTheOriginalIsFoundAcceptedSaysDelivered() async throws {
    let model = try makeModel()
    await model.appear()
    let (old, asked) = try await unknownSendWithAPassHoldingIt(model, "Kept, then discarded?", kept: true)
    let discard = Task { await model.discardUnknownSend() }
    await eventually("Discard waits for the pass") { await parts.delivery.claimState(old).waiting == 1 }
    server.answerHeldStatus(of: old, .answer("accepted"))
    await discard.value
    await passFinished(asked)
    XCTAssertEqual(server.attempts, [old], "no write: the original had landed")
    XCTAssertEqual(server.kept, [old])
    XCTAssertEqual(model.deliveryNotice, "This message was delivered before it could be discarded.")
    XCTAssertEqual(model.draft, "")
  }

  /// t2b: Send again while the old id's write is in flight, released accepted: one message in all,
  /// under the old id; the person is told it had already been delivered, the field and the picked
  /// file follow the stores, and a further send writes nothing.
  func testSendAgainDuringThePassesWriteSendsNothingMoreAndSaysSo() async throws {
    let model = try makeModel()
    await model.appear()
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("delivery-truth-notes.txt")
    try Data("twelve bytes".utf8).write(to: file)
    defer { try? FileManager.default.removeItem(at: file) }
    model.attach(PickedFile(uri: file.absoluteString, name: "notes.txt", mimeType: "text/plain", size: 12, kind: .file))
    XCTAssertEqual(model.pendingFiles.count, 1)
    let old = await unknownSend(model, "Send again while the write is out.")
    XCTAssertEqual(model.pendingFiles.count, 1, "the file stays with the unknown send")
    server.planWrites(.hold)
    server.answerStatus(.answer("absent"), for: old)
    let asked = try await addSentinel()
    await dropSocket()
    await until("the pass's write is in flight") { server.writesHeld == 1 }
    let resend = Task { await model.resendUnderNewId() }
    await eventually("Send again waits for the pass") { await parts.delivery.claimState(old).waiting == 1 }
    server.releaseHeldWrites()
    await resend.value
    await passFinished(asked)
    XCTAssertEqual(server.kept, [old], "one message in all, under the old id")
    XCTAssertEqual(server.attempts, [old, old])
    XCTAssertEqual(model.deliveryNotice, "This message had already been delivered, so it was not sent again.")
    XCTAssertEqual(model.draft, "", "the field follows the store")
    XCTAssertEqual(model.pendingFiles, [], "the picked file too")
    XCTAssertFalse(model.canSend)
    await model.send()
    XCTAssertEqual(server.attempts, [old, old], "a further send writes nothing")
  }

  /// t2c: the send's first mark wakes the bar, which reads the ledger for what the send carried
  /// while the send is still out. That read, held here until the send has recorded its picked
  /// file, must not take the file out of the record: once a pass finds the send delivered, the
  /// composer drops the file it sent, and a further send writes nothing. (Under load on iOS 17.5
  /// the late read emptied the record and the file went out again as a new message.)
  func testTheBarsLateReadOfTheLedgerKeepsTheFileTheSendCarried() async throws {
    let model = try makeModel()
    await model.appear()
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("late-read-notes.txt")
    try Data("twelve bytes".utf8).write(to: file)
    defer { try? FileManager.default.removeItem(at: file) }
    model.attach(PickedFile(uri: file.absoluteString, name: "notes.txt", mimeType: "text/plain", size: 12, kind: .file))
    server.planWrites(.loseBeforeKept)
    server.answerStatusByDefault(.unreadable)
    model.draft = "A file, and a late read of the ledger."
    // The send's own entry reads the ledger once; the bar's read after it is held.
    await store.holdReads(UnknownSends.key, skipping: 1)
    let sending = Task { await model.send() }
    await eventually("the bar holds at its read of the ledger") { await store.readsWaiting == 1 }
    await eventually("the send's outcome is marked") {
      let mark = try? await parts.delivery.marks.get("m1", "s1")
      return mark?.kind == .unknown && mark?.reason != "Delivery has not been confirmed."
    }
    // The send records what it carried as soon as its outcome is marked; then the read goes on.
    try await Task.sleep(nanoseconds: 200_000_000)
    await store.releaseReads()
    await sending.value
    let old = server.attempts.last ?? ""
    XCTAssertEqual(model.deliveryMark?.kind, .unknown, "the bar shows")
    XCTAssertEqual(model.pendingFiles.count, 1, "the file stays with the unknown send")
    server.answerStatus(.answer("accepted"), for: old)
    let asked = try await addSentinel()
    await dropSocket()
    await passFinished(asked)
    await until("the composer says the send was delivered") { model.deliveryNotice != nil }
    XCTAssertEqual(model.pendingFiles, [], "the file the send carried goes with it")
    XCTAssertFalse(model.canSend)
    await model.send()
    XCTAssertEqual(server.attempts, [old], "a further send writes nothing")
  }

  /// t3: Send again on a bar whose send a pass delivered while this model was not listening (its
  /// mark in memory is stale): nothing is sent, the person is told, and the field follows the store.
  func testSendAgainOnAStaleBarAfterTheSendWasDeliveredSendsNothing() async throws {
    let sender = try makeModel()
    await sender.appear()
    let text = "Delivered behind the bar."
    let old = await unknownSend(sender, text)
    let stale = try makeModel()
    await stale.appear()
    XCTAssertEqual(stale.deliveryMark?.clientMessageId, old)
    XCTAssertEqual(stale.draft, text)
    stale.disappear()
    server.answerStatus(.answer("absent"), for: old)
    let asked = try await addSentinel()
    await dropSocket()
    await passFinished(asked)
    XCTAssertEqual(server.kept, [old], "the sender's pass delivered it")
    XCTAssertEqual(stale.deliveryMark?.kind, .unknown, "the model that did not listen still shows the bar")
    let writes = server.attempts.count
    await stale.resendUnderNewId()
    XCTAssertEqual(server.attempts.count, writes, "nothing sent")
    XCTAssertEqual(stale.deliveryNotice, "This message had already been delivered, so it was not sent again.")
    XCTAssertEqual(stale.draft, "", "the field follows the store")
    XCTAssertNil(stale.deliveryMark)
    XCTAssertFalse(stale.canSend)
  }

  /// t4 (P08): a pass held at conversation A's status read; conversation B's unknown send is
  /// discarded meanwhile. B's discard answers at once (the pass had not reached B); the pass reads
  /// the ledger again when it gets to B and skips it; B's id is never written by the pass.
  func testADiscardOfASendThePassHasNotReachedIsImmediateAndThePassSkipsIt() async throws {
    let a = try makeModel("s1")
    let b = try makeModel("s2")
    await a.appear()
    await b.appear()
    let oldA = await unknownSend(a, "A's message.")
    let textB = "B's message."
    let oldB = await unknownSend(b, textB)
    server.answerStatus(.held, for: oldA)
    server.answerStatus(.answer("absent"), for: oldB)
    let asked = try await addSentinel()
    await dropSocket()
    await until("the pass holds at A's status read") { server.isHoldingStatus(of: oldA) }
    let claimB = await parts.delivery.claimState(oldB)
    XCTAssertFalse(claimB.held, "the pass has not reached B")
    await b.discardUnknownSend()
    XCTAssertTrue(server.isHoldingStatus(of: oldA), "B's discard returned while the pass still holds A")
    XCTAssertNil(b.deliveryNotice)
    XCTAssertEqual(b.draft, textB, "B's draft stays to edit")
    let ledgerB = try await ledger("s2")
    XCTAssertEqual(ledgerB, [], "B discarded")
    server.answerHeldStatus(of: oldA, .unreadable)
    await passFinished(asked)
    XCTAssertEqual(server.asks.filter { $0 == oldB }.count, 1, "the pass never asked about B")
    XCTAssertEqual(server.attempts.filter { $0 == oldB }.count, 1, "B's id never written by the pass")
    XCTAssertFalse(server.kept.contains(oldB))
  }

  /// t5: conversation X's pass delivers conversation Y's unknown send while Y's bar shows. Y hears
  /// no push, so it runs no pass of its own and learns it from the marks: the bar goes, the text it
  /// sent leaves the field, and Y says the message was delivered.
  func testAnotherConversationsPassDeliveringThisSendClearsTheBarAndSaysSo() async throws {
    let x = try makeModel("s1")
    let y = try makeModel("s2", hearsPush: false)
    await x.appear()
    await y.appear()
    let old = await unknownSend(y, "Y's message.")
    server.answerStatus(.answer("absent"), for: old)
    let asked = try await addSentinel()
    await dropSocket()
    await passFinished(asked)
    XCTAssertEqual(server.kept, [old], "X's pass delivered Y's send under its id")
    await until("Y's bar gone") { y.deliveryMark == nil }
    await until("Y says it was delivered") { y.deliveryNotice != nil }
    XCTAssertEqual(y.deliveryNotice, "This message was delivered when the connection came back.")
    XCTAssertEqual(y.draft, "", "the text it sent leaves the field")
    XCTAssertFalse(y.canSend)
  }

  /// t6: the person typed new text after the unknown send, then a pass delivers the send: the new
  /// text stays in the field and Send stays enabled for it (it is a new message).
  func testTextTypedAfterTheUnknownSendStaysWhenAPassDeliversIt() async throws {
    let x = try makeModel("s1")
    let y = try makeModel("s2", hearsPush: false)
    await x.appear()
    await y.appear()
    let old = await unknownSend(y, "Y's first message.")
    y.draft = "A new thought."
    await y.flushDraft()
    server.answerStatus(.answer("absent"), for: old)
    let asked = try await addSentinel()
    await dropSocket()
    await passFinished(asked)
    XCTAssertEqual(server.kept, [old])
    await until("Y's bar gone") { y.deliveryMark == nil }
    await until("Y says it was delivered") { y.deliveryNotice != nil }
    XCTAssertEqual(y.draft, "A new thought.", "the new text stays")
    XCTAssertTrue(y.canSend, "and Send is there for it")
  }

  /// t6b: the person types while the composer resyncs after a delivery (it has read the draft the
  /// settle cleared, and its read of the picked files is held): what they typed stays.
  func testTextTypedWhileTheComposerResyncsStays() async throws {
    let x = try makeModel("s1")
    let y = try makeModel("s2", hearsPush: false)
    await x.appear()
    await y.appear()
    let old = await unknownSend(y, "Y's message.")
    server.answerStatus(.answer("absent"), for: old)
    // The settle reads Y's picked files once; the resync's read after it is held.
    await store.holdReads(attachmentDraftKey("m1", "s2"), skipping: 1)
    let asked = try await addSentinel()
    await dropSocket()
    await eventually("the resync holds at its read of the picked files") { await store.readsWaiting == 1 }
    y.draft = "Typed during the resync."
    await store.releaseReads()
    await passFinished(asked)
    await until("Y says it was delivered") { y.deliveryNotice != nil }
    XCTAssertEqual(y.draft, "Typed during the resync.", "what the person typed stays")
    XCTAssertTrue(y.canSend)
  }
}

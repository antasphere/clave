@testable import ClaveCore
import XCTest
@testable import Clave

// What the person's choice on a send of unknown outcome, and a send a pass delivers, leave behind
// across a restart, against DeliveryRaceTests' server: DeliveryChatServer holds a pass at the old
// id's status read. A restart here is MODELLED: every model closed, then new controllers, drafts and
// attachment drafts over a copy of what the store held (the controller is recreated), or over the
// same file read again by a fresh FileKeyValueStore (a reload of the file). No test ends a process.
// From the verifier's round-5 probes A1, A2, A3, N1a, N1b, N1c, N2a and N2b.

private struct LedgerWriteRefused: Error {}

/// The store of these tests: memory, seeded with another store's values for a modelled restart,
/// that can hold the reads of one key and refuse the writes of another.
actor RestartStore: KeyValueStore {
  private let inner: InMemoryKeyValueStore
  private var holdingReads: String?
  private var readsToPass = 0
  private var heldReads: [CheckedContinuation<Void, Never>] = []
  private var refusing: String?

  init(_ values: [String: String] = [:]) {
    inner = InMemoryKeyValueStore(values)
  }

  /// What the store holds.
  var values: [String: String] {
    get async { await inner.values }
  }

  /// Holds the reads of `key` from now on, after letting the next `skipping` through.
  func holdReads(_ key: String, skipping: Int) {
    holdingReads = key
    readsToPass = skipping
  }

  /// Lets the waiting reads through and holds no more.
  func releaseReads() {
    holdingReads = nil
    let waiting = heldReads
    heldReads = []
    for read in waiting { read.resume() }
  }

  /// Refuses every write of `key` from now on.
  func refuseWrites(of key: String) { refusing = key }

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
    if key == refusing { throw LedgerWriteRefused() }
    try await inner.set(key, value)
  }

  func remove(_ key: String) async throws {
    if key == refusing { throw LedgerWriteRefused() }
    try await inner.remove(key)
  }
}

@MainActor
final class DeliveryRestartTests: XCTestCase {
  private var server: DeliveryChatServer!
  private var push: PushClient!
  private var store: RestartStore!
  private var parts: MachineDeliveryParts!
  private var models: [ConversationModel] = []
  private var silences: [AsyncStream<PushEvent>.Continuation] = []
  private var folders: [URL] = []
  private let sentinelId = "m-sentinel-0000000000000000"

  override func setUp() async throws {
    server = DeliveryChatServer()
    store = RestartStore()
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
    for folder in folders { try? FileManager.default.removeItem(at: folder) }
    folders = []
  }

  /// A conversation of machine m1 over the machine's parts; `keep: false` leaves it out of the
  /// models the tear-down closes, for a test that closes and releases it itself.
  private func makeModel(_ sessionId: String = "s1", hearsPush: Bool = true, keep: Bool = true) throws -> ConversationModel {
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
    if keep { models.append(model) }
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

  private func unknownSend(_ model: ConversationModel, _ text: String, kept: Bool = false) async -> String {
    server.planWrites(kept ? .keepThenLose : .loseBeforeKept)
    server.answerStatusByDefault(.unreadable)
    model.draft = text
    await model.send()
    XCTAssertEqual(model.deliveryMark?.kind, .unknown, "the bar shows")
    return server.attempts.last ?? ""
  }

  private func addSentinel() async throws -> Int {
    try await parts.delivery.sends.add(
      UnknownSend(machineId: "m1", sessionId: "s-sentinel", clientMessageId: sentinelId, text: "another conversation", at: 1))
    server.answerStatus(.answer("unknown"), for: sentinelId)
    return server.asks.filter { $0 == sentinelId }.count
  }

  private func dropSocket() async {
    let sockets = server.chat.sockets.count
    server.chat.sockets.last?.feed(.closed(code: 1006, reason: "gone"))
    await until("the socket reopened") { server.chat.sockets.count == sockets + 1 }
  }

  private func passFinished(_ asked: Int, _ which: String = "the pass") async {
    await until("\(which) to reach the end of the ledger") { server.asks.filter { $0 == sentinelId }.count >= asked + 1 }
    await eventually("\(which) to let go of the machine") { await !parts.delivery.isReconnecting("m1") }
  }

  private func laterPass() async throws {
    let asked = try await addSentinel()
    await dropSocket()
    await passFinished(asked, "the later pass")
  }

  private func unknownSendWithAPassHoldingIt(_ model: ConversationModel, _ text: String) async throws -> (old: String, asked: Int) {
    let old = await unknownSend(model, text)
    server.answerStatus(.held, for: old)
    let asked = try await addSentinel()
    await dropSocket()
    await until("the pass holds at the old id's status read") { server.isHoldingStatus(of: old) }
    return (old, asked)
  }

  /// A restart, modelled: every model closed, then new controllers, drafts and attachment drafts
  /// over a copy of what the store held. The first controller lives on in memory, unreachable.
  private func modelledRestart() async {
    for model in models { model.disappear() }
    models = []
    let persisted = await store.values
    store = RestartStore(persisted)
    parts = MachineDeliveryParts(store: store)
  }

  private func file(_ name: String) throws -> PickedFile {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("delivery-restart-\(name)")
    try Data("twelve bytes".utf8).write(to: url)
    return PickedFile(uri: url.absoluteString, name: name, mimeType: "text/plain", size: 12, kind: .file)
  }

  // MARK: - A Discard while a pass holds the send at its status read

  /// A1: the pass held at the status read; Discard pressed; its task cancelled, the model closed and
  /// released; the held read answers absent. The Discard reaches the ledger, and after the
  /// controller is recreated a new pass writes nothing.
  func testADiscardWhoseScreenClosesWhileThePassHoldsTheSendStillWinsAfterTheControllerIsRecreated() async throws {
    var model: ConversationModel? = try makeModel(keep: false)
    await model!.appear()
    let text = "Discard, then the screen closes."
    let (old, asked) = try await unknownSendWithAPassHoldingIt(model!, text)
    let discard = Task { [model] in await model!.discardUnknownSend() }
    await eventually("Discard waits for the pass") { await parts.delivery.claimState(old).waiting == 1 }
    discard.cancel()
    model!.disappear()
    model = nil
    server.answerStatus(.answer("absent"), for: old)
    server.answerHeldStatus(of: old, .answer("absent"))
    await discard.value
    await passFinished(asked)
    let ledgerAfter = try await ledger()
    XCTAssertEqual(ledgerAfter, [], "the Discard reached the ledger")
    await modelledRestart()
    let restarted = try makeModel()
    await restarted.appear()
    try await laterPass()
    XCTAssertEqual(server.attempts, [old], "the discarded text is never written")
    XCTAssertEqual(server.kept, [])
  }

  /// A2: the pass started from a task of the test's through the controller, and that task cancelled
  /// while the pass holds the send; the held read then answers absent. The cancel never reaches the
  /// pass; the Discard reaches the ledger; nothing is written, then or after the controller is
  /// recreated.
  func testADiscardWhosePassTaskIsCancelledWhileItHoldsTheSendStillWinsAfterTheControllerIsRecreated() async throws {
    let model = try makeModel(hearsPush: false)
    await model.appear()
    let text = "Discard, then the pass's task is cancelled."
    let old = await unknownSend(model, text)
    server.answerStatus(.held, for: old)
    let asked = try await addSentinel()
    let client = try ClaveServerClient(baseURL: "https://fake.invalid", bearer: { "device-token" }, transport: server)
    let delivery = parts.delivery
    let pass = Task {
      try await delivery.reconnect(
        machineId: "m1", openConversations: [],
        status: { send in try await client.sessions.writeStatus(send.sessionId, clientMessageId: send.clientMessageId) },
        write: { send in
          try await client.sessions.write(
            send.sessionId,
            .userMessage(UserMessage(clientMessageId: send.clientMessageId, text: send.text, attachments: send.attachments)))
        },
        refreshRequests: { _ in }, refreshHistory: { _, _ in })
    }
    await until("the pass holds at the old id's status read") { server.isHoldingStatus(of: old) }
    let discard = Task { await model.discardUnknownSend() }
    await eventually("Discard waits for the pass") { await parts.delivery.claimState(old).waiting == 1 }
    pass.cancel()
    discard.cancel()
    server.answerStatus(.answer("absent"), for: old)
    server.answerHeldStatus(of: old, .answer("absent"))
    _ = await pass.result
    await discard.value
    await passFinished(asked)
    let ledgerAfter = try await ledger()
    XCTAssertEqual(ledgerAfter, [], "the Discard reached the ledger")
    XCTAssertEqual(server.attempts, [old], "the discarded text is never written")
    await modelledRestart()
    let restarted = try makeModel()
    await restarted.appear()
    try await laterPass()
    XCTAssertEqual(server.attempts, [old], "nor after the controller is recreated")
  }

  /// A3: Discard pressed while the pass holds the send at its status read, and the read never
  /// answers before the controller is recreated over a copy of the store. The recreated
  /// controller's pass, run while the conversation is open again, finds the send absent: nothing
  /// beyond the original is written, the bar goes, nothing says delivered, and the draft stays the
  /// discarded text. The conversation's read of its mark is held until that pass has ended, so it
  /// reads the stores as the pass left them.
  func testADiscardWaitingOnAHeldPassIsCarriedOutWithNothingWrittenAfterTheControllerIsRecreated() async throws {
    let model = try makeModel(keep: false)
    await model.appear()
    let text = "Discard, then the controller is recreated."
    let (old, _) = try await unknownSendWithAPassHoldingIt(model, text)
    let discard = Task { await model.discardUnknownSend() }
    await eventually("Discard waits for the pass") { await parts.delivery.claimState(old).waiting == 1 }
    let firstParts = parts!
    model.disappear()
    await modelledRestart()
    let restarted = try makeModel()
    await restarted.appear()
    XCTAssertEqual(restarted.draft, text)
    // The pass reads the mark once itself when it carries a choice out; the conversation's read
    // after it waits for the pass's end.
    await store.holdReads(deliveryMarkKey("m1", "s1"), skipping: 1)
    server.answerStatus(.answer("absent"), for: old)
    let asked = server.asks.filter { $0 == sentinelId }.count
    await dropSocket()
    await passFinished(asked, "the recreated controller's pass")
    await store.releaseReads()
    await until("the bar gone") { restarted.deliveryMark == nil }
    // Whatever the mark's read leads to has run.
    try await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertEqual(server.attempts, [old], "the discarded text is never written")
    XCTAssertNil(restarted.deliveryMark, "no bar")
    XCTAssertNil(restarted.deliveryNotice, "nothing says delivered")
    XCTAssertEqual(restarted.draft, text, "the draft stays the discarded text")
    // Let the first controller's pass and Discard go, so nothing is left suspended.
    server.answerHeldStatus(of: old, .unreadable)
    await discard.value
    _ = firstParts
  }

  /// A3f: the same Discard over parts built on a FileKeyValueStore in a folder of its own, scoped to
  /// an owner as AppModel scopes it: while the Discard waits for the pass, a reload of the file finds
  /// the choice in the send's record.
  func testADiscardWaitingOnAHeldPassIsFoundAfterAReloadOfTheFile() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("delivery-restart-\(UUID().uuidString)", isDirectory: true)
    folders.append(folder)
    let namespace = ownerNamespace(issuer: "https://hub.fake", subject: "owner-a")
    parts = MachineDeliveryParts(store: OwnerScopedKeyValueStore(base: FileKeyValueStore(directory: folder), namespace: namespace))
    let model = try makeModel(keep: false)
    await model.appear()
    let (old, asked) = try await unknownSendWithAPassHoldingIt(model, "Discard, then the file is read again.")
    let discard = Task { await model.discardUnknownSend() }
    await eventually("Discard waits for the pass") { await parts.delivery.claimState(old).waiting == 1 }
    let reloaded = try await UnknownSends(
      store: OwnerScopedKeyValueStore(base: FileKeyValueStore(directory: folder), namespace: namespace), machineId: "m1"
    ).list()
    let record = reloaded.first { $0.clientMessageId == old }
    XCTAssertNotNil(record, "the send is still in the file")
    XCTAssertEqual(record?.choice, .discard, "with the person's choice")
    model.disappear()
    server.answerHeldStatus(of: old, .unreadable)
    await discard.value
    await passFinished(asked)
  }

  // MARK: - A choice the phone cannot keep (Addendum rule 3)

  /// Discard with the ledger refusing writes: the choice claims nothing, the bar stays and says so,
  /// nothing reaches the server, and the record stays without a choice.
  func testADiscardWhoseChoiceCannotBeKeptLeavesTheBarAndSaysSo() async throws {
    let model = try makeModel()
    await model.appear()
    let old = await unknownSend(model, "Discard, the ledger refusing writes.")
    await store.refuseWrites(of: UnknownSends.key(for: "m1"))
    await model.discardUnknownSend()
    XCTAssertEqual(model.deliveryMark?.kind, .unknown, "the bar stays")
    XCTAssertEqual(model.deliveryMark?.clientMessageId, old)
    XCTAssertEqual(model.sendError, "This phone could not keep your choice, so nothing changed.")
    XCTAssertEqual(server.attempts, [old], "the server sees no write")
    let records = try await parts.delivery.sends.list()
    XCTAssertEqual(records.map(\.clientMessageId), [old], "the record stays")
    XCTAssertNil(records.first?.choice, "without a choice")
    let claim = await parts.delivery.claimState(old)
    XCTAssertFalse(claim.held, "nothing claimed")
  }

  /// Send again with the ledger refusing writes: the same, and nothing goes out under a new id.
  func testASendAgainWhoseChoiceCannotBeKeptLeavesTheBarAndSaysSo() async throws {
    let model = try makeModel()
    await model.appear()
    let text = "Send again, the ledger refusing writes."
    let old = await unknownSend(model, text)
    await store.refuseWrites(of: UnknownSends.key(for: "m1"))
    await model.resendUnderNewId()
    XCTAssertEqual(model.deliveryMark?.kind, .unknown, "the bar stays")
    XCTAssertEqual(model.deliveryMark?.clientMessageId, old)
    XCTAssertEqual(model.sendError, "This phone could not keep your choice, so nothing changed.")
    XCTAssertEqual(server.attempts, [old], "nothing written, under the old id or a new one")
    XCTAssertEqual(model.draft, text, "the draft stays")
    let records = try await parts.delivery.sends.list()
    XCTAssertEqual(records.map(\.clientMessageId), [old], "the record stays")
    XCTAssertNil(records.first?.choice, "without a choice")
  }

  // MARK: - A send such a pass delivers: what the composer keeps

  /// N1a: text appended to the kept draft and a second file picked after the unknown send; the pass
  /// (no choice made) delivers the send: the composer keeps exactly what was added since.
  func testWhenAPassDeliversTheSendOnlyTheTextAndTheFileAddedSinceStay() async throws {
    let model = try makeModel()
    await model.appear()
    model.attach(try file("first.txt"))
    let text = "The first message."
    let old = await unknownSend(model, text)
    model.attach(try file("second.txt"))
    model.draft = text + " And a second thought."
    await model.flushDraft()
    server.answerStatus(.answer("absent"), for: old)
    let asked = try await addSentinel()
    await dropSocket()
    await passFinished(asked)
    await until("the bar gone") { model.deliveryMark == nil }
    XCTAssertEqual(server.kept, [old])
    XCTAssertEqual(model.draft.trimmingCharacters(in: .whitespaces), "And a second thought.", "only the added text stays")
    XCTAssertEqual(model.pendingFiles.map(\.name), ["second.txt"], "only the file picked since stays")
  }

  /// N1b: the same, the screen closed while the pass delivers, then the controller recreated over a
  /// copy of the store.
  func testWhatWasAddedSinceTheSendStaysAfterTheScreenClosesAndTheControllerIsRecreated() async throws {
    let model = try makeModel(keep: false)
    await model.appear()
    model.attach(try file("first-b.txt"))
    let text = "The first message, b."
    let old = await unknownSend(model, text)
    model.attach(try file("second-b.txt"))
    model.draft = text + " And a second thought, b."
    await model.flushDraft()
    server.answerStatus(.held, for: old)
    let asked = try await addSentinel()
    await dropSocket()
    await until("the pass holds at the old id's status read") { server.isHoldingStatus(of: old) }
    model.disappear()
    server.answerStatus(.answer("absent"), for: old)
    server.answerHeldStatus(of: old, .answer("absent"))
    await passFinished(asked)
    await modelledRestart()
    let restarted = try makeModel()
    await restarted.appear()
    XCTAssertEqual(server.kept, [old])
    XCTAssertEqual(restarted.draft.trimmingCharacters(in: .whitespaces), "And a second thought, b.", "only the added text stays")
    XCTAssertEqual(restarted.pendingFiles.map(\.name), ["second-b.txt"], "only the file picked since stays")
  }

  /// N1c: nothing added after the unknown send: the delivered draft and file both leave, and the
  /// field stays empty after the controller is recreated.
  func testWithNothingAddedSinceTheSendTheFieldEmptiesAndStaysEmptyAfterTheControllerIsRecreated() async throws {
    let model = try makeModel()
    await model.appear()
    model.attach(try file("only.txt"))
    let text = "Only this."
    let old = await unknownSend(model, text)
    server.answerStatus(.answer("absent"), for: old)
    let asked = try await addSentinel()
    await dropSocket()
    await passFinished(asked)
    await until("the bar gone") { model.deliveryMark == nil }
    XCTAssertEqual(model.draft, "")
    XCTAssertEqual(model.pendingFiles, [])
    await modelledRestart()
    let restarted = try makeModel()
    await restarted.appear()
    XCTAssertEqual(restarted.draft, "")
  }

  /// A9: a send of unknown outcome that carried a picked file (the server kept it, its answer lost);
  /// the controller recreated over a copy of the store; the restarted conversation open, showing the
  /// bar, the file back on its composer. A pass then delivers the send live: the file leaves the
  /// composer, nothing can be sent from the emptied field, and a further Send writes nothing.
  func testAfterARestartAPassThatDeliversLiveTakesTheCarriedFilesOffTheOpenComposer() async throws {
    let model = try makeModel()
    await model.appear()
    model.attach(try file("carried-a9.txt"))
    let old = await unknownSend(model, "The message that carried a file.", kept: true)
    await model.flushDraft()
    await modelledRestart()
    let restarted = try makeModel()
    await restarted.appear()
    XCTAssertEqual(restarted.deliveryMark?.kind, .unknown, "the restarted conversation shows the bar")
    XCTAssertEqual(restarted.pendingFiles.map(\.name), ["carried-a9.txt"], "with the carried file on its composer")
    server.answerStatus(.answer("accepted"), for: old)
    let asked = try await addSentinel()
    await dropSocket()
    await passFinished(asked)
    await until("the composer follows the delivery") { restarted.deliveryNotice != nil }
    XCTAssertEqual(server.attempts, [old], "found accepted: the pass wrote nothing")
    XCTAssertEqual(restarted.pendingFiles, [], "the carried file left the composer")
    XCTAssertEqual(restarted.draft, "", "and the text sent left the field")
    XCTAssertFalse(restarted.canSend, "nothing to send from the empty field")
    await restarted.send()
    XCTAssertEqual(server.attempts.count, 1, "a further Send writes nothing")
  }

  // MARK: - Another conversation's send while this pass is held

  /// N2a: A's pass held at A's status read; B (same machine) sends and is accepted; A discards; A's
  /// screen closes; the held read answers absent. B is kept once, A never written.
  func testAnotherConversationsAcceptedSendWhileThePassHoldsIsKeptOnceAndTheDiscardedSendIsNeverWritten() async throws {
    let a = try makeModel("s1")
    let b = try makeModel("s2", hearsPush: false)
    await a.appear()
    await b.appear()
    let (oldA, asked) = try await unknownSendWithAPassHoldingIt(a, "A's message.")
    b.draft = "B's message, sent while A's pass holds."
    await b.send()
    let idB = server.attempts.last ?? ""
    let discard = Task { await a.discardUnknownSend() }
    await eventually("Discard waits for the pass") { await parts.delivery.claimState(oldA).waiting == 1 }
    discard.cancel()
    a.disappear()
    server.answerStatus(.answer("absent"), for: oldA)
    server.answerHeldStatus(of: oldA, .answer("absent"))
    await discard.value
    await passFinished(asked)
    let c = try makeModel("s3")
    await c.appear()
    try await laterPass()
    XCTAssertEqual(server.attempts.filter { $0 == oldA }.count, 1, "A's id only its lost original")
    XCTAssertEqual(server.kept.filter { $0 == idB }.count, 1, "B kept once")
    XCTAssertFalse(server.kept.contains(oldA))
  }

  /// N2b: B's own send ends unknown while A's pass is held; A discards and A's screen closes; then a
  /// later pass settles B: B is delivered once under its id, A never written.
  func testAnotherConversationsUnknownSendWhileThePassHoldsIsDeliveredOnceAndTheDiscardedSendIsNeverWritten() async throws {
    let a = try makeModel("s1")
    let b = try makeModel("s2", hearsPush: false)
    await a.appear()
    await b.appear()
    let (oldA, asked) = try await unknownSendWithAPassHoldingIt(a, "A's message, again.")
    server.planWrites(.loseBeforeKept)
    server.answerStatusByDefault(.unreadable)
    b.draft = "B's message, lost while A's pass holds."
    await b.send()
    let idB = server.attempts.last ?? ""
    let discard = Task { await a.discardUnknownSend() }
    await eventually("Discard waits for the pass") { await parts.delivery.claimState(oldA).waiting == 1 }
    discard.cancel()
    a.disappear()
    server.answerStatus(.answer("absent"), for: oldA)
    server.answerHeldStatus(of: oldA, .answer("absent"))
    await discard.value
    await passFinished(asked)
    server.answerStatus(.answer("absent"), for: idB)
    // A third conversation hears the push and runs the later pass.
    let c = try makeModel("s3")
    await c.appear()
    try await laterPass()
    XCTAssertEqual(server.attempts.filter { $0 == oldA }.count, 1, "A's id only its lost original")
    XCTAssertEqual(server.kept.filter { $0 == idB }.count, 1, "B delivered once")
    XCTAssertFalse(server.kept.contains(oldA))
  }
}

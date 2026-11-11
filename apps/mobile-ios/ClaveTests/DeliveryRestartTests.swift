@testable import ClaveCore
import XCTest
@testable import Clave

// What the person's choice on a send of unknown outcome, and a send a pass delivers, leave behind
// across a restart, against DeliveryRaceTests' server: DeliveryChatServer holds a pass at the old
// id's status read. A restart here is MODELLED: every model closed, then new controllers, drafts and
// attachment drafts over a copy of what the store held (the controller is recreated), or over the
// same file read again by a fresh FileKeyValueStore (a reload of the file). No test ends a process.
// From the verifier's round-5 probes A1, A2, A3, N1a, N1b, N1c, N2a and N2b, and round 5c's N2 (a
// send no ledger holds).

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

  private var refusingOnce: [String: Int] = [:]

  /// Refuses one write of `key`: the one that comes after the next `skipping` writes of it.
  func refuseOnce(_ key: String, skipping: Int = 0) { refusingOnce[key] = skipping }

  private func checkOnce(_ key: String) throws {
    guard let skip = refusingOnce[key] else { return }
    if skip > 0 {
      refusingOnce[key] = skip - 1
      return
    }
    refusingOnce[key] = nil
    throw LedgerWriteRefused()
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
    try checkOnce(key)
    if key == refusing { throw LedgerWriteRefused() }
    try await inner.set(key, value)
  }

  func remove(_ key: String) async throws {
    try checkOnce(key)
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

  // MARK: - A send no ledger holds (round 5c's N2)

  private let orphanId = "m-orphan-00000000000000001"

  /// The conversation's mark says unknown for a send no ledger holds (its record dropped by a rerun
  /// of the move, or removed by a settle that ended before it cleared the mark), seeded as the round
  /// 5c app probe seeds it: the conversation open on it showing the bar, and a new draft typed.
  private func orphanBar(draft: String = "A new message after the restart.") async throws -> ConversationModel {
    try await parts.delivery.marks.set(
      "m1", "s1", DeliveryMark(kind: .unknown, clientMessageId: orphanId, reason: "Delivery has not been confirmed.", at: 1))
    let model = try makeModel()
    await model.appear()
    XCTAssertEqual(model.deliveryMark?.kind, .unknown, "the bar shows")
    model.draft = draft
    await model.flushDraft()
    return model
  }

  /// Discard on the bar of a send no ledger holds: the bar goes, the composer says the phone cannot
  /// tell whether the message was delivered, nothing is written, the draft stays and the stored mark
  /// is gone; the person's next Send is one write.
  func testADiscardOnASendNoLedgerHoldsClearsTheBarSaysTheOutcomeCannotBeKnownAndSendsNothing() async throws {
    let draft = "A new message after the restart."
    let model = try await orphanBar(draft: draft)
    await model.discardUnknownSend()
    XCTAssertNil(model.deliveryMark, "the bar goes")
    XCTAssertEqual(model.deliveryNotice, ConversationModel.lostTrack)
    XCTAssertNil(model.sendError)
    XCTAssertTrue(model.canSend, "the person can send")
    XCTAssertEqual(model.draft, draft, "the draft is unchanged")
    XCTAssertEqual(server.attempts.count, 0, "nothing written")
    let stored = try await parts.delivery.marks.get("m1", "s1")
    XCTAssertNil(stored, "the stored mark is gone")
    await model.send()
    XCTAssertEqual(server.attempts.count, 1, "exactly one write: the person's own send")
  }

  /// Send again on the bar of a send no ledger holds: nothing is written under any id, the bar goes,
  /// the composer says the phone did not send it again, and the draft and the picked file stay.
  func testASendAgainOnASendNoLedgerHoldsWritesNothingAndKeepsTheDraftAndTheFile() async throws {
    let draft = "A new message after the restart."
    let model = try await orphanBar(draft: draft)
    model.attach(try file("orphan-send-again.txt"))
    await model.flushDraft()
    let picked = model.pendingFiles
    XCTAssertEqual(picked.map(\.name), ["orphan-send-again.txt"], "one file picked")
    await model.resendUnderNewId()
    XCTAssertEqual(server.attempts.count, 0, "nothing written, under the old id or a new one")
    XCTAssertNil(model.deliveryMark, "the bar goes")
    XCTAssertEqual(model.deliveryNotice, ConversationModel.lostTrackNotSent)
    XCTAssertEqual(model.draft, draft, "the draft is unchanged")
    XCTAssertEqual(model.pendingFiles, picked, "the picked file stays")
    XCTAssertTrue(model.canSend, "the person can send")
  }

  /// Two Send again taps on that bar, back to back: nothing is written, and the composer says the
  /// phone did not send it again.
  func testTwoSendAgainTapsOnASendNoLedgerHoldsWriteNothing() async throws {
    let model = try await orphanBar()
    let first = Task { await model.resendUnderNewId() }
    let second = Task { await model.resendUnderNewId() }
    await first.value
    await second.value
    XCTAssertEqual(server.attempts.count, 0, "nothing written")
    XCTAssertEqual(model.deliveryNotice, ConversationModel.lostTrackNotSent)
  }

  /// One file attached and a send of unknown outcome; then the draft extended and a second file
  /// attached, both on the device; then the send's record taken out of the ledger (the residual's
  /// effect), its mark kept. Returns the model that sent it.
  private func sendWhoseRecordLeftTheLedger() async throws -> ConversationModel {
    let model = try makeModel()
    await model.appear()
    model.attach(try file("orphan-first.txt"))
    let old = await unknownSend(model, "Sent text.")
    model.attach(try file("orphan-second.txt"))
    model.draft = "Sent text. And more."
    await model.flushDraft()
    try await parts.delivery.sends.remove(old)
    let ledgerAfter = try await ledger()
    XCTAssertEqual(ledgerAfter, [], "the record left the ledger")
    let mark = try await parts.delivery.marks.get("m1", "s1")
    XCTAssertEqual(mark?.clientMessageId, old, "its mark is kept")
    return model
  }

  /// What was typed and picked since the send stays after a restart: the restarted conversation
  /// shows the bar, and a Discard leaves the draft and both files exactly as they are, writes nothing,
  /// and says the phone cannot tell whether the message was delivered.
  func testWhatWasTypedAndPickedSinceStaysWhenADiscardAfterARestartFindsTheSendInNoLedger() async throws {
    _ = try await sendWhoseRecordLeftTheLedger()
    await modelledRestart()
    let restarted = try makeModel()
    await restarted.appear()
    XCTAssertEqual(restarted.deliveryMark?.kind, .unknown, "the restarted conversation shows the bar")
    let writes = server.attempts
    await restarted.discardUnknownSend()
    XCTAssertNil(restarted.deliveryMark, "the bar goes")
    XCTAssertEqual(restarted.draft, "Sent text. And more.", "the draft exactly as it was")
    XCTAssertEqual(restarted.pendingFiles.map(\.name), ["orphan-first.txt", "orphan-second.txt"], "both files stay")
    XCTAssertEqual(restarted.deliveryNotice, ConversationModel.lostTrack)
    XCTAssertEqual(server.attempts, writes, "nothing written")
  }

  /// The same in one run: the model whose own send set what it carried. A Discard still leaves the
  /// draft and both files.
  func testWhatWasTypedAndPickedSinceStaysWhenADiscardInTheSameRunFindsTheSendInNoLedger() async throws {
    let model = try await sendWhoseRecordLeftTheLedger()
    let writes = server.attempts
    await model.discardUnknownSend()
    XCTAssertNil(model.deliveryMark, "the bar goes")
    XCTAssertEqual(model.draft, "Sent text. And more.", "the draft exactly as it was")
    XCTAssertEqual(model.pendingFiles.map(\.name), ["orphan-first.txt", "orphan-second.txt"], "both files stay")
    XCTAssertEqual(model.deliveryNotice, ConversationModel.lostTrack)
    XCTAssertEqual(server.attempts, writes, "nothing written")
  }

  /// A mark that goes without a delivery this run saw (neither a choice nor a pass of this run took
  /// it) is never said delivered: once the bar is gone, the composer says nothing, and the draft is
  /// unchanged.
  func testAMarkThatGoesWithoutADeliveryThisRunSawIsNeverSaidDelivered() async throws {
    let draft = "A new message after the restart."
    let model = try await orphanBar(draft: draft)
    try await parts.delivery.marks.clear("m1", "s1")
    await until("the bar gone") { model.deliveryMark == nil }
    // Whatever the mark's read leads to has run.
    try await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertNil(model.deliveryNotice, "nothing says delivered")
    XCTAssertEqual(model.draft, draft, "the draft is unchanged")
  }

  // MARK: - A completion attempt the server refuses (Addendum E)

  /// What the bar says once the server refused this phone's attempt to complete a send.
  private func holdSentence(_ message: String) -> String {
    "The server refused this phone's new attempt to send this message (\(message)), so the phone will not try again by itself. Whether the message arrived is still unknown."
  }

  /// One file attached and a send of unknown outcome; a pass held at the old id's status read; the
  /// next write planned refused as `refusal` says, with the server's sentence `message`; the held
  /// read answers absent, so the pass's same-id write is refused. The bar then says the phone will
  /// not try again, the draft and the file stay, and nothing can be sent; after a restart the new
  /// model shows the same bar. Returns the restarted model and the old id.
  private func refusedCompletionThenRestart(
    _ refusal: DeliveryChatServer.Write, message: String, file name: String
  ) async throws -> (ConversationModel, String) {
    let model = try makeModel()
    await model.appear()
    model.attach(try file(name))
    let (old, asked) = try await unknownSendWithAPassHoldingIt(model, "Sent text.")
    server.planWrites(refusal)
    server.answerHeldStatus(of: old, .answer("absent"))
    await passFinished(asked)
    XCTAssertEqual(server.attempts, [old, old], "the lost original and the refused completion")
    XCTAssertEqual(server.kept, [], "nothing kept")
    await until("the bar says the phone will not try again") { model.deliveryMark?.reason == holdSentence(message) }
    XCTAssertEqual(model.deliveryMark?.kind, .unknown, "the send stays unknown")
    XCTAssertEqual(model.deliveryMark?.reason, holdSentence(message))
    XCTAssertEqual(model.draft, "Sent text.", "the draft stays")
    XCTAssertEqual(model.pendingFiles.map(\.name), [name], "the file stays")
    XCTAssertFalse(model.canSend, "the bar stands")
    await modelledRestart()
    let restarted = try makeModel()
    await restarted.appear()
    XCTAssertEqual(restarted.deliveryMark?.clientMessageId, old, "the restarted conversation shows the bar")
    XCTAssertEqual(restarted.deliveryMark?.reason, holdSentence(message), "the same bar")
    return (restarted, old)
  }

  /// The same, the write refused with an HTTP status and a body `{"message": …}`.
  private func refusedCompletionThenRestart(status: Int, message: String) async throws -> (ConversationModel, String) {
    try await refusedCompletionThenRestart(.refuse(status: status, message: message), message: message, file: "refused-\(status).txt")
  }

  /// After the restart, a later pass finds the old id absent and the server would now accept a
  /// write: the pass writes nothing for the old id, nothing says delivered, and the bar, the draft
  /// and the file stay.
  private func aLaterPassWritesNothingAfterARefusedCompletion(
    _ refusal: DeliveryChatServer.Write, message: String, file name: String
  ) async throws {
    let (restarted, old) = try await refusedCompletionThenRestart(refusal, message: message, file: name)
    server.answerStatus(.answer("absent"), for: old)
    let writes = server.attempts.filter { $0 == old }.count
    try await laterPass()
    // Whatever the mark's read leads to has run.
    try await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertEqual(server.attempts.filter { $0 == old }.count, writes, "the later pass writes nothing for the old id")
    XCTAssertNil(restarted.deliveryNotice, "nothing says delivered")
    XCTAssertEqual(restarted.deliveryMark?.reason, holdSentence(message), "the bar stays")
    XCTAssertEqual(restarted.draft, "Sent text.", "the draft stays")
    XCTAssertEqual(restarted.pendingFiles.map(\.name), [name], "the file stays")
  }

  /// The same, the write refused with an HTTP status and a body `{"message": …}`.
  private func aLaterPassWritesNothingAfterARefusedCompletion(status: Int, message: String) async throws {
    try await aLaterPassWritesNothingAfterARefusedCompletion(
      .refuse(status: status, message: message), message: message, file: "refused-\(status).txt")
  }

  /// The countercase, a late original: after the same refused completion and restart, the later
  /// pass's status answers accepted (the first write landed late). The send is settled delivered with
  /// no write in that pass: the bar goes, the composer says so, the field keeps only what was added
  /// since, and the carried file leaves.
  private func aLateOriginalIsSettledDeliveredAfterARefusedCompletion(
    _ refusal: DeliveryChatServer.Write, message: String, file name: String
  ) async throws {
    let (restarted, old) = try await refusedCompletionThenRestart(refusal, message: message, file: name)
    restarted.draft = "Sent text. And more."
    await restarted.flushDraft()
    server.answerStatus(.answer("accepted"), for: old)
    let writes = server.attempts
    try await laterPass()
    await until("the composer follows the delivery") { restarted.deliveryNotice != nil }
    XCTAssertEqual(server.attempts, writes, "no write in that pass")
    XCTAssertNil(restarted.deliveryMark, "the bar goes")
    XCTAssertEqual(restarted.deliveryNotice, "This message was delivered when the connection came back.")
    XCTAssertEqual(restarted.draft, "And more.", "the field keeps only what was added since")
    XCTAssertEqual(restarted.pendingFiles, [], "the carried file leaves")
  }

  /// A pass's same-id write refused with 403: no write of the send happens again by itself, after a
  /// restart too.
  func testAfterTheServerRefusesTheCompletionWith403APassWritesTheSendNoMoreAfterARestart() async throws {
    try await aLaterPassWritesNothingAfterARefusedCompletion(status: 403, message: "A phone may not do this.")
  }

  /// The same with 401.
  func testAfterTheServerRefusesTheCompletionWith401APassWritesTheSendNoMoreAfterARestart() async throws {
    try await aLaterPassWritesNothingAfterARefusedCompletion(status: 401, message: "The server refused the token.")
  }

  /// The countercase after a 403: the late original found accepted is settled delivered with no write.
  func testAfterARefusedCompletionALateOriginalFoundAcceptedIsSettledDeliveredWithNoWrite() async throws {
    try await aLateOriginalIsSettledDeliveredAfterARefusedCompletion(
      .refuse(status: 403, message: "A phone may not do this."), message: "A phone may not do this.", file: "refused-403.txt")
  }

  // MARK: - A refusal the server declares (Addendum F)

  /// A pass's same-id write answered 422 SessionWriteRefused, with the contract's failure body: held
  /// as a 403 is, so no write of the send happens again by itself, after a restart too.
  func testAfterTheServerDeclaresTheCompletionRefusedWith422APassWritesTheSendNoMoreAfterARestart() async throws {
    try await aLaterPassWritesNothingAfterARefusedCompletion(
      .refuseDeclared(tag: "SessionWriteRefused", message: "The provider refused the message."),
      message: "The provider refused the message.", file: "refused-422.txt")
  }

  /// Its countercase: the late original found accepted after the restart is settled delivered with
  /// no write.
  func testAfterADeclaredRefusalOfTheCompletionALateOriginalFoundAcceptedIsSettledDeliveredWithNoWrite() async throws {
    try await aLateOriginalIsSettledDeliveredAfterARefusedCompletion(
      .refuseDeclared(tag: "SessionWriteRefused", message: "The provider refused the message."),
      message: "The provider refused the message.", file: "refused-422.txt")
  }

  // MARK: - A send whose mark could not be written (Addendum G)

  /// The first red proof: the conversation's mark write refused once inside the send's begin. The
  /// composer says the message was not sent and keeps the draft and the file; after a modelled restart,
  /// a pass that would find any send absent never reads or writes it, and the ledger is empty.
  func testASendWhoseMarkCannotBeWrittenIsUndoneSoNoPassEverCompletesIt() async throws {
    let model = try makeModel()
    await model.appear()
    model.attach(try file("not-recorded.txt"))
    model.draft = "Sent text."
    await model.flushDraft()
    await store.refuseOnce(deliveryMarkKey("m1", "s1"))
    await model.send()
    XCTAssertEqual(model.sendError, "This phone could not keep a record of the message, so it was not sent.")
    XCTAssertEqual(model.draft, "Sent text.", "the draft stays")
    XCTAssertEqual(model.pendingFiles.map(\.name), ["not-recorded.txt"], "the file stays")
    XCTAssertEqual(server.attempts, [], "nothing written")
    await modelledRestart()
    let restarted = try makeModel()
    await restarted.appear()
    // Any send the later pass asks about is found absent, so a record left behind would be written.
    server.answerStatusByDefault(.answer("absent"))
    try await laterPass()
    XCTAssertEqual(server.attempts, [], "the later pass writes nothing")
    XCTAssertEqual(server.asks.filter { $0 != sentinelId }, [], "and reads no status but the sentinel's")
    let ledgerAfter = try await ledger()
    XCTAssertEqual(ledgerAfter, [], "the ledger is empty")
  }

  /// The second proof: the mark write refused and the undo refused too. The composer does not say the
  /// message was not sent: it shows the bar of a record kept without its mark, keeps the draft and the
  /// file, and nothing can be sent; after a modelled restart the new composer shows the same bar; a pass
  /// then completes the send under its id, and the composer says so, keeping only what was added since.
  func testASendKeptWithoutItsMarkShowsAsUnknownAndAPassCompletesItUnderItsId() async throws {
    let model = try makeModel()
    await model.appear()
    model.attach(try file("kept-without-mark.txt"))
    model.draft = "Sent text."
    await model.flushDraft()
    await store.refuseOnce(deliveryMarkKey("m1", "s1"))
    // The record's add goes through; the undo's removal after it is refused.
    await store.refuseOnce(UnknownSends.key(for: "m1"), skipping: 1)
    await model.send()
    XCTAssertNil(model.sendError, "never said not sent")
    XCTAssertEqual(model.deliveryMark?.kind, .unknown, "the bar shows")
    XCTAssertEqual(model.deliveryMark?.reason, ConversationModel.recordedWithoutMark)
    XCTAssertEqual(model.draft, "Sent text.", "the draft stays")
    XCTAssertEqual(model.pendingFiles.map(\.name), ["kept-without-mark.txt"], "the file stays")
    XCTAssertFalse(model.canSend, "the bar stands")
    XCTAssertEqual(server.attempts, [], "nothing written yet")
    let kept = try await ledger()
    XCTAssertEqual(kept.count, 1, "the record stays")
    let id = kept.first ?? ""
    XCTAssertEqual(model.deliveryMark?.clientMessageId, id, "the bar names it")
    await modelledRestart()
    let restarted = try makeModel()
    await restarted.appear()
    XCTAssertEqual(restarted.deliveryMark?.clientMessageId, id, "the restarted composer shows the same bar")
    XCTAssertEqual(restarted.deliveryMark?.reason, ConversationModel.recordedWithoutMark)
    restarted.draft = "Sent text. And more."
    await restarted.flushDraft()
    server.answerStatus(.answer("absent"), for: id)
    try await laterPass()
    await until("the composer follows the delivery") { restarted.deliveryNotice != nil }
    XCTAssertEqual(server.kept, [id], "completed once, under its id")
    XCTAssertNil(restarted.deliveryMark, "the bar goes")
    XCTAssertEqual(restarted.deliveryNotice, "This message was delivered when the connection came back.")
    XCTAssertEqual(restarted.draft, "And more.", "the field keeps only what was added since")
    XCTAssertEqual(restarted.pendingFiles, [], "the file the send carried leaves")
  }

  /// A Discard whose record removal failed leaves the record with its choice and no mark: the choice is
  /// being carried out, so no bar shows for it, now or after a modelled restart.
  func testARecordLeftWithItsChoiceByADiscardWhoseRemovalFailedShowsNoBar() async throws {
    let model = try makeModel()
    await model.appear()
    let old = await unknownSend(model, "Discard, its removal refused.")
    // The choice's write into the record goes through; the record's removal after the mark's clear is refused.
    await store.refuseOnce(UnknownSends.key(for: "m1"), skipping: 1)
    await model.discardUnknownSend()
    let records = try await parts.delivery.sends.list()
    XCTAssertEqual(records.map(\.clientMessageId), [old], "the record stays")
    XCTAssertEqual(records.first?.choice, .discard, "with its choice")
    let mark = try await parts.delivery.marks.get("m1", "s1")
    XCTAssertNil(mark, "the mark was cleared")
    XCTAssertNil(model.deliveryMark, "no bar")
    await modelledRestart()
    let restarted = try makeModel()
    await restarted.appear()
    XCTAssertNil(restarted.deliveryMark, "no bar after a restart either")
    XCTAssertEqual(server.attempts, [old], "nothing written beyond the lost original")
  }

  // MARK: - Round 5d's gap K20 and 5b's note n5

  /// K20: the composer's own send whose completion is refused (the first write lost, the status
  /// absent, the same-id write 403): the record stays in the ledger with its refusal, the mark says the
  /// hold, and the draft and the file stay.
  func testTheComposersOwnSendWhoseCompletionIsRefusedKeepsItsRecordTheHoldAndItsDraft() async throws {
    let model = try makeModel()
    await model.appear()
    model.attach(try file("own-refused.txt"))
    model.draft = "Sent text."
    server.planWrites(.loseBeforeKept, .refuse(status: 403, message: "A phone may not do this."))
    server.answerStatusByDefault(.answer("absent"))
    await model.send()
    let id = server.attempts.first ?? ""
    XCTAssertEqual(server.attempts, [id, id], "the lost first write and the refused completion")
    let records = try await parts.delivery.sends.list()
    XCTAssertEqual(records.map(\.clientMessageId), [id], "the record stays")
    XCTAssertEqual(records.first?.writeRefused, "A phone may not do this.", "with its refusal")
    let mark = try await parts.delivery.marks.get("m1", "s1")
    XCTAssertEqual(mark?.kind, .unknown, "the send stays unknown")
    XCTAssertEqual(mark?.reason, holdSentence("A phone may not do this."), "the mark says the hold")
    XCTAssertEqual(model.deliveryMark?.reason, holdSentence("A phone may not do this."), "and so does the bar")
    XCTAssertEqual(model.draft, "Sent text.", "the draft stays")
    XCTAssertEqual(model.pendingFiles.map(\.name), ["own-refused.txt"], "the file stays")
  }

  /// n5: an older send reconciled unknown while the conversation's mark names a newer send: the newer
  /// send's stored mark stays byte-equal, and once that one is delivered and its mark cleared, the
  /// composer shows the older send's bar.
  func testAnOlderSendReconciledUnknownKeepsANewerSendsMarkAndShowsItsBarOnceThatOneIsDelivered() async throws {
    let older = "m-n5-older-000000000000a"
    let newer = "m-n5-newer-000000000000b"
    try await parts.delivery.sends.add(UnknownSend(machineId: "m1", sessionId: "s1", clientMessageId: older, text: "The older message.", at: 1))
    try await parts.delivery.sends.add(UnknownSend(machineId: "m1", sessionId: "s1", clientMessageId: newer, text: "The newer message.", at: 2))
    try await parts.delivery.marks.set(
      "m1", "s1", DeliveryMark(kind: .unknown, clientMessageId: newer, reason: "Delivery has not been confirmed.", at: 2))
    let model = try makeModel()
    await model.appear()
    XCTAssertEqual(model.deliveryMark?.clientMessageId, newer, "the bar names the newer send")
    let before = await store.values[deliveryMarkKey("m1", "s1")]
    server.answerStatus(.answer("unknown"), for: older)
    server.answerStatus(.held, for: newer)
    let asked = try await addSentinel()
    await dropSocket()
    await until("the pass holds at the newer send's status read") { server.isHoldingStatus(of: newer) }
    let during = await store.values[deliveryMarkKey("m1", "s1")]
    XCTAssertEqual(during, before, "the older send's unknown settle leaves the newer send's mark byte-equal")
    server.answerHeldStatus(of: newer, .answer("accepted"))
    await passFinished(asked)
    await until("the composer shows the older send's bar") { model.deliveryMark?.clientMessageId == older }
    XCTAssertEqual(model.deliveryMark?.kind, .unknown, "the older send is still unknown")
    XCTAssertEqual(server.attempts, [], "nothing written")
  }
}

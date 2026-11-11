import XCTest
@testable import ClaveCore

// A completion attempt the server refuses (lane A's Addendums E and F). A same-id write of a send of
// unknown outcome answered 401 or 403, or 422 SessionWriteRefused or SessionNotFound, proves only
// that this attempt was refused: the first write, whose answer was lost, may still land. The send
// stays unknown, its record carries the refusal, and no write of it happens again by itself until the
// person chooses; a status answer of accepted or rejected still settles it. A FIRST write refused
// with 401 or 403 stays failed, and with those 422 tags rejected. The passes run over
// the production store, a FileKeyValueStore seen through an owner's namespace as AppModel builds it,
// in a temporary folder; a second store over the same folder reads the file, so what it finds is what
// a RELOAD of the file finds, and a controller built over it is a recreated one. No test here ends a
// process.

private let machine = "m1"
private let session = "s1"
private let text = "The message the server refused to complete."
private let forbidden = ServerError(.forbidden, "A phone may not do this.", status: 403)
private let unauthenticated = ServerError(.unauthenticated, "The server refused the token.", status: 401)
private let unreachable = ServerError(.network, "The server could not be reached.")

/// A refusal the server declares, as a 422 with the contract's failure carries it.
private func declared(_ tag: String, _ message: String = "The provider refused the message.") -> ServerError {
  ServerError(.refused, message, status: 422, failure: ServerFailure(tag: tag, message: message))
}

/// What the bar says once the server refused this phone's attempt to complete the send.
private func hold(_ reason: String) -> String {
  "The server refused this phone's new attempt to send this message (\(reason)), so the phone will not try again by itself. Whether the message arrived is still unknown."
}

/// The production store over `directory`, in an owner's namespace.
private func ownerStore(_ directory: URL, namespace: String = "owner-a") -> OwnerScopedKeyValueStore {
  OwnerScopedKeyValueStore(base: FileKeyValueStore(directory: directory), namespace: namespace)
}

private func controller(over store: any KeyValueStore) -> DeliveryController {
  DeliveryController(
    sends: UnknownSends(store: store, machineId: machine), marks: DeliveryMarks(store: store), drafts: Drafts(store: store),
    attachmentDrafts: AttachmentDrafts(store: store))
}

private func unknownSend(_ id: String) -> UnknownSend {
  UnknownSend(machineId: machine, sessionId: session, clientMessageId: id, text: text, at: 1)
}

/// One send's ports: the first write answers `first`, every later write `then`, the status route
/// `status`; the writes and the status reads counted.
private final class SendProbe: @unchecked Sendable {
  let first: Result<WriteAnswer, any Error>
  let then: Result<WriteAnswer, any Error>
  let status: WriteStatus
  let writes = Box(0)
  let statusReads = Box(0)

  init(first: Result<WriteAnswer, any Error>, status: WriteStatus.Kind, then: Result<WriteAnswer, any Error> = .success(WriteAnswer(status: .accepted))) {
    self.first = first
    self.then = then
    self.status = WriteStatus(status: status)
  }

  var ports: SendPorts {
    SendPorts(
      write: { [self] _ in
        let n = writes.mutate { $0 += 1; return $0 }
        return try (n == 1 ? first : then).get()
      },
      status: { [self] _ in
        statusReads.mutate { $0 += 1 }
        return status
      },
      sleep: { _ in }, now: { 0 })
  }
}

/// A pass's ports answered with one status for every send, each write refused with `refusing` when
/// it is set, else accepted: its writes (refused ones included) and its status reads counted.
private final class PassProbe: @unchecked Sendable {
  let status: WriteStatus
  let refusing: ServerError?
  let writes = Box<[String]>([])
  let statusReads = Box(0)

  init(_ status: WriteStatus.Kind, reason: String? = nil, refusing: ServerError? = nil) {
    self.status = WriteStatus(status: status, reason: reason)
    self.refusing = refusing
  }

  func run(_ controller: DeliveryController) async throws {
    try await controller.reconnect(
      machineId: machine, openConversations: [],
      status: { [self] _ in
        statusReads.mutate { $0 += 1 }
        return status
      },
      write: { [self] send in
        writes.mutate { $0.append(send.clientMessageId) }
        if let refusing { throw refusing }
        return WriteAnswer(status: .accepted)
      },
      refreshRequests: { _ in }, refreshHistory: { _, _ in }, sleep: { _ in })
  }
}

private struct Refused: Error {}

/// A store over another that refuses the next write (set or remove) of each key it is told, once.
private actor OnceRefusingStore: KeyValueStore {
  private let inner: any KeyValueStore
  private var refusing: Set<String> = []

  init(_ inner: any KeyValueStore) {
    self.inner = inner
  }

  func refuseNextWrite(of key: String) { refusing.insert(key) }

  func get(_ key: String) async throws -> String? { try await inner.get(key) }

  func set(_ key: String, _ value: String) async throws {
    if refusing.remove(key) != nil { throw Refused() }
    try await inner.set(key, value)
  }

  func remove(_ key: String) async throws {
    if refusing.remove(key) != nil { throw Refused() }
    try await inner.remove(key)
  }
}

final class ChatWriteRefusalTests: XCTestCase {
  private var directory: URL!

  override func setUp() async throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent("clave-refusal-\(UUID().uuidString)", isDirectory: true)
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: directory)
  }

  /// What a reload of the file finds: m1's ledger and the conversation's mark.
  private func reloaded() async throws -> (ledger: [UnknownSend], mark: DeliveryMark?) {
    let store = ownerStore(directory)
    let ledger = try await UnknownSends(store: store, machineId: machine).list()
    let mark = try await DeliveryMarks(store: store).get(machine, session)
    return (ledger, mark)
  }

  /// The string a reload of the file finds under `key` in an owner's namespace.
  private func stored(_ key: String, namespace: String = "owner-a") async throws -> String? {
    try await ownerStore(directory, namespace: namespace).get(key)
  }

  // MARK: - How a send ends

  /// A FIRST write refused with 403 or 401 (nothing was pending before) stays failed, as before.
  func testAFirstWriteRefusedWith403Or401StaysFailed() async {
    for refusal in [forbidden, unauthenticated] {
      let id = "m-first-refused-\(refusal.status ?? 0)"
      let probe = SendProbe(first: .failure(refusal), status: .absent)
      let outcome = await sendMessage(id, ports: probe.ports)
      XCTAssertEqual(outcome, .failed(clientMessageId: id, reason: refusal.message), "\(refusal.status ?? 0)")
      XCTAssertEqual(probe.writes.value, 1, "one write")
      XCTAssertEqual(probe.statusReads.value, 0, "no status read")
    }
  }

  /// The first write lost, the status absent, the same-id write refused with 403 or 401: the send is
  /// writeRefused, with the server's sentence.
  func testASameIdWriteRefusedWith403Or401AfterALostFirstWriteIsWriteRefused() async {
    for refusal in [forbidden, unauthenticated] {
      let id = "m-completion-refused-\(refusal.status ?? 0)"
      let probe = SendProbe(first: .failure(unreachable), status: .absent, then: .failure(refusal))
      let outcome = await sendMessage(id, ports: probe.ports)
      XCTAssertEqual(outcome, .writeRefused(clientMessageId: id, reason: refusal.message), "\(refusal.status ?? 0)")
      XCTAssertEqual(probe.writes.value, 2, "the lost first write and the refused completion")
    }
  }

  /// The first write lost, the status absent, the same-id write timing out: still unknown.
  func testASameIdWriteTimingOutAfterALostFirstWriteStaysUnknown() async {
    let id = "m-completion-timeout-0001"
    let probe = SendProbe(
      first: .failure(unreachable), status: .absent, then: .failure(ServerError(.timeout, "The server did not answer within 30 s.")))
    let outcome = await sendMessage(id, ports: probe.ports)
    XCTAssertEqual(outcome, .unknown(clientMessageId: id, reason: "The message was sent again once and its outcome is still not known."))
    XCTAssertEqual(probe.writes.value, 2)
  }

  /// A first write cancelled may have left the phone: it is reconciled, and ends unknown.
  func testAFirstWriteCancelledIsReconciledAndEndsUnknown() async {
    let id = "m-first-cancelled-000001"
    let probe = SendProbe(first: .failure(CancellationError()), status: .unknown)
    let outcome = await sendMessage(id, ports: probe.ports)
    XCTAssertEqual(outcome, .unknown(clientMessageId: id, reason: "The server cannot say whether the message arrived."))
    XCTAssertEqual(probe.statusReads.value, 1, "its status was asked")
  }

  /// The first write lost, the status absent, the same-id write answered 422 SessionWriteRefused or
  /// SessionNotFound (a refusal the server declared, of this attempt only): writeRefused, with the
  /// server's sentence.
  func testASameIdWriteDeclaredRefusedWith422AfterALostFirstWriteIsWriteRefused() async {
    for tag in ["SessionWriteRefused", "SessionNotFound"] {
      let id = "m-completion-422-\(tag)"
      let probe = SendProbe(first: .failure(unreachable), status: .absent, then: .failure(declared(tag)))
      let outcome = await sendMessage(id, ports: probe.ports)
      XCTAssertEqual(outcome, .writeRefused(clientMessageId: id, reason: "The provider refused the message."), tag)
      XCTAssertEqual(probe.writes.value, 2, "the lost first write and the refused completion")
    }
  }

  /// A control: a FIRST write answered 422 SessionWriteRefused or SessionNotFound (nothing was
  /// pending before) stays rejected, and is never asked about.
  func testAFirstWriteDeclaredRefusedWith422StaysRejected() async {
    for tag in ["SessionWriteRefused", "SessionNotFound"] {
      let id = "m-first-422-\(tag)"
      let probe = SendProbe(first: .failure(declared(tag)), status: .absent)
      let outcome = await sendMessage(id, ports: probe.ports)
      XCTAssertEqual(outcome, .rejected(clientMessageId: id, reason: "The provider refused the message."), tag)
      XCTAssertEqual(probe.writes.value, 1, "one write")
      XCTAssertEqual(probe.statusReads.value, 0, "never asked about")
    }
  }

  /// A control: the first write lost and the status answered rejected (the server's own answer about
  /// the id) stays rejected, with nothing written again.
  func testAStatusAnsweredRejectedStaysRejected() async {
    let id = "m-status-rejected-000001"
    let probe = SendProbe(first: .failure(unreachable), status: .rejected)
    let outcome = await sendMessage(id, ports: probe.ports)
    XCTAssertEqual(outcome, .rejected(clientMessageId: id, reason: "The server refused the message."))
    XCTAssertEqual(probe.writes.value, 1, "no same-id write")
  }

  /// A control: the first write lost, the status absent, the same-id write answered 422 with another
  /// tag (SessionWriteUnknown included): still unknown.
  func testASameIdWriteRefusedWith422UnderAnotherTagStaysUnknown() async {
    for tag in ["SessionWriteUnknown", "GatewayFailed"] {
      let id = "m-completion-422-\(tag)"
      let probe = SendProbe(first: .failure(unreachable), status: .absent, then: .failure(declared(tag, "Refused.")))
      let outcome = await sendMessage(id, ports: probe.ports)
      XCTAssertEqual(outcome, .unknown(clientMessageId: id, reason: "Refused."), tag)
      XCTAssertEqual(probe.writes.value, 2)
    }
  }

  // MARK: - A pass whose same-id write is refused

  /// The send recorded unknown, then a pass that finds it absent and whose same-id write the server
  /// refuses with `refusal`: the send is held. Asserts the hold (the record stays and carries the
  /// refusal, the mark says unknown for it with the hold's sentence) and returns the controller.
  private func heldSend(_ id: String, refusing refusal: ServerError = forbidden) async throws -> DeliveryController {
    let first = controller(over: ownerStore(directory))
    try await recordUnknownSend(unknownSend(id), reason: "lost", sends: first.sends, marks: first.marks)
    let probe = PassProbe(.absent, refusing: refusal)
    try await probe.run(first)
    XCTAssertEqual(probe.writes.value, [id], "one same-id write, refused")
    let found = try await reloaded()
    XCTAssertEqual(found.ledger.map(\.clientMessageId), [id], "the record stays")
    XCTAssertEqual(found.ledger.first?.writeRefused, refusal.message, "and carries the refusal")
    XCTAssertEqual(found.mark?.kind, .unknown, "the send stays unknown")
    XCTAssertEqual(found.mark?.clientMessageId, id, "the mark names it")
    XCTAssertEqual(found.mark?.reason, hold(refusal.message), "with the hold's sentence")
    return first
  }

  /// After a reload, a pass that finds the held send absent reads its status and writes nothing, and
  /// the record and the mark stay byte-equal.
  func testAfterAReloadAPassFindingAHeldSendAbsentReadsItsStatusAndWritesNothing() async throws {
    let id = "m-held-absent-0000000001"
    _ = try await heldSend(id)
    let ledgerBefore = try await stored(UnknownSends.key(for: machine))
    let markBefore = try await stored(deliveryMarkKey(machine, session))
    let probe = PassProbe(.absent)
    try await probe.run(controller(over: ownerStore(directory)))
    XCTAssertEqual(probe.statusReads.value, 1, "its status is read")
    XCTAssertEqual(probe.writes.value, [], "and nothing written")
    let ledgerAfter = try await stored(UnknownSends.key(for: machine))
    let markAfter = try await stored(deliveryMarkKey(machine, session))
    XCTAssertEqual(ledgerAfter, ledgerBefore, "the record, byte-equal")
    XCTAssertEqual(markAfter, markBefore, "the mark, byte-equal")
  }

  /// After a reload, a pass that finds the held send accepted (the first write landed late) settles
  /// it delivered: the record out, the mark cleared, nothing written.
  func testAfterAReloadAPassFindingAHeldSendAcceptedSettlesItDelivered() async throws {
    let id = "m-held-accepted-00000001"
    _ = try await heldSend(id)
    let probe = PassProbe(.accepted)
    try await probe.run(controller(over: ownerStore(directory)))
    XCTAssertEqual(probe.writes.value, [], "nothing written")
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [], "the record out")
    XCTAssertNil(found.mark, "the mark cleared")
  }

  /// After a reload, a pass that finds the held send rejected settles it rejected: the record out,
  /// the refusal marked.
  func testAfterAReloadAPassFindingAHeldSendRejectedSettlesItRejected() async throws {
    let id = "m-held-rejected-00000001"
    _ = try await heldSend(id)
    let probe = PassProbe(.rejected, reason: "The provider refused the message.")
    try await probe.run(controller(over: ownerStore(directory)))
    XCTAssertEqual(probe.writes.value, [], "nothing written")
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [], "the record out")
    XCTAssertEqual(found.mark?.kind, .rejected, "marked rejected")
    XCTAssertEqual(found.mark?.reason, "The provider refused the message.")
  }

  /// A pass whose same-id write the server answers 422 SessionWriteRefused holds the send as a 403
  /// does. After a reload, a pass that finds it absent reads its status and writes nothing; a later
  /// pass that finds it accepted (the first write landed late) settles it delivered.
  func testAPassWhoseCompletionIsDeclaredRefusedHoldsTheSendUntilTheLateOriginalSettlesIt() async throws {
    let id = "m-held-422-0000000000001"
    _ = try await heldSend(id, refusing: declared("SessionWriteRefused"))
    let absent = PassProbe(.absent)
    try await absent.run(controller(over: ownerStore(directory)))
    XCTAssertEqual(absent.statusReads.value, 1, "its status is read")
    XCTAssertEqual(absent.writes.value, [], "and nothing written")
    let held = try await reloaded()
    XCTAssertEqual(held.ledger.first?.writeRefused, "The provider refused the message.", "the hold stays")
    let accepted = PassProbe(.accepted)
    try await accepted.run(controller(over: ownerStore(directory)))
    XCTAssertEqual(accepted.writes.value, [], "nothing written")
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [], "the late original settled delivered: the record out")
    XCTAssertNil(found.mark, "the mark cleared")
  }

  /// The record write of the hold refused once: the settle throws, the mark keeps its reason (no hold
  /// is claimed), and a second pass of the same run (the same controller, the status absent) writes
  /// nothing.
  func testARefusedRecordWriteOfTheHoldClaimsNoHoldAndTheSameRunStillWritesNothing() async throws {
    let id = "m-held-record-refused-01"
    let store = OnceRefusingStore(ownerStore(directory))
    let c = controller(over: store)
    try await recordUnknownSend(unknownSend(id), reason: "lost", sends: c.sends, marks: c.marks)
    await store.refuseNextWrite(of: UnknownSends.key(for: machine))
    let first = PassProbe(.absent, refusing: forbidden)
    do {
      try await first.run(c)
      XCTFail("the record write of the hold was not refused")
    } catch is Refused {}
    XCTAssertEqual(first.writes.value, [id], "one same-id write, refused")
    let found = try await reloaded()
    XCTAssertEqual(found.mark?.kind, .unknown, "the send stays unknown")
    XCTAssertEqual(found.mark?.reason, "lost", "the mark keeps its reason: no hold claimed")
    XCTAssertNil(found.ledger.first?.writeRefused, "the record carries no refusal")
    let second = PassProbe(.absent)
    var secondThrew = false
    do { try await second.run(c) } catch { secondThrew = true }
    XCTAssertEqual(second.writes.value, [], "this run writes it no more")
    XCTAssertFalse(secondThrew, "and settles nothing")
  }

  // MARK: - What the hold leaves as it is

  /// A newer send B owns the conversation's mark: the hold of the older send A leaves B's mark
  /// byte-equal.
  func testTheHoldOfAnOlderSendLeavesANewerSendsMarkByteEqual() async throws {
    let older = "m-held-older-0000000000a"
    let newer = "m-held-newer-0000000000b"
    let c = controller(over: ownerStore(directory))
    try await recordUnknownSend(unknownSend(older), reason: "lost", sends: c.sends, marks: c.marks)
    try await c.marks.set(machine, session, DeliveryMark(kind: .unknown, clientMessageId: newer, reason: "Delivery has not been confirmed.", at: 2))
    let markBefore = try await stored(deliveryMarkKey(machine, session))
    let probe = PassProbe(.absent, refusing: forbidden)
    try await probe.run(c)
    XCTAssertEqual(probe.writes.value, [older], "A's one same-id write, refused")
    let found = try await reloaded()
    XCTAssertEqual(found.ledger.first?.writeRefused, forbidden.message, "A is held")
    let markAfter = try await stored(deliveryMarkKey(machine, session))
    XCTAssertEqual(markAfter, markBefore, "B's mark, byte-equal")
  }

  /// The same send in two owners' stores over one file: the hold in owner A's store leaves owner B's
  /// record and mark byte-equal.
  func testTheHoldInOneOwnersStoreLeavesTheOtherOwnersRecordAndMarkByteEqual() async throws {
    let id = "m-held-two-owners-000001"
    // One file under both owners' namespaces, as AppModel scopes its one store.
    let base = FileKeyValueStore(directory: directory)
    let ownerA = OwnerScopedKeyValueStore(base: base, namespace: "owner-a")
    let ownerB = OwnerScopedKeyValueStore(base: base, namespace: "owner-b")
    for owner in [ownerA, ownerB] {
      try await recordUnknownSend(
        unknownSend(id), reason: "lost", sends: UnknownSends(store: owner, machineId: machine), marks: DeliveryMarks(store: owner))
    }
    let ledgerOfB = try await stored(UnknownSends.key(for: machine), namespace: "owner-b")
    let markOfB = try await stored(deliveryMarkKey(machine, session), namespace: "owner-b")
    XCTAssertNotNil(ledgerOfB, "B's record is in the file")
    let probe = PassProbe(.absent, refusing: forbidden)
    try await probe.run(controller(over: ownerA))
    let found = try await reloaded()
    XCTAssertEqual(found.ledger.first?.writeRefused, forbidden.message, "A is held")
    let ledgerOfBAfter = try await stored(UnknownSends.key(for: machine), namespace: "owner-b")
    let markOfBAfter = try await stored(deliveryMarkKey(machine, session), namespace: "owner-b")
    XCTAssertEqual(ledgerOfBAfter, ledgerOfB, "B's record, byte-equal")
    XCTAssertEqual(markOfBAfter, markOfB, "B's mark, byte-equal")
  }

  // MARK: - The person's choice on a held send

  /// Discard on a held send answers discarded and writes nothing: the record and the mark go, and a
  /// pass afterwards has nothing to ask about.
  func testADiscardOnAHeldSendAnswersDiscardedAndWritesNothing() async throws {
    let id = "m-held-discard-000000001"
    let c = try await heldSend(id)
    let resolution = try await c.discardPending(machineId: machine, sessionId: session, clientMessageId: id, choice: .discard)
    XCTAssertEqual(resolution, .discarded)
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [], "the record out")
    XCTAssertNil(found.mark, "the mark gone")
    let probe = PassProbe(.absent)
    try await probe.run(c)
    XCTAssertEqual(probe.statusReads.value, 0, "nothing to ask about")
    XCTAssertEqual(probe.writes.value, [], "nothing written")
  }

  /// Send again on a held send takes the old one out, and the composer's send of the draft then goes
  /// under a new id: one write of the new id, none of the old.
  func testASendAgainOnAHeldSendTakesTheOldOutAndTheDraftGoesUnderANewId() async throws {
    let old = "m-held-send-again-000001"
    let c = try await heldSend(old)
    let resolution = try await c.discardPending(machineId: machine, sessionId: session, clientMessageId: old, choice: .sendAgain)
    XCTAssertEqual(resolution, .discarded, "the old send is taken out")
    // The composer's send of the draft under a new id, as ConversationModel.send drives it.
    let fresh = UnknownSend(machineId: machine, sessionId: session, clientMessageId: "m-held-send-again-new-01", text: text, at: 2)
    let written = Box<[String]>([])
    try await c.begin(fresh)
    let outcome = await sendMessage(
      fresh.clientMessageId,
      ports: SendPorts(
        write: { id in
          written.mutate { $0.append(id) }
          return WriteAnswer(status: .accepted)
        },
        status: { _ in WriteStatus(status: .accepted) }, sleep: { _ in }, now: { 0 }))
    try await c.finish(fresh, outcome)
    XCTAssertEqual(written.value, [fresh.clientMessageId], "one write of the new id, none of the old")
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [], "neither send left in the ledger")
    XCTAssertNil(found.mark, "and no bar")
  }
}

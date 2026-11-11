import XCTest
@testable import ClaveCore

// A choice on a send no ledger holds (round 5c's N2, from its probes O1 and R1), over the
// production store: a FileKeyValueStore seen through an owner's namespace, as AppModel builds it.
// The send's record has left its machine's ledger while its conversation's mark still says the
// outcome is unknown: a settle that ended between two of its writes (the second write refused once,
// as a process end there would leave the file), or the residual of a move that failed. A second
// store over the same folder reads the file, so what it finds is what a RELOAD of the file finds; a
// controller built over it is a recreated one. No test here ends a process.

private let machine = "m1"
private let session = "s1"
private let otherSession = "s2"
private let text = "The message whose record left the ledger."
private let unconfirmed = "Delivery has not been confirmed."
private let residualOldId = "m-legacy-00000000000000r1"
private let residualFreshId = "m-new-000000000000000r1"

/// The production store over `directory`, in an owner's namespace.
private func ownerStore(_ directory: URL, namespace: String = "owner-a") -> OwnerScopedKeyValueStore {
  OwnerScopedKeyValueStore(base: FileKeyValueStore(directory: directory), namespace: namespace)
}

/// A key as the file holds it under owner A's namespace ("<namespace>:<key>").
private func scoped(_ key: String) -> String { "owner-a:\(key)" }

private func controller(over store: any KeyValueStore) -> DeliveryController {
  DeliveryController(
    sends: UnknownSends(store: store, machineId: machine), marks: DeliveryMarks(store: store), drafts: Drafts(store: store),
    attachmentDrafts: AttachmentDrafts(store: store))
}

private func unknownSend(_ id: String, in sessionId: String = session) -> UnknownSend {
  UnknownSend(machineId: machine, sessionId: sessionId, clientMessageId: id, text: text, at: 1)
}

private func unknownMark(_ id: String) -> DeliveryMark {
  DeliveryMark(kind: .unknown, clientMessageId: id, reason: unconfirmed, at: 1)
}

/// A pass's ports answered with one status for every send: its writes and its status reads counted.
private final class PassProbe: @unchecked Sendable {
  let status: WriteStatus
  let writes = Box<[String]>([])
  let statusReads = Box(0)

  init(_ status: WriteStatus.Kind) {
    self.status = WriteStatus(status: status)
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
        return WriteAnswer(status: .accepted)
      },
      refreshRequests: { _ in }, refreshHistory: { _, _ in }, sleep: { _ in })
  }
}

private struct Refused: Error {}

/// A store over another that refuses the next write (set or remove) of each key it is told, once: a
/// write the store failed, or one a process end never let happen.
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

final class ChatOrphanMarkTests: XCTestCase {
  private var directory: URL!

  override func setUp() async throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent("clave-orphan-\(UUID().uuidString)", isDirectory: true)
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: directory)
  }

  /// What a reload of the file finds: m1's ledger and the conversation's mark.
  private func reloaded(_ sessionId: String = session) async throws -> (ledger: [UnknownSend], mark: DeliveryMark?) {
    let store = ownerStore(directory)
    let ledger = try await UnknownSends(store: store, machineId: machine).list()
    let mark = try await DeliveryMarks(store: store).get(machine, sessionId)
    return (ledger, mark)
  }

  /// The string a reload of the file finds under `key` in an owner's namespace.
  private func stored(_ key: String, namespace: String = "owner-a") async throws -> String? {
    try await ownerStore(directory, namespace: namespace).get(key)
  }

  /// Every key and value of the file, as a reload reads it.
  private func fileValues() throws -> [String: String] {
    guard let data = try? Data(contentsOf: FileKeyValueStore(directory: directory).fileURL) else { return [:] }
    return try JSONDecoder().decode([String: String].self, from: data)
  }

  // MARK: - O1: a delivery's settle that ended between the record's removal and the mark's clear

  /// The send begun and delivered: its settle removed the record from the ledger, then the clear of
  /// the mark was refused once, so the settle threw. Returns the controller that saw the delivery.
  private func deliveredSendWhoseMarkClearWasRefused(_ id: String) async throws -> DeliveryController {
    let store = OnceRefusingStore(ownerStore(directory))
    let first = controller(over: store)
    let send = unknownSend(id)
    try await first.begin(send)
    await store.refuseNextWrite(of: deliveryMarkKey(machine, session))
    do {
      try await first.finish(send, .sent(clientMessageId: id, reconciled: false))
      XCTFail("the settle's clear of the mark was not refused")
    } catch is Refused {}
    return first
  }

  /// O1 after a reload: the ledger is empty and the mark still says unknown for the send. The
  /// recreated controller never saw the delivery, so a Discard answers that the outcome cannot be
  /// known and clears the mark; a pass then has nothing to ask about, writes nothing, and the mark
  /// stays gone.
  func testO1AfterAReloadADiscardOnASendWhoseSettleEndedBeforeItsClearSaysTheOutcomeIsUnknownAndClearsTheMark() async throws {
    let id = "m-orphan-o1-reload-000001"
    _ = try await deliveredSendWhoseMarkClearWasRefused(id)
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [], "the record left the ledger")
    XCTAssertEqual(found.mark?.kind, .unknown, "the mark still says unknown")
    XCTAssertEqual(found.mark?.clientMessageId, id, "for the send")
    let restarted = controller(over: ownerStore(directory))
    let resolution = try await restarted.discardPending(machineId: machine, sessionId: session, clientMessageId: id, choice: .discard)
    XCTAssertEqual(resolution, .outcomeUnknown, "this run never saw the server accept it")
    let afterChoice = try await reloaded()
    XCTAssertNil(afterChoice.mark, "the mark is gone")
    let probe = PassProbe(.accepted)
    try await probe.run(restarted)
    XCTAssertEqual(probe.statusReads.value, 0, "the pass has nothing to ask about")
    XCTAssertEqual(probe.writes.value, [], "and writes nothing")
    let afterPass = try await reloaded()
    XCTAssertNil(afterPass.mark, "the mark stays gone")
  }

  /// O1 with the same controller, no reload: it saw the server accept the send, so the Discard
  /// answers that it was delivered meanwhile, and the mark the settle left is cleared.
  func testO1InTheSameRunADiscardOnASendWhoseSettleEndedBeforeItsClearSaysDeliveredAndClearsTheMark() async throws {
    let id = "m-orphan-o1-same-0000001"
    let first = try await deliveredSendWhoseMarkClearWasRefused(id)
    let resolution = try await first.discardPending(machineId: machine, sessionId: session, clientMessageId: id, choice: .discard)
    XCTAssertEqual(resolution, .settledMeanwhile, "this run saw the delivery")
    let found = try await reloaded()
    XCTAssertNil(found.mark, "the mark is gone")
  }

  // MARK: - F and R: the other settles that remove the record first

  /// F: a send that failed plainly; its finish removed the record, then the clear of the mark was
  /// refused once. After a reload, Send again answers that the outcome cannot be known, the mark is
  /// gone, and the ledger stays empty.
  func testFAfterAReloadSendAgainOnAFailedSendWhoseClearWasRefusedSaysTheOutcomeIsUnknownAndClearsTheMark() async throws {
    let id = "m-orphan-f-0000000000001"
    let store = OnceRefusingStore(ownerStore(directory))
    let first = controller(over: store)
    let send = unknownSend(id)
    try await first.begin(send)
    await store.refuseNextWrite(of: deliveryMarkKey(machine, session))
    do {
      try await first.finish(send, .failed(clientMessageId: id, reason: "The server refused the token."))
      XCTFail("the clear of the mark was not refused")
    } catch is Refused {}
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [], "the record was removed")
    XCTAssertEqual(found.mark?.kind, .unknown, "the mark still says unknown")
    XCTAssertEqual(found.mark?.clientMessageId, id, "for the send")
    let resolution = try await controller(over: ownerStore(directory)).discardPending(
      machineId: machine, sessionId: session, clientMessageId: id, choice: .sendAgain)
    XCTAssertEqual(resolution, .outcomeUnknown)
    let after = try await reloaded()
    XCTAssertNil(after.mark, "the mark is gone")
    XCTAssertEqual(after.ledger, [], "the ledger stays empty")
  }

  /// R: a pass found the send refused; its settle removed the record, then the write of the refusal
  /// mark was refused once, so the pass threw. After a reload the record is gone and the mark still
  /// says unknown: Discard answers that the outcome cannot be known, clears the mark, and writes
  /// nothing else.
  func testRAfterAReloadADiscardOnARefusedSendWhoseRefusalMarkWasNeverWrittenSaysTheOutcomeIsUnknown() async throws {
    let id = "m-orphan-r-0000000000001"
    let store = OnceRefusingStore(ownerStore(directory))
    let first = controller(over: store)
    try await recordUnknownSend(unknownSend(id), reason: "lost", sends: first.sends, marks: first.marks)
    await store.refuseNextWrite(of: deliveryMarkKey(machine, session))
    let probe = PassProbe(.rejected)
    do {
      try await probe.run(first)
      XCTFail("the write of the refusal mark was not refused")
    } catch is Refused {}
    XCTAssertEqual(probe.writes.value, [], "a refused send is never written")
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [], "the record is gone")
    XCTAssertEqual(found.mark?.kind, .unknown, "the mark still says unknown")
    XCTAssertEqual(found.mark?.clientMessageId, id, "for the send")
    let before = try fileValues()
    let resolution = try await controller(over: ownerStore(directory)).discardPending(
      machineId: machine, sessionId: session, clientMessageId: id, choice: .discard)
    XCTAssertEqual(resolution, .outcomeUnknown)
    let after = try await reloaded()
    XCTAssertNil(after.mark, "the mark is gone")
    var expected = before
    expected.removeValue(forKey: scoped(deliveryMarkKey(machine, session)))
    XCTAssertEqual(try fileValues(), expected, "nothing written but the mark's clear")
  }

  // MARK: - R1: the residual of a move that failed

  /// The residual (round 5c's probe R1): the older build's shared list holds s1's old send, and s1's
  /// mark says unknown for it. The move's write of m1's ledger is refused once, so the move throws;
  /// m1's connection is made anyway and a new send of s2 begins and is delivered, which makes m1's
  /// ledger; the move runs again, leaves that ledger as it is and removes the old list. Returns the
  /// controller and the stored strings the fresh send left: m1's ledger and s2's mark.
  private func residual() async throws -> (controller: DeliveryController, ledger: String?, freshMark: String?) {
    let store = OnceRefusingStore(ownerStore(directory))
    let old = UnknownSend(
      machineId: machine, sessionId: session, clientMessageId: residualOldId, text: "An older build's send, outcome unknown.", at: 1)
    try await store.set(legacyUnknownSendsKey, encodeStored([old]))
    try await store.set(deliveryMarkKey(machine, session), encodeStored(unknownMark(residualOldId)))
    await store.refuseNextWrite(of: UnknownSends.key(for: machine))
    do {
      try await migrateLegacyUnknownSends(store)
      XCTFail("the move's write of m1's ledger was not refused")
    } catch is Refused {}
    let c = controller(over: store)
    let fresh = unknownSend(residualFreshId, in: otherSession)
    try await c.begin(fresh)
    try await c.finish(fresh, .sent(clientMessageId: residualFreshId, reconciled: false))
    let ledger = try await stored(UnknownSends.key(for: machine))
    let freshMark = try await stored(deliveryMarkKey(machine, otherSession))
    try await migrateLegacyUnknownSends(store)
    return (c, ledger, freshMark)
  }

  /// The residual asserted as accepted (the old record in no ledger, its mark kept); a pass that
  /// finds any send absent then reads no status and writes nothing for it; the person's choice
  /// answers that the outcome cannot be known and clears s1's mark; s2's mark and m1's ledger stay as
  /// the fresh send left them.
  private func choiceOnTheResidual(_ choice: PendingChoice) async throws {
    let (c, ledgerLeft, freshMarkLeft) = try await residual()
    XCTAssertEqual(ledgerLeft, "[]", "the fresh send made m1's ledger and its delivery emptied it")
    XCTAssertNil(freshMarkLeft, "the fresh send was delivered: s2 has no mark")
    let oldList = try await stored(legacyUnknownSendsKey)
    XCTAssertNil(oldList, "the old list is gone")
    let residue = try await reloaded()
    XCTAssertFalse(residue.ledger.contains { $0.clientMessageId == residualOldId }, "the accepted residual: the old record is in no ledger")
    XCTAssertEqual(residue.mark?.kind, .unknown, "s1's mark still says unknown")
    XCTAssertEqual(residue.mark?.clientMessageId, residualOldId, "for the old send")
    let probe = PassProbe(.absent)
    try await probe.run(c)
    XCTAssertEqual(probe.statusReads.value, 0, "the pass reads no status for it")
    XCTAssertEqual(probe.writes.value, [], "and writes nothing")
    let resolution = try await c.discardPending(machineId: machine, sessionId: session, clientMessageId: residualOldId, choice: choice)
    XCTAssertEqual(resolution, .outcomeUnknown)
    let after = try await reloaded()
    XCTAssertNil(after.mark, "s1's mark is gone")
    let freshMark = try await stored(deliveryMarkKey(machine, otherSession))
    let ledger = try await stored(UnknownSends.key(for: machine))
    XCTAssertEqual(freshMark, freshMarkLeft, "s2's mark as the fresh send left it")
    XCTAssertEqual(ledger, ledgerLeft, "m1's ledger as the fresh send left it")
  }

  /// R1, Discard.
  func testR1ADiscardOnTheResidualSaysTheOutcomeIsUnknownAndClearsTheOldSendsMark() async throws {
    try await choiceOnTheResidual(.discard)
  }

  /// R1, Send again.
  func testR1ASendAgainOnTheResidualSaysTheOutcomeIsUnknownAndClearsTheOldSendsMark() async throws {
    try await choiceOnTheResidual(.sendAgain)
  }

  // MARK: - What the choice leaves as it is

  /// A newer send of the same conversation, recorded unknown since, owns the mark: a Discard on the
  /// older send, which no ledger holds, answers that its outcome cannot be known, and the stored
  /// strings of the mark and of m1's ledger are byte-equal before and after.
  func testAChoiceOnASendNoLedgerHoldsLeavesANewerSendsMarkAndTheLedgerByteEqual() async throws {
    let older = "m-orphan-older-00000000a"
    let newer = "m-orphan-newer-00000000b"
    let store = ownerStore(directory)
    let c = controller(over: store)
    try await recordUnknownSend(unknownSend(older), reason: "lost", sends: c.sends, marks: c.marks)
    // The residual's effect: the older send's record left the ledger.
    try await c.sends.remove(older)
    try await recordUnknownSend(unknownSend(newer), reason: "lost", sends: c.sends, marks: c.marks)
    let found = try await reloaded()
    XCTAssertEqual(found.mark?.clientMessageId, newer, "the mark names the newer send")
    XCTAssertEqual(found.ledger.map(\.clientMessageId), [newer], "the older send is in no ledger")
    let markBefore = try await stored(deliveryMarkKey(machine, session))
    let ledgerBefore = try await stored(UnknownSends.key(for: machine))
    let resolution = try await c.discardPending(machineId: machine, sessionId: session, clientMessageId: older, choice: .discard)
    XCTAssertEqual(resolution, .outcomeUnknown)
    let markAfter = try await stored(deliveryMarkKey(machine, session))
    let ledgerAfter = try await stored(UnknownSends.key(for: machine))
    XCTAssertEqual(markAfter, markBefore, "the newer send's mark, byte-equal")
    XCTAssertEqual(ledgerAfter, ledgerBefore, "m1's ledger, byte-equal")
  }

  /// Two Send again on the same orphan mark, started back to back: both answer that the outcome
  /// cannot be known, and the mark is gone.
  func testTwoSendAgainOnTheSameOrphanMarkBothSayTheOutcomeIsUnknownAndTheMarkIsGone() async throws {
    let id = "m-orphan-two-choices-001"
    let store = ownerStore(directory)
    try await DeliveryMarks(store: store).set(machine, session, unknownMark(id))
    let c = controller(over: store)
    let first = Task { try await c.discardPending(machineId: machine, sessionId: session, clientMessageId: id, choice: .sendAgain) }
    let second = Task { try await c.discardPending(machineId: machine, sessionId: session, clientMessageId: id, choice: .sendAgain) }
    let one = try await first.value
    let two = try await second.value
    XCTAssertEqual([one, two], [.outcomeUnknown, .outcomeUnknown], "both say the outcome cannot be known")
    let found = try await reloaded()
    XCTAssertNil(found.mark, "the mark is gone")
  }

  /// Two owners over one file, the same orphan mark (machine, conversation and id) in each
  /// namespace: owner A's Discard answers that the outcome cannot be known and clears A's mark; B's
  /// stored mark is byte-equal.
  func testAChoiceOnOneOwnersOrphanMarkLeavesTheOtherOwnersMarkByteEqual() async throws {
    let id = "m-orphan-two-owners-0001"
    // One file under both owners' namespaces, as AppModel scopes its one store.
    let base = FileKeyValueStore(directory: directory)
    let ownerA = OwnerScopedKeyValueStore(base: base, namespace: "owner-a")
    let ownerB = OwnerScopedKeyValueStore(base: base, namespace: "owner-b")
    try await DeliveryMarks(store: ownerA).set(machine, session, unknownMark(id))
    try await DeliveryMarks(store: ownerB).set(machine, session, unknownMark(id))
    let markOfB = try await stored(deliveryMarkKey(machine, session), namespace: "owner-b")
    XCTAssertNotNil(markOfB, "B's mark is in the file")
    let resolution = try await controller(over: ownerA).discardPending(
      machineId: machine, sessionId: session, clientMessageId: id, choice: .discard)
    XCTAssertEqual(resolution, .outcomeUnknown)
    let markOfAAfter = try await stored(deliveryMarkKey(machine, session), namespace: "owner-a")
    let markOfBAfter = try await stored(deliveryMarkKey(machine, session), namespace: "owner-b")
    XCTAssertNil(markOfAAfter, "A's mark is gone")
    XCTAssertEqual(markOfBAfter, markOfB, "B's mark, byte-equal")
  }

  // MARK: - A pass that delivered but could not clear

  /// A pass reads the send's status, the read held, while a Discard waits for the claim; the clear of
  /// the mark is refused once; the read answers accepted, so the pass's settle removes the record and
  /// throws at the clear. This run saw the server accept the send: the Discard answers that it was
  /// delivered meanwhile, and the mark is gone.
  func testAPassThatDeliveredButCouldNotClearTheMarkLetsTheWaitingDiscardSayDeliveredAndClearIt() async throws {
    let id = "m-orphan-pass-delivered-1"
    let store = OnceRefusingStore(ownerStore(directory))
    let c = controller(over: store)
    try await recordUnknownSend(unknownSend(id), reason: "lost", sends: c.sends, marks: c.marks)
    let entered = Gate()
    let release = Gate()
    let writes = Box<[String]>([])
    let pass = Task {
      try await c.reconnect(
        machineId: machine, openConversations: [],
        status: { _ in
          await entered.open()
          await release.wait()
          return WriteStatus(status: .accepted)
        },
        write: { send in
          writes.mutate { $0.append(send.clientMessageId) }
          return WriteAnswer(status: .accepted)
        },
        refreshRequests: { _ in }, refreshHistory: { _, _ in }, sleep: { _ in })
    }
    await entered.wait()
    let discard = Task { try await c.discardPending(machineId: machine, sessionId: session, clientMessageId: id, choice: .discard) }
    await eventually("the Discard waits for the pass") { await c.claimState(id).waiting == 1 }
    await store.refuseNextWrite(of: deliveryMarkKey(machine, session))
    await release.open()
    do {
      try await pass.value
      XCTFail("the settle's clear of the mark was not refused")
    } catch is Refused {}
    let resolution = try await discard.value
    XCTAssertEqual(resolution, .settledMeanwhile, "this run saw the server accept it")
    XCTAssertEqual(writes.value, [], "found accepted: nothing written")
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [], "the settle removed the record")
    XCTAssertNil(found.mark, "the mark is gone")
  }
}

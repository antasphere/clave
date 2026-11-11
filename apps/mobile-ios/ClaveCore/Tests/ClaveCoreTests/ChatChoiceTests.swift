import XCTest
@testable import ClaveCore

// The person's choice on a send of unknown outcome (Discard, Send again) over the production store:
// a FileKeyValueStore seen through an owner's namespace, as AppModel builds it. A second store over
// the same folder has its own cache and reads the file, so what it finds is what a RELOAD of the
// file finds; a controller built over it is a recreated one. No test here ends a process.

private let machine = "m-choice"
private let session = "s-choice"
private let text = "The message the person chose about."

/// The production store over `directory`.
private func ownerStore(_ directory: URL) -> OwnerScopedKeyValueStore {
  OwnerScopedKeyValueStore(base: FileKeyValueStore(directory: directory), namespace: "owner-a")
}

private func controller(over store: any KeyValueStore) -> DeliveryController {
  DeliveryController(
    sends: UnknownSends(store: store, machineId: machine), marks: DeliveryMarks(store: store), drafts: Drafts(store: store),
    attachmentDrafts: AttachmentDrafts(store: store))
}

private func unknownSend(_ id: String) -> UnknownSend {
  UnknownSend(machineId: machine, sessionId: session, clientMessageId: id, text: text, at: 1)
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

private struct StoreRefused: Error {}

/// The owner's store with two failures it can be told to make: every write of the ledger refused,
/// or the first write of the ledger after the conversation's mark was cleared refused once.
private actor FailingLedgerStore: KeyValueStore {
  private let inner: any KeyValueStore
  private let ledgerKey: String
  private let markKey: String
  private var refusingEveryWrite = false
  private var failingOnceAfterTheMark = false
  private var markCleared = false

  init(_ inner: any KeyValueStore, ledgerKey: String, markKey: String) {
    self.inner = inner
    self.ledgerKey = ledgerKey
    self.markKey = markKey
  }

  func refuseEveryLedgerWrite() { refusingEveryWrite = true }
  func failTheLedgerWriteAfterTheMarkIsCleared() { failingOnceAfterTheMark = true }

  private func check(_ key: String) throws {
    guard key == ledgerKey else { return }
    if refusingEveryWrite { throw StoreRefused() }
    if failingOnceAfterTheMark, markCleared {
      failingOnceAfterTheMark = false
      throw StoreRefused()
    }
  }

  func get(_ key: String) async throws -> String? { try await inner.get(key) }

  func set(_ key: String, _ value: String) async throws {
    try check(key)
    try await inner.set(key, value)
  }

  func remove(_ key: String) async throws {
    try check(key)
    try await inner.remove(key)
    if key == markKey { markCleared = true }
  }
}

/// The owner's store that, once told, holds one read of the ledger: the read that comes after the
/// next `skipping` ones waits, before it reads, until released, so it returns what the ledger holds
/// by then.
private actor LedgerReadHoldingStore: KeyValueStore {
  private let inner: any KeyValueStore
  private let ledgerKey: String
  private var readsToPass: Int?
  private var held: [CheckedContinuation<Void, Never>] = []

  init(_ inner: any KeyValueStore, ledgerKey: String) {
    self.inner = inner
    self.ledgerKey = ledgerKey
  }

  /// Holds the read of the ledger that comes after the next `skipping` ones, once.
  func holdLedgerRead(skipping: Int) { readsToPass = skipping }
  /// How many reads wait.
  var waiting: Int { held.count }
  /// Lets the waiting read go on.
  func release() {
    let waiting = held
    held = []
    for read in waiting { read.resume() }
  }

  func get(_ key: String) async throws -> String? {
    if key == ledgerKey, let passing = readsToPass {
      if passing > 0 {
        readsToPass = passing - 1
      } else {
        readsToPass = nil
        await withCheckedContinuation { held.append($0) }
      }
    }
    return try await inner.get(key)
  }

  func set(_ key: String, _ value: String) async throws { try await inner.set(key, value) }
  func remove(_ key: String) async throws { try await inner.remove(key) }
}

final class ChatChoiceTests: XCTestCase {
  private var directory: URL!

  override func setUp() async throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent("clave-choice-\(UUID().uuidString)", isDirectory: true)
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: directory)
  }

  /// The unknown send recorded over the production store with its draft kept, the claim held as a
  /// pass reconciling it holds it, and the person's choice started: it waits for the claim.
  private func choiceWaitingForTheClaim(_ id: String, _ choice: PendingChoice) async throws -> (DeliveryController, Task<PendingResolution, Error>) {
    let store = ownerStore(directory)
    let first = controller(over: store)
    try await recordUnknownSend(unknownSend(id), reason: "lost", sends: first.sends, marks: first.marks)
    try await Drafts(store: store).set(machine, session, text)
    await first.claim(id)
    let waiting = Task {
      try await first.discardPending(machineId: machine, sessionId: session, clientMessageId: id, choice: choice)
    }
    await eventually("the choice waits for the claim") { await first.claimState(id).waiting == 1 }
    return (first, waiting)
  }

  /// What a reload of the file finds: the ledger, the conversation's mark and its draft.
  private func reloaded() async throws -> (ledger: [UnknownSend], mark: DeliveryMark?, draft: String) {
    let store = ownerStore(directory)
    let ledger = try await UnknownSends(store: store, machineId: machine).list()
    let mark = try await DeliveryMarks(store: store).get(machine, session)
    let draft = try await Drafts(store: store).get(machine, session)
    return (ledger, mark, draft)
  }

  /// Lets the first controller's choice go once the test has read what it needed.
  private func finish(_ first: DeliveryController, _ id: String, _ waiting: Task<PendingResolution, Error>) async {
    await first.release(id)
    _ = try? await waiting.value
  }

  // MARK: - c1 to c6: the choice in the file

  /// c1: while a Discard waits for the claim, the choice is in the file: a reload of the file finds
  /// the send's record with it.
  func testWhileADiscardWaitsForTheClaimItsChoiceIsFoundAfterAReloadOfTheFile() async throws {
    let id = "message-c1"
    let (first, waiting) = try await choiceWaitingForTheClaim(id, .discard)
    let found = try await reloaded()
    XCTAssertEqual(found.ledger.map(\.clientMessageId), [id], "the record stays while the choice waits")
    XCTAssertEqual(found.ledger.first?.choice, .discard, "and carries the choice")
    await finish(first, id, waiting)
  }

  /// c2: the same, then a reload of the file and a recreated controller whose pass finds the send
  /// absent: it reads the status once at most, writes nothing, and carries the Discard out.
  func testAfterAReloadOfTheFileAPassFindingTheDiscardedSendAbsentWritesNothingAndCarriesItOut() async throws {
    let id = "message-c2"
    let (first, waiting) = try await choiceWaitingForTheClaim(id, .discard)
    let probe = PassProbe(.absent)
    try await probe.run(controller(over: ownerStore(directory)))
    XCTAssertEqual(probe.writes.value, [], "no write port call")
    XCTAssertLessThanOrEqual(probe.statusReads.value, 1, "no status read more than one")
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [], "the send left the ledger")
    XCTAssertNil(found.mark, "and its mark")
    await finish(first, id, waiting)
  }

  /// c3: the recreated controller's pass finds the send accepted: it was delivered, and it settles
  /// so (the ledger and the mark gone, the draft that still was the text sent cleared).
  func testAfterAReloadOfTheFileAPassFindingTheDiscardedSendAcceptedSettlesItDelivered() async throws {
    let id = "message-c3"
    let (first, waiting) = try await choiceWaitingForTheClaim(id, .discard)
    let probe = PassProbe(.accepted)
    try await probe.run(controller(over: ownerStore(directory)))
    XCTAssertEqual(probe.writes.value, [])
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [])
    XCTAssertNil(found.mark)
    XCTAssertEqual(found.draft, "", "the draft that was the text sent is cleared")
    await finish(first, id, waiting)
  }

  /// c4: the recreated controller's pass cannot tell: nothing is written, the record stays with its
  /// choice for the next pass, and the mark says unknown.
  func testAfterAReloadOfTheFileAPassThatCannotTellKeepsTheRecordWithItsChoiceAndWritesNothing() async throws {
    let id = "message-c4"
    let (first, waiting) = try await choiceWaitingForTheClaim(id, .discard)
    let probe = PassProbe(.unknown)
    try await probe.run(controller(over: ownerStore(directory)))
    XCTAssertEqual(probe.writes.value, [])
    let found = try await reloaded()
    XCTAssertEqual(found.ledger.map(\.clientMessageId), [id], "the record stays")
    XCTAssertEqual(found.ledger.first?.choice, .discard, "with its choice")
    XCTAssertEqual(found.mark?.kind, .unknown)
    await finish(first, id, waiting)
  }

  /// c5: the recreated controller's pass finds the send refused: the Discard is carried out, so no
  /// refusal mark is left behind.
  func testAfterAReloadOfTheFileAPassFindingTheDiscardedSendRefusedTakesItOutWithNoMark() async throws {
    let id = "message-c5"
    let (first, waiting) = try await choiceWaitingForTheClaim(id, .discard)
    let probe = PassProbe(.rejected)
    try await probe.run(controller(over: ownerStore(directory)))
    XCTAssertEqual(probe.writes.value, [])
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [])
    XCTAssertNil(found.mark, "no rejected mark left")
    await finish(first, id, waiting)
  }

  /// c6: Send again, stored and left by its action, and the recreated controller's pass finds the
  /// send absent: the old id is taken out and never written.
  func testAfterAReloadOfTheFileAPassFindingASendAgainsOldSendAbsentWritesNothingAndTakesItOut() async throws {
    let id = "message-c6"
    let (first, waiting) = try await choiceWaitingForTheClaim(id, .sendAgain)
    let found = try await reloaded()
    XCTAssertEqual(found.ledger.first?.choice, .sendAgain)
    let probe = PassProbe(.absent)
    try await probe.run(controller(over: ownerStore(directory)))
    XCTAssertEqual(probe.writes.value, [], "the old id is never written")
    let after = try await reloaded()
    XCTAssertEqual(after.ledger, [])
    XCTAssertNil(after.mark)
    await finish(first, id, waiting)
  }

  // MARK: - A choice made while the pass reads the ledger (gap C7)

  /// The pass holding the send reads the ledger for a choice an ended run left, and that read is held
  /// after the check of this run's choices; a Discard is made meanwhile, its choice in memory and in
  /// the record. Released, the pass follows the choice as it is made: it makes no status read for the
  /// send and writes nothing, and the Discard resolves discarded.
  func testAChoiceMadeWhileThePassReadsTheLedgerForALeftoverIsFollowedAsItIsMade() async throws {
    let id = "message-c7-hold"
    let store = LedgerReadHoldingStore(ownerStore(directory), ledgerKey: UnknownSends.key(for: machine))
    let first = controller(over: store)
    try await recordUnknownSend(unknownSend(id), reason: "lost", sends: first.sends, marks: first.marks)
    try await Drafts(store: store).set(machine, session, text)
    // The pass reads the ledger for the machine's sends, then in its claim, then for a leftover
    // choice: that third read is held.
    await store.holdLedgerRead(skipping: 2)
    let probe = PassProbe(.accepted)
    let pass = Task { try await probe.run(first) }
    await eventually("the pass holds at its read for a leftover choice") { await store.waiting == 1 }
    let state = await first.claimState(id)
    XCTAssertTrue(state.held, "the pass holds the send")
    let discard = Task {
      try await first.discardPending(machineId: machine, sessionId: session, clientMessageId: id, choice: .discard)
    }
    await eventually("the Discard waits for the pass") { await first.claimState(id).waiting == 1 }
    await store.release()
    try await pass.value
    let resolution = try await discard.value
    XCTAssertEqual(probe.statusReads.value, 0, "no status read for the send")
    XCTAssertEqual(probe.writes.value, [], "nothing written")
    XCTAssertEqual(resolution, .discarded, "the Discard is carried out")
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [])
    XCTAssertNil(found.mark)
  }

  // MARK: - c7: the record's encoding

  /// c7: the choice round-trips under "choice"; a value this build cannot read, or none, is no choice.
  func testTheChoiceRoundTripsAndAnUnreadableOrAbsentChoiceIsNone() throws {
    for choice in [PendingChoice.discard, .sendAgain] {
      let send = UnknownSend(machineId: "m", sessionId: "s", clientMessageId: "message-c7", text: "t", at: 1, choice: choice)
      let stored = try encodeStored(send)
      XCTAssertTrue(stored.contains(#""choice":"\#(choice.rawValue)""#), stored)
      XCTAssertEqual(try JSONDecoder().decode(UnknownSend.self, from: Data(stored.utf8)), send)
    }
    XCTAssertEqual(PendingChoice.sendAgain.rawValue, "send-again")
    let other = #"{"machineId":"m","sessionId":"s","clientMessageId":"message-c7","text":"t","at":1,"choice":"other"}"#
    let unreadable = try JSONDecoder().decode(UnknownSend.self, from: Data(other.utf8))
    XCTAssertNil(unreadable.choice)
    XCTAssertEqual(unreadable.clientMessageId, "message-c7", "the send is still one to ask about")
    let absent = #"{"machineId":"m","sessionId":"s","clientMessageId":"message-c7","text":"t","at":1}"#
    XCTAssertNil(try JSONDecoder().decode(UnknownSend.self, from: Data(absent.utf8)).choice)
    let plain = try encodeStored(UnknownSend(machineId: "m", sessionId: "s", clientMessageId: "message-c7", text: "t", at: 1))
    XCTAssertFalse(plain.contains("choice"), "a send with no choice writes none")
  }

  // MARK: - The order of the writes (Addendum rule 2)

  /// A Discard carried out under its claim, its record's removal failing once after the mark was
  /// cleared, then a reload of the file. Returns the id.
  private func discardWhoseRecordRemovalFailsAfterTheMark() async throws -> String {
    let id = "message-order"
    let store = FailingLedgerStore(
      ownerStore(directory), ledgerKey: UnknownSends.key(for: machine), markKey: deliveryMarkKey(machine, session))
    let first = controller(over: store)
    try await recordUnknownSend(unknownSend(id), reason: "lost", sends: first.sends, marks: first.marks)
    try await Drafts(store: store).set(machine, session, text)
    await store.failTheLedgerWriteAfterTheMarkIsCleared()
    do {
      _ = try await first.discardPending(machineId: machine, sessionId: session, clientMessageId: id, choice: .discard)
      XCTFail("the record's removal did not fail")
    } catch is StoreRefused {}
    let state = await first.claimState(id)
    XCTAssertFalse(state.held, "the claim was let go")
    let found = try await reloaded()
    XCTAssertNil(found.mark, "no bar: the mark was cleared first")
    XCTAssertEqual(found.ledger.map(\.clientMessageId), [id], "the record stays")
    XCTAssertEqual(found.ledger.first?.choice, .discard, "with its choice, for the next pass")
    return id
  }

  /// Rule 2: the state between the two writes (no mark, the record with its choice) is a choice the
  /// next pass carries out: after a reload of the file, a pass finding the send absent writes nothing.
  func testADiscardWhoseRecordRemovalFailedIsCarriedOutAfterAReloadOfTheFileByAPassThatWritesNothing() async throws {
    _ = try await discardWhoseRecordRemovalFailsAfterTheMark()
    let probe = PassProbe(.absent)
    try await probe.run(controller(over: ownerStore(directory)))
    XCTAssertEqual(probe.writes.value, [], "nothing written")
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [])
    XCTAssertNil(found.mark)
  }

  /// Rule 2: the same state, and the pass finds the send accepted: it settles it as delivered.
  func testADiscardWhoseRecordRemovalFailedIsSettledDeliveredAfterAReloadOfTheFileWhenFoundAccepted() async throws {
    _ = try await discardWhoseRecordRemovalFailsAfterTheMark()
    let probe = PassProbe(.accepted)
    try await probe.run(controller(over: ownerStore(directory)))
    XCTAssertEqual(probe.writes.value, [])
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [], "settled")
    XCTAssertNil(found.mark)
    XCTAssertEqual(found.draft, "", "delivered: the draft that was the text sent is cleared")
  }

  // MARK: - A choice the ledger cannot keep (Addendum rule 3)

  /// Rule 3: with the ledger refusing writes, the choice throws ChoiceNotKept without waiting for the
  /// claim a pass holds, and changes nothing: the record stays without a choice, the mark stays.
  func testAChoiceTheLedgerCannotWriteThrowsBeforeItWaitsAndChangesNothing() async throws {
    let id = "message-not-kept"
    let store = FailingLedgerStore(
      ownerStore(directory), ledgerKey: UnknownSends.key(for: machine), markKey: deliveryMarkKey(machine, session))
    let first = controller(over: store)
    try await recordUnknownSend(unknownSend(id), reason: "lost", sends: first.sends, marks: first.marks)
    await store.refuseEveryLedgerWrite()
    await first.claim(id)
    let returned = Box(false)
    let choosing = Task {
      defer { returned.value = true }
      return try await first.discardPending(machineId: machine, sessionId: session, clientMessageId: id, choice: .discard)
    }
    await eventually("the choice returns while the pass holds the send") { returned.value }
    let state = await first.claimState(id)
    XCTAssertEqual(state.waiting, 0, "it never waited for the claim")
    let chosen = await first.hasChoice(id)
    XCTAssertFalse(chosen, "the choice in memory ended with it")
    await first.release(id)
    do {
      _ = try await choosing.value
      XCTFail("the choice was taken as kept")
    } catch is ChoiceNotKept {
    } catch {
      XCTFail("another error: \(error)")
    }
    let found = try await reloaded()
    XCTAssertEqual(found.ledger.map(\.clientMessageId), [id], "the record stays")
    XCTAssertNil(found.ledger.first?.choice, "without a choice")
    XCTAssertEqual(found.mark?.kind, .unknown, "the mark stays")
  }
}

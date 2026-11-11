import XCTest
@testable import ClaveCore

private struct WriteRefused: Error {}

/// A key-value store in memory that, once told, fails the next write (a set or a remove) of one key.
private actor WriteFailingStore: KeyValueStore {
  private let inner: InMemoryKeyValueStore
  private var failing: String?

  init(_ values: [String: String] = [:]) {
    inner = InMemoryKeyValueStore(values)
  }

  /// What the store holds.
  var values: [String: String] {
    get async { await inner.values }
  }

  /// Fails the next write of `key`, once.
  func failNextWrite(of key: String) { failing = key }

  func get(_ key: String) async throws -> String? { try await inner.get(key) }

  func set(_ key: String, _ value: String) async throws {
    try check(key)
    try await inner.set(key, value)
  }

  func remove(_ key: String) async throws {
    try check(key)
    try await inner.remove(key)
  }

  private func check(_ key: String) throws {
    guard key == failing else { return }
    failing = nil
    throw WriteRefused()
  }
}

final class ChatLedgerTests: XCTestCase {
  /// Two machines' sends recorded at the same moment over one owner's store, each through the
  /// ledger its own connection builds: the first machine's add is held between its read of the
  /// ledger and its write while the second machine's add runs to its end. Both records are kept.
  func testTwoMachinesSendsRecordedAtOnceAreBothKept() async throws {
    let store = ReadHoldingStore()
    let m1 = UnknownSends(store: store, machineId: "m1")
    let m2 = UnknownSends(store: store, machineId: "m2")
    await store.holdNextRead(of: UnknownSends.key(for: "m1"))
    let first = Task {
      try await m1.add(UnknownSend(machineId: "m1", sessionId: "s", clientMessageId: "message-m1", text: "from m1", at: 1))
    }
    await eventually("m1's add holds between its read and its write") { await store.waiting == 1 }
    try await m2.add(UnknownSend(machineId: "m2", sessionId: "s", clientMessageId: "message-m2", text: "from m2", at: 2))
    await store.release()
    try await first.value
    let one = try await m1.forMachine("m1").map(\.clientMessageId)
    let two = try await m2.forMachine("m2").map(\.clientMessageId)
    XCTAssertEqual(one, ["message-m1"], "m1's record kept")
    XCTAssertEqual(two, ["message-m2"], "m2's record kept")
  }

  func testEachMachinesLedgerLivesUnderAKeyOfItsOwn() {
    XCTAssertEqual(UnknownSends.key(for: "m_fake"), "clave.unknown-sends:m_fake")
    XCTAssertNotEqual(UnknownSends.key(for: "m1"), UnknownSends.key(for: "m2"))
    XCTAssertEqual(legacyUnknownSendsKey, "clave.unknown-sends")
  }

  // MARK: - The list every machine once shared

  private func record(_ machineId: String, _ id: String, text: String = "t") -> UnknownSend {
    UnknownSend(machineId: machineId, sessionId: "s", clientMessageId: id, text: text, at: 1)
  }

  /// The shared list of two machines' sends: each machine's ledger holds exactly its own records,
  /// in their order, none copied to the other, and the old list is gone.
  func testTheSharedListMovesEachRecordToItsMachinesLedgerAndLeaves() async throws {
    let legacy = [record("m1", "message-1"), record("m2", "message-2"), record("m1", "message-3")]
    let store = InMemoryKeyValueStore([legacyUnknownSendsKey: try encodeStored(legacy)])
    try await migrateLegacyUnknownSends(store)
    let one = try await UnknownSends(store: store, machineId: "m1").list()
    let two = try await UnknownSends(store: store, machineId: "m2").list()
    XCTAssertEqual(one, [legacy[0], legacy[2]], "m1 holds its own records")
    XCTAssertEqual(two, [legacy[1]], "m2 holds its own")
    let values = await store.values
    XCTAssertNil(values[legacyUnknownSendsKey], "the old list is gone")
    XCTAssertEqual(Set(values.keys), [UnknownSends.key(for: "m1"), UnknownSends.key(for: "m2")])
  }

  /// A second run finds no old list and changes nothing.
  func testASecondRunOfTheMoveChangesNothing() async throws {
    let store = InMemoryKeyValueStore([legacyUnknownSendsKey: try encodeStored([record("m1", "message-1")])])
    try await migrateLegacyUnknownSends(store)
    let after = await store.values
    try await migrateLegacyUnknownSends(store)
    let again = await store.values
    XCTAssertEqual(again, after)
  }

  /// A record already in its machine's ledger is not added twice; the one there stays. The ledger
  /// exists, so nothing of the old list joins it: a machine's records move only into a ledger that
  /// does not exist yet.
  func testARecordAlreadyInItsMachinesLedgerIsNotDuplicated() async throws {
    let kept = record("m1", "message-1", text: "as the machine's ledger has it")
    let store = InMemoryKeyValueStore([
      legacyUnknownSendsKey: try encodeStored([record("m1", "message-1", text: "as the old list had it"), record("m1", "message-2")]),
      UnknownSends.key(for: "m1"): try encodeStored([kept]),
    ])
    try await migrateLegacyUnknownSends(store)
    let one = try await UnknownSends(store: store, machineId: "m1").list()
    XCTAssertEqual(one.map(\.clientMessageId), ["message-1"], "each id once, and nothing added to a ledger that exists")
    XCTAssertEqual(one.first, kept, "the record the ledger had stays")
    let values = await store.values
    XCTAssertNil(values[legacyUnknownSendsKey])
  }

  // MARK: - A move whose last write failed, then a second move (N1)

  private let legacyId = "m-legacy-0000000000000001"
  private let legacyText = "Sent by an older build."

  /// What an older build left: the old list holding one send of m1, its conversation marked unknown,
  /// and the draft still the text sent.
  private func olderBuildsStore() async throws -> WriteFailingStore {
    let legacy = UnknownSend(machineId: "m1", sessionId: "s", clientMessageId: legacyId, text: legacyText, at: 1)
    let store = WriteFailingStore([legacyUnknownSendsKey: try encodeStored([legacy])])
    try await DeliveryMarks(store: store).set("m1", "s", DeliveryMark(kind: .unknown, clientMessageId: legacyId, reason: "lost", at: 1))
    try await Drafts(store: store).set("m1", "s", legacyText)
    return store
  }

  /// The move with its last write, the old list's removal, failing: it throws, and the record is in
  /// m1's ledger and still in the old list.
  private func moveWhoseOldListRemovalFails(_ store: WriteFailingStore) async throws {
    await store.failNextWrite(of: legacyUnknownSendsKey)
    do {
      try await migrateLegacyUnknownSends(store)
      XCTFail("the old list's removal did not fail")
    } catch is WriteRefused {}
    let moved = try await UnknownSends(store: store, machineId: "m1").list().map(\.clientMessageId)
    XCTAssertEqual(moved, [legacyId], "the record is in m1's ledger")
    let values = await store.values
    XCTAssertNotNil(values[legacyUnknownSendsKey], "and still in the old list")
  }

  /// m1's delivery controller over `store`, as a launch builds it.
  private func controller(over store: any KeyValueStore, drafts: Drafts? = nil) -> DeliveryController {
    DeliveryController(
      sends: UnknownSends(store: store, machineId: "m1"), marks: DeliveryMarks(store: store), drafts: drafts ?? Drafts(store: store),
      attachmentDrafts: AttachmentDrafts(store: store))
  }

  /// A pass of `controller` over m1, every send's status answered `status`: the ids it wrote.
  private func pass(_ controller: DeliveryController, status: WriteStatus.Kind) async throws -> [String] {
    let writes = Box<[String]>([])
    try await controller.reconnect(
      machineId: "m1", openConversations: [],
      status: { _ in WriteStatus(status: status) },
      write: { send in
        writes.mutate { $0.append(send.clientMessageId) }
        return WriteAnswer(status: .accepted)
      },
      refreshRequests: { _ in }, refreshHistory: { _, _ in }, sleep: { _ in })
    return writes.value
  }

  /// P1, then the second move over the same store.
  private func discardedAfterAFailedMoveThenMovedAgain() async throws -> WriteFailingStore {
    let store = try await olderBuildsStore()
    try await moveWhoseOldListRemovalFails(store)
    let resolution = try await controller(over: store).discardPending(
      machineId: "m1", sessionId: "s", clientMessageId: legacyId, choice: .discard)
    XCTAssertEqual(resolution, .discarded, "the Discard is carried out through m1's ledger")
    try await migrateLegacyUnknownSends(store)
    return store
  }

  /// P1: the old list's removal fails, and the record, moved, is then discarded through m1's ledger.
  /// A second move over the same store adds nothing and removes the old list, so the next launch's
  /// pass never writes the discarded message.
  func testAfterAMoveWhoseOldListRemovalFailedASecondMoveAddsNothingBackForADiscardedSend() async throws {
    let store = try await discardedAfterAFailedMoveThenMovedAgain()
    let ledger = try await UnknownSends(store: store, machineId: "m1").list()
    XCTAssertEqual(ledger.map(\.clientMessageId), [], "the second move added nothing")
    let values = await store.values
    XCTAssertNil(values[legacyUnknownSendsKey], "and removed the old list")
    let written = try await pass(controller(over: store), status: .absent)
    XCTAssertEqual(written, [], "the discarded message is never written")
  }

  /// P2: the same move, and the record is then settled as delivered through m1's ledger (a pass finds
  /// it accepted); the person then writes a new draft that starts with the delivered text. A second
  /// move adds nothing and removes the old list, so the next launch's pass leaves the new draft whole.
  func testAfterAMoveWhoseOldListRemovalFailedASecondMoveAddsNothingBackForADeliveredSend() async throws {
    let store = try await olderBuildsStore()
    try await moveWhoseOldListRemovalFails(store)
    let drafts = Drafts(store: store)
    let delivered = try await pass(controller(over: store, drafts: drafts), status: .accepted)
    XCTAssertEqual(delivered, [], "found accepted, nothing written")
    let settled = try await UnknownSends(store: store, machineId: "m1").list()
    XCTAssertEqual(settled, [], "settled as delivered")
    let followUp = "\(legacyText) And the follow-up."
    try await drafts.set("m1", "s", followUp)
    try await migrateLegacyUnknownSends(store)
    let ledger = try await UnknownSends(store: store, machineId: "m1").list()
    XCTAssertEqual(ledger.map(\.clientMessageId), [], "the second move added nothing")
    let values = await store.values
    XCTAssertNil(values[legacyUnknownSendsKey], "and removed the old list")
    _ = try await pass(controller(over: store), status: .accepted)
    let draft = try await Drafts(store: store).get("m1", "s")
    XCTAssertEqual(draft, followUp, "the new draft is not cut by a second settle")
  }

  /// P3: after P1, the store as the second move leaves it: m1's ledger kept under its key, empty, and
  /// the old key gone.
  func testAfterADiscardTheSecondMoveLeavesTheMachinesLedgerEmptyAndTheOldKeyGone() async throws {
    let store = try await discardedAfterAFailedMoveThenMovedAgain()
    let values = await store.values
    XCTAssertEqual(values[UnknownSends.key(for: "m1")], "[]", "m1's ledger exists, empty")
    XCTAssertNil(values[legacyUnknownSendsKey], "the old key is gone")
  }
}

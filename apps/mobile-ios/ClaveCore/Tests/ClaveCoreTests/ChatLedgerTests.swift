import XCTest
@testable import ClaveCore

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

  /// A record already in its machine's ledger is not added twice; the one there stays, and the
  /// others of the old list join it.
  func testARecordAlreadyInItsMachinesLedgerIsNotDuplicated() async throws {
    let kept = record("m1", "message-1", text: "as the machine's ledger has it")
    let store = InMemoryKeyValueStore([
      legacyUnknownSendsKey: try encodeStored([record("m1", "message-1", text: "as the old list had it"), record("m1", "message-2")]),
      UnknownSends.key(for: "m1"): try encodeStored([kept]),
    ])
    try await migrateLegacyUnknownSends(store)
    let one = try await UnknownSends(store: store, machineId: "m1").list()
    XCTAssertEqual(one.map(\.clientMessageId), ["message-1", "message-2"], "each id once")
    XCTAssertEqual(one.first, kept, "the record the ledger had stays")
    let values = await store.values
    XCTAssertNil(values[legacyUnknownSendsKey])
  }
}

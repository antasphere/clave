import XCTest
@testable import ClaveCore

// What `begin` leaves when its writes fail (lane A's Addendum G), over the production store, a
// FileKeyValueStore seen through an owner's namespace as AppModel builds it, in a temporary folder.
// The composer may say "not sent" only once nothing of the send is left for a pass to complete; a
// record kept without its mark is undone while the send is still held as the composer's, so a pass
// running meanwhile never reads or writes it.

private let machine = "m1"
private let session = "s1"

private func ownerStore(_ directory: URL) -> OwnerScopedKeyValueStore {
  OwnerScopedKeyValueStore(base: FileKeyValueStore(directory: directory), namespace: "owner-a")
}

private func controller(over store: any KeyValueStore) -> DeliveryController {
  DeliveryController(
    sends: UnknownSends(store: store, machineId: machine), marks: DeliveryMarks(store: store), drafts: Drafts(store: store),
    attachmentDrafts: AttachmentDrafts(store: store))
}

private func send(_ id: String) -> UnknownSend {
  UnknownSend(machineId: machine, sessionId: session, clientMessageId: id, text: "Sent text.", at: 1)
}

/// A pass's ports answered absent for every send, each write accepted: its writes and status reads
/// counted.
private final class PassProbe: @unchecked Sendable {
  let writes = Box<[String]>([])
  let statusReads = Box<[String]>([])

  func run(_ controller: DeliveryController) async throws {
    try await controller.reconnect(
      machineId: machine, openConversations: [],
      status: { [self] send in
        statusReads.mutate { $0.append(send.clientMessageId) }
        return WriteStatus(status: .absent)
      },
      write: { [self] send in
        writes.mutate { $0.append(send.clientMessageId) }
        return WriteAnswer(status: .accepted)
      },
      refreshRequests: { _ in }, refreshHistory: { _, _ in }, sleep: { _ in })
  }
}

private struct Refused: Error {}

/// A store over another that, once told, holds the next write (set or remove) of a key until released,
/// then lets it through or refuses it.
private actor HoldingStore: KeyValueStore {
  private let inner: any KeyValueStore
  private var holding: [String: Bool] = [:]
  private var refusing: Set<String> = []
  private var held: [CheckedContinuation<Void, Never>] = []

  init(_ inner: any KeyValueStore) {
    self.inner = inner
  }

  /// Holds the next write of `key`; once released it is refused when `refuse` is true.
  func holdNextWrite(of key: String, refuse: Bool) { holding[key] = refuse }
  /// Refuses the next write of `key`, once, without holding it.
  func refuseNextWrite(of key: String) { refusing.insert(key) }
  /// How many writes wait.
  var waiting: Int { held.count }
  /// Holds and refuses nothing more, and lets the waiting writes and reads go on.
  func disarm() {
    holding = [:]
    refusing = []
    readHold = nil
    release()
    releaseReads()
  }

  private var readHold: (key: String, skip: Int)?
  private var heldReads: [CheckedContinuation<Void, Never>] = []

  /// Holds the read of `key` that comes after `skipping` more reads of it until `releaseReads`. Its
  /// value is read before it waits, so the held read returns what the store held when it began.
  func holdRead(of key: String, skipping: Int) { readHold = (key, skipping) }
  /// How many reads wait.
  var waitingReads: Int { heldReads.count }
  /// Lets the waiting reads go on.
  func releaseReads() {
    let waiting = heldReads
    heldReads = []
    for read in waiting { read.resume() }
  }
  /// Lets the waiting writes go on.
  func release() {
    let waiting = held
    held = []
    for write in waiting { write.resume() }
  }

  private func gate(_ key: String) async throws {
    if refusing.remove(key) != nil { throw Refused() }
    guard let refuse = holding.removeValue(forKey: key) else { return }
    await withCheckedContinuation { held.append($0) }
    if refuse { throw Refused() }
  }

  func get(_ key: String) async throws -> String? {
    let value = try await inner.get(key)
    if let hold = readHold, hold.key == key {
      if hold.skip == 0 {
        readHold = nil
        await withCheckedContinuation { heldReads.append($0) }
      } else {
        readHold = (key, hold.skip - 1)
      }
    }
    return value
  }

  func set(_ key: String, _ value: String) async throws {
    try await gate(key)
    try await inner.set(key, value)
  }

  func remove(_ key: String) async throws {
    try await gate(key)
    try await inner.remove(key)
  }
}

final class ChatBeginRecordTests: XCTestCase {
  private var directory: URL!

  override func setUp() async throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent("clave-begin-\(UUID().uuidString)", isDirectory: true)
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: directory)
  }

  /// What a reload of the file finds: m1's ledger and the conversation's mark.
  private func reloaded() async throws -> (ledger: [UnknownSend], mark: DeliveryMark?) {
    let store = ownerStore(directory)
    return (try await UnknownSends(store: store, machineId: machine).list(), try await DeliveryMarks(store: store).get(machine, session))
  }

  /// A control: `begin` whose ledger write is refused throws `SendNotRecorded` and leaves no record and
  /// no mark.
  func testABeginWhoseRecordCannotBeKeptThrowsSendNotRecordedAndLeavesNothing() async throws {
    let id = "m-begin-add-refused-0001"
    let store = HoldingStore(ownerStore(directory))
    await store.refuseNextWrite(of: UnknownSends.key(for: machine))
    let c = controller(over: store)
    do {
      try await c.begin(send(id))
      XCTFail("begin did not throw")
    } catch is SendNotRecorded {
    } catch {
      XCTFail("another error: \(error)")
    }
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [], "no record")
    XCTAssertNil(found.mark, "no mark")
    let active = await c.isActive(id)
    XCTAssertFalse(active, "the send is not held")
  }

  /// The mark write held inside `begin`, after the record was added, while a pass runs to the end of
  /// the ledger; then released and refused. The pass never reads or writes the send, `begin` undoes
  /// the record and throws `SendNotRecorded`, and a later pass finds nothing.
  func testAPassDuringABeginWhoseMarkWriteFailsNeverReadsOrWritesTheSend() async throws {
    let id = "m-begin-overlap-00000001"
    let store = HoldingStore(ownerStore(directory))
    let c = controller(over: store)
    await store.holdNextWrite(of: deliveryMarkKey(machine, session), refuse: true)
    let beginning = Task { try await c.begin(send(id)) }
    await eventually("the mark write waits") { await store.waiting == 1 }
    let during = PassProbe()
    try await during.run(c)
    XCTAssertEqual(during.statusReads.value, [], "no status read while begin runs")
    XCTAssertEqual(during.writes.value, [], "no write while begin runs")
    await store.release()
    do {
      try await beginning.value
      XCTFail("begin did not throw")
    } catch is SendNotRecorded {
    } catch {
      XCTFail("another error: \(error)")
    }
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [], "the record was undone")
    let after = PassProbe()
    try await after.run(c)
    XCTAssertEqual(after.statusReads.value + during.statusReads.value, [], "no status read of the send at any time")
    XCTAssertEqual(after.writes.value + during.writes.value, [], "no write of the send at any time")
  }

  /// The same with the undo held too: while the record's removal waits, a pass runs to the end of the
  /// ledger and never reads or writes the send; released, the undo succeeds and `begin` throws
  /// `SendNotRecorded`.
  func testAPassDuringTheUndoOfABeginNeverReadsOrWritesTheSend() async throws {
    let id = "m-begin-undo-held-000001"
    let store = HoldingStore(ownerStore(directory))
    let c = controller(over: store)
    await store.holdNextWrite(of: deliveryMarkKey(machine, session), refuse: true)
    let beginning = Task { try await c.begin(send(id)) }
    await eventually("the mark write waits") { await store.waiting == 1 }
    // The next ledger write is the undo's removal of the record.
    await store.holdNextWrite(of: UnknownSends.key(for: machine), refuse: false)
    await store.release()
    await eventually("the undo waits") { await store.waiting == 1 }
    guard await store.waiting == 1 else {
      // No undo came: the hold armed for it would trap a later write, so it is taken back.
      await store.disarm()
      XCTFail("begin never took the record out")
      return
    }
    let during = PassProbe()
    let ended = Box(false)
    let pass = Task {
      defer { ended.value = true }
      try await during.run(c)
    }
    // A pass that took the send would wait behind the held undo in the ledger's queue: it is let go
    // once it has read the send's status.
    await eventually("the pass ends, or reads the send's status") { ended.value || !during.statusReads.value.isEmpty }
    XCTAssertEqual(during.statusReads.value, [], "no status read while the undo runs")
    XCTAssertEqual(during.writes.value, [], "no write while the undo runs")
    await store.release()
    try await pass.value
    do {
      try await beginning.value
      XCTFail("begin did not throw")
    } catch is SendNotRecorded {
    } catch {
      XCTFail("another error: \(error)")
    }
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [], "the record was undone")
    XCTAssertNil(found.mark, "and no mark")
  }

  /// The bar of a send without its mark says only what is known of it: that delivery is not confirmed,
  /// or, for a send whose completion the server refused, its hold, never that it may still be sent
  /// (round 5d's note on the bar's first sentence).
  func testTheBarOfASendWithoutItsMarkSaysOnlyWhatIsKnown() {
    XCTAssertEqual(unconfirmedSendReason(send("m-unmarked-00000000001")), "Delivery has not been confirmed.")
    let held = send("m-unmarked-00000000002").with(writeRefused: "A phone may not do this.")
    XCTAssertEqual(unconfirmedSendReason(held), writeRefusedHold("A phone may not do this."))
    XCTAssertTrue(unconfirmedSendReason(held).contains("will not try again by itself"), "the held send's bar says its hold")
  }

  /// The same order with a pass whose claim would read the ledger while the undo is held, that read
  /// held until the undo has landed and `begin` has ended: a claim would then find the send still
  /// listed and no longer the composer's. A pass skips a send the composer drives before it claims it,
  /// so it never reads or writes the send (round 5d's probe G6; without that skip the old id is
  /// written and the composer's "not sent" follows a completion).
  func testAPassWhoseClaimReadStraddlesTheUndoNeverReadsOrWritesTheSend() async throws {
    let id = "m-begin-claim-read-00001"
    let store = HoldingStore(ownerStore(directory))
    let c = controller(over: store)
    await store.holdNextWrite(of: deliveryMarkKey(machine, session), refuse: true)
    let beginning = Task { try await c.begin(send(id)) }
    await eventually("the mark write waits") { await store.waiting == 1 }
    // The next ledger write is the undo's removal of the record.
    await store.holdNextWrite(of: UnknownSends.key(for: machine), refuse: false)
    await store.release()
    await eventually("the undo waits") { await store.waiting == 1 }
    guard await store.waiting == 1 else {
      await store.disarm()
      XCTFail("begin never took the record out")
      return
    }
    // The pass's first ledger read is its list of the machine's sends; a claim of the send would read
    // the ledger once more, and that read is held.
    await store.holdRead(of: UnknownSends.key(for: machine), skipping: 1)
    let during = PassProbe()
    let ended = Box(false)
    let pass = Task {
      defer { ended.value = true }
      try await during.run(c)
    }
    await eventually("the pass ends, or its claim's read waits") {
      if ended.value { return true }
      return await store.waitingReads == 1
    }
    // The undo lands and `begin` ends while that read, if any, waits.
    await store.release()
    do {
      try await beginning.value
      XCTFail("begin did not throw")
    } catch is SendNotRecorded {
    } catch {
      XCTFail("another error: \(error)")
    }
    await store.releaseReads()
    await store.disarm()
    try await pass.value
    XCTAssertEqual(during.statusReads.value, [], "the send's status never read")
    XCTAssertEqual(during.writes.value, [], "the send never written")
    let found = try await reloaded()
    XCTAssertEqual(found.ledger, [], "the record was undone")
  }
}

@testable import ClaveCore
import XCTest
@testable import Clave

// The list every machine of an owner kept its sends of unknown outcome in, before each machine had a
// ledger of its own, moved to the machines' own ledgers before the owner's first connection is
// built: once, by one task every connection call of that owner waits for.

/// The app's key-value store in memory, counting the reads of the shared list (any owner's) and
/// holding them while told, until released.
actor SharedLedgerReadsStore: KeyValueStore {
  private let inner = InMemoryKeyValueStore()
  private var holding = false
  private var held: [CheckedContinuation<Void, Never>] = []
  /// How many times the shared list was read.
  private(set) var sharedListReads = 0

  /// What the store holds.
  var values: [String: String] {
    get async { await inner.values }
  }

  /// Holds every read of the shared list from now on.
  func holdSharedListReads() { holding = true }
  /// How many reads wait.
  var waiting: Int { held.count }
  /// Lets the waiting reads through and holds no more.
  func release() {
    holding = false
    let waiting = held
    held = []
    for read in waiting { read.resume() }
  }

  func get(_ key: String) async throws -> String? {
    if key.hasSuffix(":\(legacyUnknownSendsKey)") {
      sharedListReads += 1
      if holding { await withCheckedContinuation { held.append($0) } }
    }
    return try await inner.get(key)
  }

  func set(_ key: String, _ value: String) async throws { try await inner.set(key, value) }
  func remove(_ key: String) async throws { try await inner.remove(key) }
}

@MainActor
final class LedgerMigrationTests: XCTestCase {
  private var apps: [AppModel] = []

  override func tearDown() async throws {
    for app in apps {
      for connection in app.connections.values { connection.stop() }
    }
    apps = []
  }

  private func eventually(_ what: String, timeout: TimeInterval = 10, _ condition: () async -> Bool) async {
    let start = Date()
    while Date().timeIntervalSince(start) < timeout {
      if await condition() { return }
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
    XCTFail("Timed out waiting for \(what)")
  }

  /// Two connection calls for two machines of one owner, started together while the move reads the
  /// shared list: the second waits for the same move, so the list is read once; each machine's
  /// ledger then holds exactly its own record, the shared list is gone, and a connection's ledger
  /// reads what was moved.
  func testTwoConnectionsStartedTogetherMoveTheSharedListOnceAndEachMachineGetsItsOwnRecords() async throws {
    let server = UITestFakeServer()
    let kv = SharedLedgerReadsStore()
    let defaults = UserDefaults(suiteName: "clave.ledger-migration-tests")!
    defaults.removePersistentDomain(forName: "clave.ledger-migration-tests")
    let environment = AppEnvironment(
      buildKind: .development, issuer: UITestFakeServer.hubOrigin, relayOverride: UITestFakeServer.relayOrigin,
      transport: UITestFakeTransport(server: server), webSocketTransport: UITestFakeWebSocketTransport(server: server),
      secureStore: InMemorySecureStore(), keyValueStore: kv, opener: UITestFakeOpener(), usesRemoteNotifications: false,
      appearanceDefaults: defaults)
    let signing = try await signInWithTheFakeMachinePaired(environment)
    let namespace = try XCTUnwrap(signing.account.ownerNamespace)
    let machines = try XCTUnwrap(signing.machines)
    let second = "m_second"
    try await machines.credentials.set(
      second,
      Credential(serverUrl: machineBaseURL(relay: UITestFakeServer.relayOrigin, machineId: second), bearer: UITestFakeServer.deviceToken))
    let owner = OwnerScopedKeyValueStore(base: kv, namespace: namespace)
    let legacy = [
      UnknownSend(
        machineId: UITestFakeServer.machineId, sessionId: UITestFakeServer.sessionId, clientMessageId: "m-legacy-fake-000000000000",
        text: "Kept for the fake machine.", at: 1),
      UnknownSend(machineId: second, sessionId: "s2", clientMessageId: "m-legacy-second-0000000000", text: "Kept for the second.", at: 2),
    ]
    try await owner.set(legacyUnknownSendsKey, encodeStored(legacy))

    let app = AppModel(environment: environment)
    await app.start()
    apps.append(app)
    let before = await kv.sharedListReads
    await kv.holdSharedListReads()
    let first = Task { await app.connection(for: UITestFakeServer.machineId) }
    let other = Task { await app.connection(for: second) }
    await eventually("the move holds at its read of the shared list") { await kv.waiting == 1 }
    // Both callers run to their wait: the second one joins the move under way.
    try await Task.sleep(nanoseconds: 300_000_000)
    let during = await kv.sharedListReads
    XCTAssertEqual(during - before, 1, "one read of the shared list while both callers wait")
    await kv.release()
    let a = await first.value
    let b = await other.value
    XCTAssertNotNil(a, "the fake machine's connection")
    XCTAssertNotNil(b, "the second machine's connection")
    let after = await kv.sharedListReads
    XCTAssertEqual(after - before, 1, "the move ran once")
    let values = await kv.values
    XCTAssertNil(values["\(namespace):\(legacyUnknownSendsKey)"], "the shared list is gone")
    let fake = try await UnknownSends(store: owner, machineId: UITestFakeServer.machineId).list()
    let moved = try await UnknownSends(store: owner, machineId: second).list()
    XCTAssertEqual(fake, [legacy[0]], "the fake machine's ledger holds its own record")
    XCTAssertEqual(moved, [legacy[1]], "and the second machine's its own")
    let read = try await a?.delivery.sends.list()
    XCTAssertEqual(read, [legacy[0]], "the connection's ledger reads what was moved")
  }
}

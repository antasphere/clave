import ClaveCore
import XCTest
@testable import Clave

// The conversations of one machine share its delivery parts, made through the app's own factory:
// AppModel.connection(for:) and AppModel.conversation(for:sessionId:in:), on an owner signed in on
// the in-process fake. Also what two calls started together make while a read they await is held.

/// A secure store in memory whose reads of the keys ending with one suffix wait, once told, until
/// released.
actor HeldReadSecureStore: SecureStore {
  private let inner = InMemorySecureStore()
  private var holding: String?
  private var held: [CheckedContinuation<Void, Never>] = []

  /// Holds every read of a key ending with `suffix` from now on.
  func holdReads(endingWith suffix: String) { holding = suffix }
  /// How many reads wait.
  var waiting: Int { held.count }
  /// Lets the waiting reads through and holds no more.
  func release() {
    holding = nil
    let waiting = held
    held = []
    for read in waiting { read.resume() }
  }

  func get(_ key: String) async throws -> String? {
    if let holding, key.hasSuffix(holding) { await withCheckedContinuation { held.append($0) } }
    return try await inner.get(key)
  }

  func set(_ key: String, _ value: String) async throws { try await inner.set(key, value) }
  func delete(_ key: String) async throws { try await inner.delete(key) }
}

/// The fake's transport, with the machine's session list refused and its reads of a session by id
/// held while told, until released.
final class HeldSessionReadTransport: HTTPTransport, @unchecked Sendable {
  private let inner: any HTTPTransport
  private let lock = NSLock()
  private var refusingTheList = false
  private var holding = false
  private var held: [CheckedContinuation<Void, Never>] = []

  init(_ inner: any HTTPTransport) {
    self.inner = inner
  }

  /// The session list answers 503 from now on.
  func refuseTheSessionList() { lock.withLock { refusingTheList = true } }
  /// Every read of a session by id waits from now on.
  func holdSessionReads() { lock.withLock { holding = true } }
  /// How many session reads wait.
  var waiting: Int { lock.withLock { held.count } }
  /// Lets the waiting reads through and holds no more.
  func release() {
    let waiting = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
      holding = false
      defer { held = [] }
      return held
    }
    for read in waiting { read.resume() }
  }

  func perform(_ request: URLRequest) async throws -> HTTPAnswer {
    let path = request.url?.path ?? ""
    let machine = "/m/\(UITestFakeServer.machineId)"
    if path == "\(machine)/sessions", lock.withLock({ refusingTheList }) { return HTTPAnswer(status: 503) }
    if path == "\(machine)/sessions/by-id" {
      await withCheckedContinuation { (read: CheckedContinuation<Void, Never>) in
        let waits = lock.withLock { () -> Bool in
          if holding { held.append(read) }
          return holding
        }
        if !waits { read.resume() }
      }
    }
    return try await inner.perform(request)
  }
}

@MainActor
final class ConversationWiringTests: XCTestCase {
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

  /// An owner signed in on the in-process fake with its machine paired, as ShellTests signs one in,
  /// then the app started again over the same stores, so its machines are listed by the fake's
  /// relay. `keepRecord: false` keeps the credential alone (as a developer machine has no record of
  /// its pairing): the app then reads the enrollment record when it connects.
  private func signedInApp(
    server: UITestFakeServer = UITestFakeServer(),
    secure: any SecureStore = InMemorySecureStore(),
    transport: (any HTTPTransport)? = nil,
    keepRecord: Bool = true
  ) async throws -> AppModel {
    let kv = InMemoryKeyValueStore()
    let defaults = UserDefaults(suiteName: "clave.conversation-wiring-tests")!
    defaults.removePersistentDomain(forName: "clave.conversation-wiring-tests")
    let environment = AppEnvironment(
      buildKind: .development, issuer: UITestFakeServer.hubOrigin, relayOverride: UITestFakeServer.relayOrigin,
      transport: transport ?? UITestFakeTransport(server: server),
      webSocketTransport: UITestFakeWebSocketTransport(server: server), secureStore: secure, keyValueStore: kv,
      opener: UITestFakeOpener(), usesRemoteNotifications: false, appearanceDefaults: defaults)
    if keepRecord {
      try await signInWithTheFakeMachinePaired(environment)
    } else {
      let signing = AppModel(environment: environment)
      await signing.start()
      await signing.account.signIn()
      let machines = try XCTUnwrap(signing.machines)
      let base = machineBaseURL(relay: UITestFakeServer.relayOrigin, machineId: UITestFakeServer.machineId)
      try await machines.credentials.set(UITestFakeServer.machineId, Credential(serverUrl: base, bearer: UITestFakeServer.deviceToken))
    }
    let app = AppModel(environment: environment)
    await app.start()
    apps.append(app)
    return app
  }

  /// M09: every conversation the app makes over one machine's connection sends through that
  /// connection's one controller and keeps its drafts in the connection's own.
  func testEveryConversationMadeOverAConnectionSharesItsDeliveryParts() async throws {
    let app = try await signedInApp()
    let made = await app.connection(for: UITestFakeServer.machineId)
    let connection = try XCTUnwrap(made, "the app made no connection")
    var models: [ConversationModel] = []
    for sessionId in [UITestFakeServer.sessionId, "s_working", "s_waiting"] {
      let model = await app.conversation(for: UITestFakeServer.machineId, sessionId: sessionId, in: connection)
      models.append(try XCTUnwrap(model, "no conversation for \(sessionId)"))
    }
    XCTAssertEqual(Set(models.map(ObjectIdentifier.init)).count, 3, "three conversations")
    for model in models {
      XCTAssertTrue(model.delivery === connection.delivery, "\(model.session.id) sends through the machine's one controller")
      XCTAssertTrue(model.drafts === connection.drafts, "\(model.session.id) keeps its draft in the machine's drafts")
      XCTAssertTrue(model.attachmentDrafts === connection.attachmentDrafts, "and its files in the machine's attachment drafts")
    }
    let again = await app.conversation(for: UITestFakeServer.machineId, sessionId: UITestFakeServer.sessionId, in: connection)
    XCTAssertTrue(again === models.first, "a conversation asked for again is the one made")
  }

  /// Two connection calls for one machine started together while the credential read is held:
  /// both callers wait at once, then get the same connection, the one the app keeps, and the
  /// conversations made over it share its controller.
  private func twoConnectionCallsWhileTheCredentialReadIsHeld(keepRecord: Bool) async throws {
    let secure = HeldReadSecureStore()
    let app = try await signedInApp(secure: secure, keepRecord: keepRecord)
    await secure.holdReads(endingWith: "machine.\(UITestFakeServer.machineId)")
    let first = Task { await app.connection(for: UITestFakeServer.machineId) }
    await eventually("the first call waits at the credential read") { await secure.waiting == 1 }
    let second = Task { await app.connection(for: UITestFakeServer.machineId) }
    // The second caller runs to its own wait (the read, or the first call's creation).
    try await Task.sleep(nanoseconds: 300_000_000)
    await secure.release()
    let a = await first.value
    let b = await second.value
    let connection = try XCTUnwrap(a, "the first call made no connection")
    XCTAssertTrue(a === b, "both callers get the same connection")
    XCTAssertTrue(app.connections[UITestFakeServer.machineId] === connection, "the one the app keeps")
    let one = await app.conversation(for: UITestFakeServer.machineId, sessionId: UITestFakeServer.sessionId, in: connection)
    let other = await app.conversation(for: UITestFakeServer.machineId, sessionId: "s_working", in: try XCTUnwrap(b))
    XCTAssertTrue(one?.delivery === connection.delivery, "a conversation over it sends through its controller")
    XCTAssertTrue(other?.delivery === connection.delivery, "and so does one made over the second caller's")
  }

  /// The machine listed with the pairing's record: the credential read is the one wait.
  func testTwoConnectionCallsWhileTheCredentialReadIsHeldGetOneConnection() async throws {
    try await twoConnectionCallsWhileTheCredentialReadIsHeld(keepRecord: true)
  }

  /// The machine's pairing record not kept: the app also reads the enrollment record before it
  /// builds the connection, a second wait between the read and the build.
  func testTwoConnectionCallsWhileTheCredentialReadIsHeldGetOneConnectionWhenTheRecordIsReadToo() async throws {
    try await twoConnectionCallsWhileTheCredentialReadIsHeld(keepRecord: false)
  }

  /// Two conversation calls for one session started together while the session read is held (the
  /// machine's session list refused, so the session is read by id): both wait at once, then get the
  /// same model, over the connection's controller.
  func testTwoConversationCallsWhileTheSessionReadIsHeldGetOneModel() async throws {
    let server = UITestFakeServer()
    let transport = HeldSessionReadTransport(UITestFakeTransport(server: server))
    transport.refuseTheSessionList()
    let app = try await signedInApp(server: server, transport: transport)
    let made = await app.connection(for: UITestFakeServer.machineId)
    let connection = try XCTUnwrap(made, "the app made no connection")
    XCTAssertEqual(connection.sessions, [], "the list was refused, so a conversation reads its session")
    transport.holdSessionReads()
    let first = Task { await app.conversation(for: UITestFakeServer.machineId, sessionId: UITestFakeServer.sessionId, in: connection) }
    let second = Task { await app.conversation(for: UITestFakeServer.machineId, sessionId: UITestFakeServer.sessionId, in: connection) }
    await eventually("both calls wait at the session read") { transport.waiting == 2 }
    transport.release()
    let a = await first.value
    let b = await second.value
    XCTAssertNotNil(a, "the first call made no conversation")
    XCTAssertTrue(a === b, "both callers get the same model")
    XCTAssertTrue(a?.delivery === connection.delivery)
  }
}

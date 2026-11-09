import ClaveCore
import XCTest
@testable import Clave

/// Counts the requests that reach the fake, by path.
nonisolated final class CountingTransport: HTTPTransport, @unchecked Sendable {
  private let inner: any HTTPTransport
  private let lock = NSLock()
  private var paths: [String] = []

  init(_ inner: any HTTPTransport) {
    self.inner = inner
  }

  func perform(_ request: URLRequest) async throws -> HTTPAnswer {
    record(request.url?.path ?? "")
    return try await inner.perform(request)
  }

  private func record(_ path: String) {
    lock.lock()
    paths.append(path)
    lock.unlock()
  }

  func count(_ path: String) -> Int {
    lock.lock()
    defer { lock.unlock() }
    return paths.filter { $0 == path }.count
  }

  var total: Int {
    lock.lock()
    defer { lock.unlock() }
    return paths.count
  }
}

@MainActor
final class ShellTests: XCTestCase {
  private func environment(
    build: BuildKind = .development, transport: (any HTTPTransport)? = nil,
    secure: any SecureStore = InMemorySecureStore(), kv: any KeyValueStore = InMemoryKeyValueStore()
  ) -> AppEnvironment {
    let server = UITestFakeServer()
    let defaults = UserDefaults(suiteName: "clave.shell-tests")!
    defaults.removePersistentDomain(forName: "clave.shell-tests")
    return AppEnvironment(
      buildKind: build, issuer: UITestFakeServer.hubOrigin, relayOverride: nil,
      transport: transport ?? UITestFakeTransport(server: server),
      webSocketTransport: UITestFakeWebSocketTransport(server: server), secureStore: secure, keyValueStore: kv,
      opener: UITestFakeOpener(), usesRemoteNotifications: false, appearanceDefaults: defaults)
  }

  // MARK: the environment

  func testAReleaseLikeBuildIgnoresTheFakeAndTheOverrides() {
    let environment = ["CLAVE_IOS_ISSUER": "http://127.0.0.1:9000", "CLAVE_IOS_RELAY": "http://127.0.0.1:9001"]
    let arguments = ["Clave", "--ui-test-fake"]
    XCTAssertEqual(LaunchOptions.resolve(isDebug: false, environment: environment, arguments: arguments), .release)
    let debug = LaunchOptions.resolve(isDebug: true, environment: environment, arguments: arguments)
    XCTAssertEqual(debug.buildKind, .development)
    XCTAssertTrue(debug.usesUITestFake)
    XCTAssertEqual(debug.issuerOverride, "http://127.0.0.1:9000")
    XCTAssertEqual(debug.relayOverride, "http://127.0.0.1:9001")
    XCTAssertFalse(LaunchOptions.resolve(isDebug: true, environment: [:], arguments: ["Clave"]).usesUITestFake)
  }

  // MARK: the cold launch

  func testTheColdLaunchRule() {
    XCTAssertEqual(AppModel.coldLaunchPath(currentMachine: nil), [])
    XCTAssertEqual(AppModel.coldLaunchPath(currentMachine: "m1"), [.workspaces(machineId: "m1")])
    XCTAssertEqual(MachinesModel.currentMachine(last: nil, main: nil, paired: ["m1"]), "m1")
    XCTAssertEqual(MachinesModel.currentMachine(last: "gone", main: "m2", paired: ["m1", "m2"]), "m2")
    XCTAssertEqual(MachinesModel.currentMachine(last: "m1", main: "m2", paired: ["m1", "m2"]), "m1")
    XCTAssertNil(MachinesModel.currentMachine(last: "m1", main: nil, paired: []))
    XCTAssertEqual(
      AppModel.path(for: .chat(machineId: "m1", sessionId: "s1")),
      [.workspaces(machineId: "m1"), .chat(machineId: "m1", sessionId: "s1")])
  }

  /// A new process over the stores of a phone signed in with one paired
  /// machine opens that machine's workspaces; the same with none opens Machines.
  func testANewProcessOpensTheWorkspacesOfThePairedMachine() async throws {
    let secure = InMemorySecureStore()
    let kv = InMemoryKeyValueStore()
    let first = AppModel(environment: environment(secure: secure, kv: kv))
    await first.start()
    XCTAssertEqual(first.path, [])
    await first.account.signIn()
    let machines = try XCTUnwrap(first.machines)
    let next = AppModel(environment: environment(secure: secure, kv: kv))
    await next.start()
    XCTAssertTrue(next.account.isSignedIn)
    XCTAssertEqual(next.path, [], "signed in with no machine paired: Machines alone")

    let base = machineBaseURL(relay: UITestFakeServer.relayOrigin, machineId: UITestFakeServer.machineId)
    try await machines.credentials.set(UITestFakeServer.machineId, Credential(serverUrl: base, bearer: UITestFakeServer.deviceToken))
    try await machines.records.set(
      EnrollmentRecord(machineId: UITestFakeServer.machineId, deviceId: "d", serverId: "srv", serverName: "Fake Mac", pairedAt: 1))
    let third = AppModel(environment: environment(secure: secure, kv: kv))
    await third.start()
    XCTAssertEqual(third.path, [.workspaces(machineId: UITestFakeServer.machineId)])
  }

  func testADeepLinkOpensTheConversation() async {
    let model = AppModel(environment: environment())
    await model.start()
    model.handle(url: DeepLink.chat(machineId: "m1", sessionId: "s 1").url)
    XCTAssertEqual(model.path, [.workspaces(machineId: "m1"), .chat(machineId: "m1", sessionId: "s 1")])
    model.handle(url: URL(string: "https://example.com/chat/m1/s1")!)
    XCTAssertEqual(model.path.count, 2, "a URL that is not the app's changes nothing")
  }

  // MARK: the relay

  func testAReleaseBuildRefusesAPlainHTTPRelay() async {
    let counting = CountingTransport(UITestFakeTransport(server: UITestFakeServer()))
    let env = environment(build: .release, transport: counting)
    let model = MachinesModel(
      namespace: "ns", environment: env, secureStore: OwnerScopedSecureStore(base: InMemorySecureStore(), namespace: "ns"),
      keyValueStore: OwnerScopedKeyValueStore(base: InMemoryKeyValueStore(), namespace: "ns"),
      accessToken: { "token" }, idToken: { "id" }, clientId: { "client" })
    let saved = await model.saveRelay("http://relay.example.com")
    XCTAssertFalse(saved)
    guard case .refused(let reason) = credentialMayTravelTo("http://relay.example.com", build: .release) else {
      return XCTFail("the policy allowed plain http in a release build")
    }
    XCTAssertEqual(model.relayRefusal, reason)
    XCTAssertTrue(reason.contains("plain http"))
    XCTAssertEqual(model.relayURL, "")
    XCTAssertEqual(counting.total, 0, "nothing is sent to a refused relay")
  }

  // MARK: the connection

  func testAForbiddenAnswerIsShownInTheServersWordsAndNotRetried() async throws {
    let counting = CountingTransport(UITestFakeTransport(server: UITestFakeServer()))
    let env = environment(transport: counting)
    let base = machineBaseURL(relay: UITestFakeServer.relayOrigin, machineId: UITestFakeServer.machineId)
    let kv = InMemoryKeyValueStore()
    let credentials = SecureCredentialStore(InMemorySecureStore())
    let connection = try MachineConnection(
      machineId: UITestFakeServer.machineId, credential: Credential(serverUrl: base, bearer: UITestFakeServer.deviceToken),
      machine: nil, record: nil, environment: env, credentials: credentials, records: EnrollmentRecords(store: kv),
      ownerKeyValueStore: OwnerScopedKeyValueStore(base: kv, namespace: "ns"))
    do {
      _ = try await connection.resolve(requestId: "r_not_mine", response: .dismiss)
      XCTFail("the fake answered a request outside the device's scope")
    } catch let error as ServerError {
      XCTAssertEqual(error.kind, .forbidden)
      XCTAssertEqual(error.message, UITestFakeServer.forbiddenSentence)
    }
    XCTAssertEqual(connection.lastError, UITestFakeServer.forbiddenSentence)
    XCTAssertEqual(counting.count("/m/m_fake/requests/resolve"), 1)
    XCTAssertEqual(counting.total, 1, "a refusal is never retried, nor followed by a reload")
    XCTAssertFalse(connection.isUnpaired)
    connection.stop()
  }
}

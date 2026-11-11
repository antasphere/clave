import ClaveCore
import XCTest
@testable import Clave

/// Answers the developer source's one try of a token, `GET /launch-profiles`, as a server would.
struct LaunchProfilesAnswer: HTTPTransport {
  func perform(_ request: URLRequest) async throws -> HTTPAnswer {
    HTTPAnswer(
      status: 200, headers: ["Content-Type": "application/json"],
      body: Data(#"{"version":1,"customProfiles":[],"globalDefaults":{},"workspaceOverrides":{}}"#.utf8))
  }
}

/// A release build never opens a developer machine at launch: the records a development build kept
/// are left out of the choice, never deleted. A debug build opens them.
@MainActor
final class DeveloperReleaseTests: XCTestCase {
  private let developerURL = "http://127.0.0.1:43201"

  /// The environment as ShellTests builds it, the build kind given.
  private func environment(build: BuildKind) -> AppEnvironment {
    let server = UITestFakeServer()
    let defaults = UserDefaults(suiteName: "clave.developer-release-tests")!
    defaults.removePersistentDomain(forName: "clave.developer-release-tests")
    return AppEnvironment(
      buildKind: build, issuer: UITestFakeServer.hubOrigin, relayOverride: nil,
      transport: UITestFakeTransport(server: server),
      webSocketTransport: UITestFakeWebSocketTransport(server: server), secureStore: InMemorySecureStore(),
      keyValueStore: InMemoryKeyValueStore(), opener: UITestFakeOpener(), usesRemoteNotifications: false,
      appearanceDefaults: defaults)
  }

  private func machines(_ build: BuildKind, secure: InMemorySecureStore, kv: InMemoryKeyValueStore) -> MachinesModel {
    MachinesModel(
      namespace: "ns", environment: environment(build: build),
      secureStore: OwnerScopedSecureStore(base: secure, namespace: "ns"),
      keyValueStore: OwnerScopedKeyValueStore(base: kv, namespace: "ns"),
      accessToken: { "token" }, idToken: { "id" }, clientId: { "client" })
  }

  /// One owner's stores as a development build left them: a developer machine added through the
  /// developer flow, its record and its token kept, and opened last.
  private func storesWithADeveloperMachine() async throws -> (secure: InMemorySecureStore, kv: InMemoryKeyValueStore, id: String) {
    let secure = InMemorySecureStore()
    let kv = InMemoryKeyValueStore()
    let debug = machines(.development, secure: secure, kv: kv)
    let machine = try await DeveloperMachineSource(store: debug.keyValueStore, credentials: debug.credentials, build: .development)
      .add(serverURL: developerURL, token: "server-token", transport: LaunchProfilesAnswer())
    await debug.rememberOpened(machine.id)
    return (secure, kv, machine.id)
  }

  func testAReleaseBuildOpensNoDeveloperMachineAndKeepsItsRecords() async throws {
    let (secure, kv, developer) = try await storesWithADeveloperMachine()
    let release = machines(.release, secure: secure, kv: kv)
    let current = await release.currentMachineId()
    XCTAssertNil(current)
    let records = try await DeveloperMachineSource(store: release.keyValueStore, credentials: release.credentials, build: .release).records()
    XCTAssertEqual(records.map(\.id), [developer], "the record is left where it was")
    let token = try await release.credentials.get(developer)
    XCTAssertEqual(token, Credential(serverUrl: developerURL, bearer: "server-token"), "the token too")
  }

  func testAReleaseBuildOpensTheRelayMachineBesideADeveloperOne() async throws {
    let (secure, kv, developer) = try await storesWithADeveloperMachine()
    let release = machines(.release, secure: secure, kv: kv)
    try await release.credentials.set("m_relay", Credential(serverUrl: "https://relay.example/m/m_relay", bearer: "device-token"))
    let current = await release.currentMachineId()
    XCTAssertEqual(current, "m_relay")
    let known = try await release.credentials.known()
    XCTAssertTrue(known.contains(developer), "the developer machine's token is kept")
  }

  func testADebugBuildOpensTheDeveloperMachine() async throws {
    let (secure, kv, developer) = try await storesWithADeveloperMachine()
    let debug = machines(.development, secure: secure, kv: kv)
    let current = await debug.currentMachineId()
    XCTAssertEqual(current, developer)
  }
}

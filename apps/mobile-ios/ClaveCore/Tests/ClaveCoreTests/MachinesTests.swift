import XCTest
@testable import ClaveCore

/// The machines: machines.test.ts, and the credential store per owner.
final class MachinesTests: XCTestCase {
  private let relay = "https://relay.example"
  private let hubToken = "hub-access-token"

  private func relayTransport() async -> ScriptedTransport {
    let transport = ScriptedTransport()
    let hubToken = self.hubToken
    await transport.on("GET", "/machines") { request in
      guard request.value(forHTTPHeaderField: "Authorization") == "Bearer \(hubToken)" else {
        return HTTPAnswer(status: 401, body: Data(#"{"error":"Unauthenticated"}"#.utf8))
      }
      return HTTPAnswer(status: 200, body: Data(#"""
        {"machines":[
          {"id":"mac-1","name":"Valentin's Mac","platform":"macos","version":"2.4.0","online":true,"lastSeen":"2026-10-29T15:00:00Z","direct":[{"url":"http://100.64.0.2:43127"}]},
          {"id":"vps 1","name":"VPS","platform":"linux","version":"2.3.0","online":false,"lastSeen":null,"direct":[]},
          {"id":"odd","platform":"windows","online":"yes"}
        ]}
        """#.utf8))
    }
    return transport
  }

  func testListsTheMachinesOfTheTokensSubjectWithTheRelayRoadAsBase() async throws {
    let transport = await relayTransport()
    let counter = Counter()
    let source = try RelayMachineSource(relayURL: relay + "/", token: countingBearer(hubToken, counter), transport: transport)
    let machines = try await source.list()
    XCTAssertEqual(machines.count, 3)
    XCTAssertEqual(
      machines[0],
      Machine(
        id: "mac-1", name: "Valentin's Mac", platform: .macos, version: "2.4.0", online: true,
        lastSeen: ISO8601DateFormatter().date(from: "2026-10-29T15:00:00Z")!.timeIntervalSince1970 * 1000,
        baseUrl: "\(relay)/m/mac-1", pushUrl: "\(relay)/m/mac-1/push"))
    XCTAssertEqual(machines[1].baseUrl, "\(relay)/m/vps%201")
    XCTAssertNil(machines[1].lastSeen)
    XCTAssertFalse(machines[1].online)
    XCTAssertEqual(machines[2].name, "odd")
    XCTAssertEqual(machines[2].platform, .unknown)
    XCTAssertEqual(machines[2].version, "")
    XCTAssertFalse(machines[2].online)
    let requests = await transport.requests
    XCTAssertEqual(requests.map { $0.url?.absoluteString }, ["\(relay)/machines"])
    XCTAssertEqual(requests.first?.timeoutInterval, 10)
    XCTAssertEqual(counter.count, 1)
  }

  func testABadHubTokenIsUnauthenticated() async throws {
    let source = try RelayMachineSource(relayURL: relay, token: { "stale" }, transport: await relayTransport())
    do {
      _ = try await source.list()
      XCTFail("listed with a stale token")
    } catch let error as ServerError {
      XCTAssertEqual(error.kind, .unauthenticated)
      XCTAssertEqual(error.message, "The relay refused the sign-in.")
    }
  }

  func testAnyOtherRefusalOrAnUnreadableListIsProtocol() async throws {
    let transport = ScriptedTransport()
    await transport.onJSON("GET", "/machines", status: 503, #"{"error":"down"}"#)
    let source = try RelayMachineSource(relayURL: relay, token: { "t" }, transport: transport)
    do {
      _ = try await source.list()
      XCTFail("listed from a 503")
    } catch let error as ServerError {
      XCTAssertEqual(error.kind, .protocol)
    }
    await transport.onJSON("GET", "/machines", #"{"nope":true}"#)
    do {
      _ = try await source.list()
      XCTFail("listed from no list")
    } catch let error as ServerError {
      XCTAssertEqual(error.kind, .protocol)
    }
  }

  func testTheRoadURLs() {
    XCTAssertEqual(machineBaseURL(relay: "https://relay.example/", machineId: "abc"), "https://relay.example/m/abc")
    XCTAssertEqual(machinePushURL(relay: "https://relay.example", machineId: "abc"), "https://relay.example/m/abc/push")
  }

  func testAReleaseRelaySourceAndEnrollmentClientRefuseAPlainHttpAddress() {
    let transport = ScriptedTransport()
    XCTAssertThrowsError(try RelayMachineSource(relayURL: "http://relay.local", token: { "t" }, transport: transport))
    XCTAssertThrowsError(try EnrollmentClient(baseURL: "http://192.168.1.20:43201", transport: transport))
    XCTAssertNoThrow(try EnrollmentClient(baseURL: "http://127.0.0.1:43201", transport: transport, build: .development))
  }

  /// The policy's word on plain http to the loopback in a release build.
  private func releaseRefusal(_ url: String) -> String? {
    guard case .refused(let reason) = credentialMayTravelTo(url, build: .release) else { return nil }
    return reason
  }

  // MARK: the credential store

  func testKeepsOneCredentialPerMachineTheFirstPairedAsMain() async throws {
    let secure = InMemorySecureStore()
    let store = SecureCredentialStore(secure)
    let none = try await store.get("m1")
    XCTAssertNil(none)
    try await store.set("m1", Credential(serverUrl: "https://a", bearer: "x"))
    try await store.set("m 2", Credential(serverUrl: "https://b", bearer: "y"))
    let first = try await store.get("m1")
    let second = try await store.get("m 2")
    let main = try await store.mainMachineId()
    let known = try await store.known()
    XCTAssertEqual(first, Credential(serverUrl: "https://a", bearer: "x"))
    XCTAssertEqual(second, Credential(serverUrl: "https://b", bearer: "y"))
    XCTAssertEqual(main, "m1")
    XCTAssertEqual(known, ["m1", "m 2"])
    let keys = await secure.values.keys.sorted()
    XCTAssertEqual(keys, ["machine.m 2", "machine.m1", "machines.index", "machines.main"])
    try await store.remove("m1")
    let gone = try await store.get("m1")
    let noMain = try await store.mainMachineId()
    let after = try await store.known()
    XCTAssertNil(gone)
    XCTAssertNil(noMain)
    XCTAssertEqual(after, ["m 2"])
    try await store.setMainMachineId("m 2")
    let marked = try await store.mainMachineId()
    XCTAssertEqual(marked, "m 2")
  }

  func testAnUnreadableEntryIsNoCredentialAndTheDescriptionHidesTheBearer() async throws {
    let secure = InMemorySecureStore(["machine.m1": "not json"])
    let store = SecureCredentialStore(secure)
    let damaged = try await store.get("m1")
    XCTAssertNil(damaged)
    let credential = Credential(serverUrl: "https://a", bearer: "s3cret-bearer")
    XCTAssertFalse("\(credential)".contains("s3cret"))
    XCTAssertFalse(String(reflecting: credential).contains("s3cret"))
  }

  /// (c) The credential store per owner: two namespaces over one secure store never see each other.
  func testTheCredentialStoreIsScopedPerOwner() async throws {
    let base = InMemorySecureStore()
    let ownerA = SecureCredentialStore(OwnerScopedSecureStore(base: base, namespace: ownerNamespace(issuer: "https://hub.test", subject: "a")))
    let ownerB = SecureCredentialStore(OwnerScopedSecureStore(base: base, namespace: ownerNamespace(issuer: "https://hub.test", subject: "b")))
    try await ownerA.set("mac-1", Credential(serverUrl: "https://relay.example/m/mac-1", bearer: "device-a"))
    let seenByB = try await ownerB.get("mac-1")
    let mainOfB = try await ownerB.mainMachineId()
    let knownByB = try await ownerB.known()
    XCTAssertNil(seenByB)
    XCTAssertNil(mainOfB)
    XCTAssertEqual(knownByB, [])
    try await ownerB.set("mac-1", Credential(serverUrl: "https://relay.example/m/mac-1", bearer: "device-b"))
    try await ownerB.remove("mac-1")
    let keptForA = try await ownerA.get("mac-1")
    let mainOfA = try await ownerA.mainMachineId()
    XCTAssertEqual(keptForA?.bearer, "device-a")
    XCTAssertEqual(mainOfA, "mac-1")
    let keys = await base.values.keys
    XCTAssertTrue(keys.allSatisfy { $0.hasPrefix("clave.owner.") })
  }

  // MARK: the developer connection

  func testNormalizesTheAddressAndNamesTheMachine() throws {
    XCTAssertEqual(try normalizeServerURL(" 127.0.0.1:43201/ "), "http://127.0.0.1:43201")
    XCTAssertEqual(try normalizeServerURL("https://relay.example/m/x/"), "https://relay.example/m/x")
    XCTAssertThrowsError(try normalizeServerURL("ftp://x"))
    XCTAssertEqual(developerMachineId("http://127.0.0.1:43201"), "dev:127.0.0.1:43201")
    XCTAssertEqual(developerMachineId("http://localhost"), "dev:localhost")
  }

  func testTriesTheTokenOnceKeepsItAndListsTheMachine() async throws {
    let server = "http://127.0.0.1:43201"
    let transport = ScriptedTransport()
    await transport.on("GET", "/launch-profiles") { request in
      guard request.value(forHTTPHeaderField: "Authorization") == "Bearer server-token" else { return HTTPAnswer(status: 401) }
      return HTTPAnswer(status: 200, body: Data(#"{"version":1,"customProfiles":[],"globalDefaults":{},"workspaceOverrides":{}}"#.utf8))
    }
    let kv = InMemoryKeyValueStore()
    let credentials = SecureCredentialStore(InMemorySecureStore())
    let source = DeveloperMachineSource(store: kv, credentials: credentials, build: .development, now: { 5 })
    do {
      _ = try await source.add(serverURL: server, token: "wrong", name: "Dev", transport: transport)
      XCTFail("kept a refused token")
    } catch let error as ServerError {
      XCTAssertEqual(error.kind, .unauthenticated)
    }
    let empty = try await source.list()
    XCTAssertEqual(empty, [])
    let machine = try await source.add(serverURL: server + "/", token: "server-token", name: "Dev", transport: transport)
    XCTAssertEqual(
      machine,
      Machine(id: "dev:127.0.0.1:43201", name: "Dev", platform: .unknown, version: "", online: true, lastSeen: nil,
        baseUrl: server, pushUrl: "ws://127.0.0.1:43201/push"))
    let kept = try await credentials.get(machine.id)
    XCTAssertEqual(kept, Credential(serverUrl: server, bearer: "server-token"))
    let listed = try await source.list()
    XCTAssertEqual(listed, [machine])
    try await source.remove(machine.id)
    let after = try await source.list()
    let forgotten = try await credentials.get(machine.id)
    XCTAssertEqual(after, [])
    XCTAssertNil(forgotten)
  }

  func testTheDeveloperConnectionStillRefusesPlainHttpOffTheLoopback() async throws {
    let source = DeveloperMachineSource(store: InMemoryKeyValueStore(), credentials: SecureCredentialStore(InMemorySecureStore()), build: .development)
    let transport = ScriptedTransport()
    do {
      _ = try await source.add(serverURL: "192.168.1.20:43201", token: "t", transport: transport)
      XCTFail("a LAN address over plain http")
    } catch {
      XCTAssertTrue(error is TransportPolicyError)
    }
    let count = await transport.requests.count
    XCTAssertEqual(count, 0)
  }

  /// The source follows the build it is given: a release one refuses the loopback over plain http
  /// with the policy's error, sends nothing and keeps nothing; a development one adds it.
  func testTheDeveloperSourceSendsTheTokenWhereItsBuildAllows() async throws {
    let server = "http://127.0.0.1:43201"
    let transport = ScriptedTransport()
    await transport.on("GET", "/launch-profiles") { _ in
      HTTPAnswer(status: 200, body: Data(#"{"version":1,"customProfiles":[],"globalDefaults":{},"workspaceOverrides":{}}"#.utf8))
    }
    let kv = InMemoryKeyValueStore()
    let credentials = SecureCredentialStore(InMemorySecureStore())
    let release = DeveloperMachineSource(store: kv, credentials: credentials, build: .release)
    do {
      _ = try await release.add(serverURL: server, token: "server-token", transport: transport)
      XCTFail("a release build added a plain-http server")
    } catch let error as TransportPolicyError {
      XCTAssertEqual(error.message, releaseRefusal(server))
    }
    let sent = await transport.requests.count
    XCTAssertEqual(sent, 0, "the token went nowhere")
    let records = try await release.records()
    XCTAssertEqual(records, [])
    let tokens = try await credentials.known()
    XCTAssertEqual(tokens, [], "no token kept")
    let list = try await kv.get(DeveloperMachineSource.listKey)
    XCTAssertNil(list)

    let development = DeveloperMachineSource(store: kv, credentials: credentials, build: .development)
    let machine = try await development.add(serverURL: server, token: "server-token", transport: transport)
    XCTAssertEqual(machine.id, "dev:127.0.0.1:43201")
    let kept = try await credentials.get(machine.id)
    XCTAssertEqual(kept, Credential(serverUrl: server, bearer: "server-token"))
  }
}

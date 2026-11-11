import XCTest
@testable import ClaveCore

/// The routes a token registration calls, recorded.
actor FakeTokenRoutes: PushTokenRoutes {
  let bearer: String
  var failSet = false
  var failClear = false
  private(set) var sets: [String] = []
  private(set) var clears = 0

  init(bearer: String) {
    self.bearer = bearer
  }

  func configure(_ change: @Sendable (isolated FakeTokenRoutes) -> Void) { change(self) }

  func setPushToken(_ token: String, platform: DevicePlatform) async throws {
    if failSet { throw ServerError(.network, "The server could not be reached.") }
    sets.append("\(token)/\(platform.rawValue)")
  }

  func clearPushToken() async throws {
    if failClear { throw ServerError(.network, "The server could not be reached.") }
    clears += 1
  }
}

/// Collects navigations.
final class Navigations: @unchecked Sendable {
  private let lock = NSLock()
  private var _seen: [NotificationDestination] = []
  func add(_ destination: NotificationDestination) { lock.withLock { _seen.append(destination) } }
  var seen: [NotificationDestination] { lock.withLock { _seen } }
}

/// The pending navigation, the device token and the sign-out's clearing:
/// inbox.test.ts, the device-token cases of notifications.test.ts, cleanup.ts.
final class NotificationsInboxTests: XCTestCase {
  let link = NotificationDestination.chat(machineId: "machine", sessionId: "session", title: "")

  func testOpensTheNotificationConversationOnColdLaunchAndConsumesItOnce() async throws {
    let kv = InMemoryKeyValueStore()
    let inbox = NotificationInbox(store: kv)
    let handled = Counter()
    await inbox.receive(key: "one|1|tap") { [link] in _ = handled.next(); return link }
    let stored = try await kv.get(NotificationInbox.pendingKey)
    XCTAssertNotNil(stored)
    let launch = await inbox.launchDestination()
    XCTAssertEqual(launch, link)
    let raw = try await kv.get(NotificationInbox.pendingKey)
    XCTAssertNil(raw)
    let again = await inbox.launchDestination()
    XCTAssertNil(again)
    XCTAssertEqual(handled.count, 1)
  }

  func testAHeadlessResponseIsReadOnTheNextColdLaunch() async throws {
    let kv = InMemoryKeyValueStore()
    let background = NotificationInbox(store: kv)
    await background.receive(key: "bg") { .requests(machineId: "m", requestId: "r") }
    let launch = await NotificationInbox(store: kv).launchDestination()
    XCTAssertEqual(launch, .requests(machineId: "m", requestId: "r"))
  }

  func testAnExplicitDeepLinkWinsOverAStoredNotification() async throws {
    let kv = InMemoryKeyValueStore()
    try await kv.set(NotificationInbox.pendingKey, try ContractJSON.encodeToString(link))
    let inbox = NotificationInbox(store: kv)
    let launch = await inbox.launchDestination(explicitURL: DeepLink.chat(machineId: "url-machine", sessionId: "url-session").url)
    XCTAssertNil(launch)
    let raw = try await kv.get(NotificationInbox.pendingKey)
    XCTAssertNil(raw)
  }

  func testQueuesAWarmResponseUntilNavigationIsReadyAndHandlesADuplicateOnce() async {
    let kv = InMemoryKeyValueStore()
    let inbox = NotificationInbox(store: kv)
    let handled = Counter()
    let navigations = Navigations()
    let link = self.link
    async let first: Void = inbox.receive(key: "one|1|tap") { _ = handled.next(); return link }
    async let second: Void = inbox.receive(key: "one|1|tap") { _ = handled.next(); return link }
    _ = await (first, second)
    XCTAssertEqual(navigations.seen, [])
    await inbox.ready { navigations.add($0) }
    await inbox.idle()
    XCTAssertEqual(navigations.seen, [link])
    XCTAssertEqual(handled.count, 1)
    let raw = try? await kv.get(NotificationInbox.pendingKey)
    XCTAssertNil(raw ?? nil)
    await inbox.receive(key: "two|2|tap") { .workspaces(machineId: "m") }
    XCTAssertEqual(navigations.seen, [link, .workspaces(machineId: "m")])
  }

  func testDoesNotNavigateAfterItsOwnerUnmounts() async {
    let inbox = NotificationInbox(store: InMemoryKeyValueStore())
    let navigations = Navigations()
    await inbox.ready { navigations.add($0) }
    await inbox.close()
    await inbox.receive(key: "one") { [link] in link }
    XCTAssertEqual(navigations.seen, [])
  }

  func testIgnoresMalformedPendingDataAndNeverReadsAnotherOwnersStore() async throws {
    let base = InMemoryKeyValueStore()
    let ownerA = OwnerScopedKeyValueStore(base: base, namespace: ownerNamespace(issuer: "https://hub.test", subject: "a"))
    let ownerB = OwnerScopedKeyValueStore(base: base, namespace: ownerNamespace(issuer: "https://hub.test", subject: "b"))
    try await ownerA.set(NotificationInbox.pendingKey, #"{"chat":{"machineId":1}}"#)
    let damaged = await NotificationInbox(store: ownerA).launchDestination()
    XCTAssertNil(damaged)
    try await ownerA.set(NotificationInbox.pendingKey, try ContractJSON.encodeToString(link))
    let other = await NotificationInbox(store: ownerB).launchDestination()
    XCTAssertNil(other)
    let own = await NotificationInbox(store: ownerA).launchDestination()
    XCTAssertEqual(own, link)
  }

  // MARK: the device token

  func testRegistersTheTokenOnceAndAgainOnlyWhenItChanges() async throws {
    let kv = InMemoryKeyValueStore()
    let registry = PushTokenRegistry(store: kv)
    let routes = FakeTokenRoutes(bearer: "ds-1")
    let first = await registry.register("apns-1", machineId: "m-1", routes: routes)
    XCTAssertEqual(first, .registered(token: "apns-1"))
    let kept = try await kv.get(PushTokenRegistry.tokenKey("m-1"))
    XCTAssertEqual(kept, "apns-1")
    let same = await registry.register("apns-1", machineId: "m-1", routes: routes)
    XCTAssertEqual(same, .unchanged)
    let changed = await registry.register("apns-2", machineId: "m-1", routes: routes)
    XCTAssertEqual(changed, .registered(token: "apns-2"))
    let sets = await routes.sets
    XCTAssertEqual(sets, ["apns-1/ios", "apns-2/ios"])
    XCTAssertEqual(apnsTokenString(Data([0x0a, 0xff, 0x00])), "0aff00")
  }

  func testAMachineThatCannotBeToldIsAFailureNothingRememberedAndARetryRecorded() async throws {
    let kv = InMemoryKeyValueStore()
    let registry = PushTokenRegistry(store: kv)
    let routes = FakeTokenRoutes(bearer: "ds-1")
    await routes.configure { $0.failSet = true }
    let outcome = await registry.register("apns-1", machineId: "m-1", routes: routes)
    XCTAssertEqual(outcome, .failed(reason: "The server could not be reached."))
    let kept = try await kv.get(PushTokenRegistry.tokenKey("m-1"))
    XCTAssertNil(kept)
    let retries = await registry.retries()
    XCTAssertEqual(retries, ["m-1"])
    await routes.configure { $0.failSet = false }
    _ = await registry.register("apns-1", machineId: "m-1", routes: routes)
    let after = await registry.retries()
    XCTAssertEqual(after, [])
  }

  func testRegistersWithEveryPairedMachineThroughItsOwnCredential() async throws {
    let credentials = SecureCredentialStore(InMemorySecureStore())
    try await credentials.set("m-1", Credential(serverUrl: "https://relay.example/m/m-1", bearer: "ds-1"))
    try await credentials.set("m-2", Credential(serverUrl: "https://relay.example/m/m-2", bearer: "ds-2"))
    let one = FakeTokenRoutes(bearer: "ds-1")
    let two = FakeTokenRoutes(bearer: "ds-2")
    await two.configure { $0.failSet = true }
    let registry = PushTokenRegistry(store: InMemoryKeyValueStore())
    let outcomes = await registry.registerEverywhere(
      "apns-1", machineIds: ["m-1", "m-2", "m-3"], credentials: credentials,
      routes: { $0.bearer == "ds-1" ? one : two })
    XCTAssertEqual(outcomes["m-1"], .registered(token: "apns-1"))
    guard case .failed? = outcomes["m-2"], case .failed? = outcomes["m-3"] else { return XCTFail("\(outcomes)") }
    let retries = await registry.retries()
    XCTAssertEqual(retries, ["m-2"])
  }

  func testClearingForgetsTheTokenOnTheMachineAndHere() async throws {
    let kv = InMemoryKeyValueStore()
    let registry = PushTokenRegistry(store: kv)
    let routes = FakeTokenRoutes(bearer: "ds-1")
    _ = await registry.register("apns-1", machineId: "m-1", routes: routes)
    try await registry.clear(machineId: "m-1", routes: routes)
    let clears = await routes.clears
    XCTAssertEqual(clears, 1)
    let kept = try await kv.get(PushTokenRegistry.tokenKey("m-1"))
    XCTAssertNil(kept)
  }

  func testSignOutClearsWithTheCapturedCredentialAndKeepsTheUnreachableOwed() async throws {
    let kv = InMemoryKeyValueStore()
    let secure = InMemorySecureStore()
    let credentials = SecureCredentialStore(OwnerScopedSecureStore(base: secure, namespace: "owner"))
    let cleanup = SecureCredentialStore(OwnerScopedSecureStore(base: secure, namespace: "owner.cleanup"))
    try await credentials.set("m-1", Credential(serverUrl: "https://relay.example/m/m-1", bearer: "ds-1"))
    try await credentials.set("m-2", Credential(serverUrl: "https://relay.example/m/m-2", bearer: "ds-2"))
    let registry = PushTokenRegistry(store: kv)
    let one = FakeTokenRoutes(bearer: "ds-1")
    let two = FakeTokenRoutes(bearer: "ds-2")
    await two.configure { $0.failClear = true }
    _ = await registry.register("apns-1", machineId: "m-1", routes: one)
    let routes: @Sendable (Credential) throws -> any PushTokenRoutes = { $0.bearer == "ds-1" ? one : two }
    let result = try await registry.clearRegistrations(["m-1", "m-2"], credentials: credentials, cleanupCredentials: cleanup, routes: routes)
    XCTAssertEqual(result, PushCleanupResult(pending: 1))
    let clears = await one.clears
    XCTAssertEqual(clears, 1)
    let token = try await kv.get(PushTokenRegistry.tokenKey("m-1"))
    XCTAssertNil(token)
    // The pairing is forgotten after the capture: the owed clear still has its credential.
    try await credentials.remove("m-1")
    try await credentials.remove("m-2")
    let owedRaw = try await kv.get(PushTokenRegistry.cleanupKey)
    let owed = try JSONDecoder().decode([String].self, from: Data(try XCTUnwrap(owedRaw).utf8))
    XCTAssertEqual(owed.count, 1)
    XCTAssertTrue(owed[0].hasPrefix("push-cleanup-"))
    XCTAssertFalse(owedRaw?.contains("ds-2") ?? true)
    let kept = try await cleanup.get(owed[0])
    XCTAssertEqual(kept?.bearer, "ds-2")
    await two.configure { $0.failClear = false }
    let retried = try await registry.clearRegistrations([], credentials: credentials, cleanupCredentials: cleanup, routes: routes)
    XCTAssertEqual(retried, PushCleanupResult(pending: 0))
    let twoClears = await two.clears
    XCTAssertEqual(twoClears, 1)
    let gone = try await cleanup.get(owed[0])
    XCTAssertNil(gone)
    let none = try await kv.get(PushTokenRegistry.cleanupKey)
    XCTAssertNil(none)
  }

  func testACapturedCredentialIsNotCapturedTwice() async throws {
    let kv = InMemoryKeyValueStore()
    let credentials = SecureCredentialStore(InMemorySecureStore())
    let cleanup = SecureCredentialStore(InMemorySecureStore())
    try await credentials.set("m-1", Credential(serverUrl: "https://relay.example/m/m-1", bearer: "ds-1"))
    let routes = FakeTokenRoutes(bearer: "ds-1")
    await routes.configure { $0.failClear = true }
    let registry = PushTokenRegistry(store: kv)
    _ = try await registry.clearRegistrations(["m-1"], credentials: credentials, cleanupCredentials: cleanup, routes: { _ in routes })
    let second = try await registry.clearRegistrations(["m-1"], credentials: credentials, cleanupCredentials: cleanup, routes: { _ in routes })
    XCTAssertEqual(second, PushCleanupResult(pending: 1))
  }
}

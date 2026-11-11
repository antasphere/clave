import ClaveCore
import XCTest
@testable import Clave

/// Evidence I on the host: the routes every way into the app opens, and the development launch's
/// URL (`CLAVE_IOS_OPEN_URL`) read, handed to the launch and absent from a release-like build.
@MainActor
final class EvidenceTests: XCTestCase {
  private func environment(
    secure: any SecureStore = InMemorySecureStore(), kv: any KeyValueStore = InMemoryKeyValueStore()
  ) -> AppEnvironment {
    let server = UITestFakeServer()
    let defaults = UserDefaults(suiteName: "clave.evidence-tests")!
    defaults.removePersistentDomain(forName: "clave.evidence-tests")
    return AppEnvironment(
      buildKind: .development, issuer: UITestFakeServer.hubOrigin, relayOverride: nil,
      transport: UITestFakeTransport(server: server), webSocketTransport: UITestFakeWebSocketTransport(server: server),
      secureStore: secure, keyValueStore: kv, opener: UITestFakeOpener(),
      usesRemoteNotifications: false, appearanceDefaults: defaults)
  }

  // MARK: the routes

  func testEveryDeepLinkOpensItsStackOverTheMachinesWorkspaces() {
    XCTAssertEqual(
      AppModel.path(for: DeepLink.chat(machineId: "m1", sessionId: "s1")),
      [.workspaces(machineId: "m1"), .chat(machineId: "m1", sessionId: "s1")])
    XCTAssertEqual(
      AppModel.path(for: DeepLink.request(machineId: "m1", requestId: "r1")),
      [.workspaces(machineId: "m1"), .requests(machineId: "m1")])
    // The URL form parses back to the same place, an id with a slash kept whole.
    let link = DeepLink.chat(machineId: "m/1", sessionId: "s 1")
    XCTAssertEqual(DeepLink.parse(link.url), link)
  }

  func testEveryNotificationDestinationOpensItsStack() {
    XCTAssertEqual(
      AppModel.path(for: NotificationDestination.chat(machineId: "m1", sessionId: "s1", title: "Fix the build")),
      [.workspaces(machineId: "m1"), .chat(machineId: "m1", sessionId: "s1")])
    XCTAssertEqual(
      AppModel.path(for: NotificationDestination.requests(machineId: "m1", requestId: "r1")),
      [.workspaces(machineId: "m1"), .requests(machineId: "m1")])
    XCTAssertEqual(
      AppModel.path(for: NotificationDestination.requests(machineId: "m1", requestId: nil)),
      [.workspaces(machineId: "m1"), .requests(machineId: "m1")])
    XCTAssertEqual(AppModel.path(for: NotificationDestination.workspaces(machineId: "m1")), [.workspaces(machineId: "m1")])
    XCTAssertEqual(AppModel.path(for: NotificationDestination.machines(reason: "Pair this phone again.")), [])
  }

  func testAMachinesDestinationLeavesItsReasonOnMachines() async {
    let model = AppModel(environment: environment())
    await model.start()
    model.navigate(to: .chat(machineId: "m1", sessionId: "s1", title: "t"))
    model.navigate(to: .machines(reason: "Pair this phone again."))
    XCTAssertEqual(model.path, [])
    XCTAssertEqual(model.notice, "Pair this phone again.")
  }

  // MARK: the development launch's URL

  func testTheLaunchURLIsReadInADevelopmentBuildOnly() {
    let environment = ["CLAVE_IOS_OPEN_URL": " clave-ios://chat/m_fake/s_fake "]
    let debug = LaunchOptions.resolve(isDebug: true, environment: environment, arguments: ["Clave", "--ui-test-fake"])
    XCTAssertEqual(debug.openURL, URL(string: "clave-ios://chat/m_fake/s_fake"))
    XCTAssertEqual(LaunchOptions.resolve(isDebug: false, environment: environment, arguments: ["Clave"]), .release)
    XCTAssertNil(LaunchOptions.resolve(isDebug: true, environment: [:], arguments: ["Clave"]).openURL)
    XCTAssertEqual(AppEnvironment.live(debug).openURLAtLaunch, URL(string: "clave-ios://chat/m_fake/s_fake"))
  }

  /// A signed-in owner with the machine paired: the launch opens the URL's conversation at once.
  func testTheLaunchOpensTheURLItWasGiven() async throws {
    let secure = InMemorySecureStore()
    let kv = InMemoryKeyValueStore()
    try await signInWithTheFakeMachinePaired(environment(secure: secure, kv: kv))
    let model = AppModel(environment: environment(secure: secure, kv: kv).opening(DeepLink.chat(machineId: "m_fake", sessionId: "s_fake").url))
    await model.start()
    XCTAssertEqual(model.path, [.workspaces(machineId: "m_fake"), .chat(machineId: "m_fake", sessionId: "s_fake")])
    XCTAssertNil(model.pendingLink)
  }

  func testTheFakeAsksForNotificationsOnlyWhenTheLaunchSaysSo() {
    XCTAssertFalse(AppEnvironment.uiTestFake().usesRemoteNotifications)
    XCTAssertTrue(AppEnvironment.uiTestFake(asksForNotifications: true).usesRemoteNotifications)
    let options = LaunchOptions.resolve(isDebug: true, environment: [:], arguments: ["Clave", "--ui-test-fake", "--ui-test-notifications"])
    XCTAssertTrue(options.uiTestFakeAsksForNotifications)
    XCTAssertTrue(AppEnvironment.live(options).usesRemoteNotifications)
  }
}

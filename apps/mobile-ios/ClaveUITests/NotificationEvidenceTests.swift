import XCTest

/// Evidence I: the ways into a conversation from outside the app, on the in-process fake. A URL
/// named at launch (`CLAVE_IOS_OPEN_URL`, development builds only), the app's deep link opened
/// by the system while the app runs, and a push sent to the simulator by `scripts/evidence-push.sh`
/// whose banner is tapped.
final class NotificationEvidenceTests: XCTestCase {
  @MainActor private var springboard: XCUIApplication { XCUIApplication(bundleIdentifier: "com.apple.springboard") }
  private let chatLink = URL(string: "clave-ios://chat/m_fake/s_fake")!

  override func setUp() {
    continueAfterFailure = false
  }

  /// The fake keeps nothing across launches, so a launch naming a chat starts signed out: the link
  /// is kept, Machines says what it waits for, and once the person signs in and pairs its machine
  /// the pairing continues to the conversation.
  @MainActor
  func testALaunchURLIsKeptThroughTheSignInAndPairing() {
    let app = XCUIApplication()
    app.launchArguments = ["--ui-test-fake"]
    app.launchEnvironment["CLAVE_IOS_OPEN_URL"] = chatLink.absoluteString
    app.launch()
    let notice = app.staticTexts.matching(
      NSPredicate(format: "label CONTAINS %@", "Sign in and pair this machine to open the conversation.")
    ).firstMatch
    XCTAssertTrue(notice.waitForExistence(timeout: 10), "Machines does not say the link waits")
    XCTAssertTrue(app.buttons["machines.appearance"].isHittable, "Machines is not on top")
    keepScreenshot(topic: "notifications", name: "launch-url-kept")

    signIn(app)
    pairTheFakeMachine(app)
    let next = app.buttons["pairing.continue"]
    XCTAssertTrue(next.waitForExistence(timeout: 5))
    XCTAssertEqual(next.label, "Continue to the conversation")
    next.tap()
    XCTAssertTrue(element(app, "chat.composer.field").waitForExistence(timeout: 10), "The kept link did not open the chat")
    let title = app.staticTexts.matching(identifier: "pane.title").matching(NSPredicate(format: "label == 'Seeded chat'")).firstMatch
    XCTAssertTrue(title.exists)
    keepScreenshot(topic: "notifications", name: "launch-url-opened")
  }

  /// The deep link opened by the system while the app runs, signed in and paired: the chat over
  /// the machine's Workspaces.
  @MainActor
  func testAWarmDeepLinkOpensTheChat() {
    let app = signInAndPair()
    XCUIDevice.shared.system.open(chatLink)
    // The system may ask before it hands its own scheme to an app.
    let open = springboard.buttons["Open"]
    if open.waitForExistence(timeout: 3) { open.tap() }
    XCTAssertTrue(element(app, "chat.markdown.code").waitForExistence(timeout: 10), "The deep link did not open the chat")
    let title = app.staticTexts.matching(identifier: "pane.title").matching(NSPredicate(format: "label == 'Seeded chat'")).firstMatch
    XCTAssertTrue(title.exists)
    keepScreenshot(topic: "notifications", name: "deep-link-chat")
    goBack(app)
    XCTAssertTrue(app.buttons["workspaces.row.scratch"].waitForExistence(timeout: 5), "Back from the linked chat is not Workspaces")
  }
  // MARK: the push

  /// Where `scripts/evidence-push.sh` waits for the test's markers.
  private let pushFolder = evidenceRoot.appendingPathComponent("push", isDirectory: true)

  /// Asks the script for one push by writing its marker.
  private func askForPush(_ name: String) throws {
    try FileManager.default.createDirectory(at: pushFolder, withIntermediateDirectories: true)
    try Data().write(to: pushFolder.appendingPathComponent("ready-\(name)"))
  }

  /// The banner the system shows for a push whose body holds `text`.
  @MainActor
  private func banner(_ text: String) -> XCUIElement {
    springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
  }

  /// Two pushes sent from outside by `scripts/evidence-push.sh` (run it in the background first):
  /// a finished session's banner opens its chat, and a question about a conversation the machine
  /// no longer has opens the requests. Skipped when no push arrives (the script is not running).
  @MainActor
  func testAPushBannerOpensItsScreen() throws {
    let app = XCUIApplication()
    app.launchArguments = ["--ui-test-fake", "--ui-test-notifications"]
    // Pairing asks for the notification permission; the alert is answered whenever it shows.
    let monitor = addUIInterruptionMonitor(withDescription: "notification permission") { alert in
      let allow = alert.buttons["Allow"]
      guard allow.exists else { return false }
      allow.tap()
      return true
    }
    defer { removeUIInterruptionMonitor(monitor) }
    signInAndPair(app)
    let allow = springboard.buttons["Allow"]
    if allow.waitForExistence(timeout: 3) { allow.tap() }

    try askForPush("chat")
    let chatBanner = banner("Evidence push: Seeded chat finished")
    guard chatBanner.waitForExistence(timeout: 30) else {
      keepScreenshot(topic: "push", name: "no-banner")
      throw XCTSkip("No banner within 30 s: run scripts/evidence-push.sh beside this test")
    }
    keepScreenshot(topic: "push", name: "banner-chat")
    chatBanner.tap()
    XCTAssertTrue(element(app, "chat.markdown.code").waitForExistence(timeout: 10), "The banner did not open the chat")
    let title = app.staticTexts.matching(identifier: "pane.title").matching(NSPredicate(format: "label == 'Seeded chat'")).firstMatch
    XCTAssertTrue(title.exists)
    keepScreenshot(topic: "push", name: "opened-chat")

    try askForPush("requests")
    let questionBanner = banner("Evidence push: Which file should Echo read?")
    XCTAssertTrue(questionBanner.waitForExistence(timeout: 30), "No banner for the question")
    keepScreenshot(topic: "push", name: "banner-question")
    questionBanner.tap()
    XCTAssertTrue(app.buttons["requests.answer.r_fake"].waitForExistence(timeout: 10), "The banner did not open the requests")
    keepScreenshot(topic: "push", name: "opened-requests")
  }
}

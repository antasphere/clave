import XCTest

// The flows against the REAL isolated fixture stack (apps/mobile-ios/scripts/fixture-stack.mjs: a
// local OpenID Connect provider, the relay and an Echo-only server, all on 127.0.0.1), run by
// apps/mobile-ios/scripts/fixture-check.mjs. The driver hands the stack's facts to the test runner
// as TEST_RUNNER_CLAVE_FIXTURE_* variables; xcodebuild strips the prefix. Without them every test
// skips, so the suite never fails where no stack runs.
//
// The app is launched WITHOUT --ui-test-fake: CLAVE_IOS_ISSUER points the sign-in at the
// fixture provider and CLAVE_IOS_RELAY sets the relay, and everything goes over the network to
// the loopback stack. The stack keeps its state while the run lasts and the app's keychain
// persists across launches on the same simulator, so each test signs in and pairs again only
// when the screen shows it is needed. A cold launch with a paired machine opens that machine's
// Workspaces, so the helpers first find out which screen the launch landed on.

/// The stack's facts, read from the test runner's environment.
private struct FixtureFacts {
  let issuerURL: String
  let relayURL: String
  let serverURL: String
  let machineId: String
  /// Absent when the driver does not pass it; the workspace row is then found by its label.
  let workspaceId: String?
  let sessionId: String
  let nonce: String

  static let skipMessage =
    "No fixture stack: the fixture check driver passes TEST_RUNNER_CLAVE_FIXTURE_* variables; run node apps/mobile-ios/scripts/fixture-check.mjs"

  /// The workspace the stack registers, named after its folder.
  static let workspaceName = "scratch"

  static func read() throws -> FixtureFacts {
    let environment = ProcessInfo.processInfo.environment
    func value(_ name: String) -> String? {
      guard let raw = environment[name]?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
      return raw
    }
    guard let issuer = value("CLAVE_FIXTURE_ISSUER_URL") else { throw XCTSkip(skipMessage) }
    func required(_ name: String) throws -> String {
      guard let found = value(name) else {
        throw XCTSkip("The fixture check driver passed CLAVE_FIXTURE_ISSUER_URL but not \(name)")
      }
      return found
    }
    return FixtureFacts(
      issuerURL: issuer,
      relayURL: try required("CLAVE_FIXTURE_RELAY_URL"),
      serverURL: try required("CLAVE_FIXTURE_SERVER_URL"),
      machineId: try required("CLAVE_FIXTURE_MACHINE_ID"),
      workspaceId: value("CLAVE_FIXTURE_WORKSPACE_ID"),
      sessionId: try required("CLAVE_FIXTURE_SESSION_ID"),
      nonce: try required("CLAVE_FIXTURE_NONCE"))
  }
}

final class FixtureFlowTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testSignsInAtTheFixtureIssuerThroughTheSystemBrowser() throws {
    let facts = try FixtureFacts.read()
    let app = launchAgainstFixture(facts)
    ensureSignedIn(app)
    XCTAssertTrue(app.buttons["machines.signout"].exists)
    keepScreenshot(app, named: "testSignsInAtTheFixtureIssuerThroughTheSystemBrowser")
  }

  @MainActor
  func testPairsWithTheFixtureMachineOnTheRelay() throws {
    let facts = try FixtureFacts.read()
    let app = launchAgainstFixture(facts)
    ensureSignedIn(app)
    if ensurePaired(app, facts) {
      XCTAssertTrue(workspaceRow(app, facts).waitForExistence(timeout: 20), "no row for the scratch workspace")
      expectLabel(of: element(app, "machine.state"), equalTo: "Connected", timeout: 20)
    }
    keepScreenshot(app, named: "testPairsWithTheFixtureMachineOnTheRelay")
  }

  @MainActor
  func testReadsTheSeededChatAndIsAnswered() throws {
    let facts = try FixtureFacts.read()
    let app = launchAgainstFixture(facts)
    openWorkspaces(app, facts)

    let workspace = workspaceRow(app, facts)
    XCTAssertTrue(workspace.waitForExistence(timeout: 20), "no row for the scratch workspace")
    workspace.tap()
    let session = element(app, "sessions.row.\(facts.sessionId)")
    XCTAssertTrue(session.waitForExistence(timeout: 20), "no row for the seeded session")
    session.tap()

    XCTAssertTrue(
      chatElement(app, prefix: "chat.user.", containing: facts.nonce).waitForExistence(timeout: 20),
      "the seeded user message with the nonce is not shown")
    XCTAssertTrue(
      chatElement(app, prefix: "chat.assistant.", containing: facts.nonce).waitForExistence(timeout: 20),
      "the Echo reply repeating the nonce is not shown")

    let reply = "fixture-reply-\(Int(Date().timeIntervalSince1970))"
    let field = composerField(app)
    XCTAssertTrue(field.waitForExistence(timeout: 10), "no composer field")
    field.tap()
    field.typeText(reply)
    let send = app.buttons["chat.composer.send"]
    XCTAssertTrue(send.waitForExistence(timeout: 5))
    XCTAssertTrue(send.isEnabled, "the send button is disabled with a draft typed")
    send.tap()
    XCTAssertTrue(
      chatElement(app, prefix: "chat.assistant.", containing: reply).waitForExistence(timeout: 30),
      "the Echo adapter did not answer the reply")
    // The draft is cleared once the server accepted the message, which leaves nothing to send.
    let disabled = NSPredicate(format: "isEnabled == false")
    XCTAssertEqual(
      XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: disabled, object: send)], timeout: 10),
      .completed, "the send button is still enabled: the draft was not cleared")
    keepScreenshot(app, named: "testReadsTheSeededChatAndIsAnswered")
  }

  @MainActor
  func testNoRequestWaitsOnTheEchoFixture() throws {
    let facts = try FixtureFacts.read()
    let app = launchAgainstFixture(facts)
    openWorkspaces(app, facts)

    let inbox = app.buttons["workspaces.requests"]
    XCTAssertTrue(inbox.waitForExistence(timeout: 20), "no requests button on Workspaces")
    inbox.tap()
    XCTAssertTrue(element(app, "requests.empty").waitForExistence(timeout: 20), "the requests are not empty")
    keepScreenshot(app, named: "testNoRequestWaitsOnTheEchoFixture")
  }
}

// MARK: - the shared steps

extension FixtureFlowTests {
  /// The app launched on the real network path, its hub and relay the stack's.
  @MainActor
  fileprivate func launchAgainstFixture(_ facts: FixtureFacts) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = []
    app.launchEnvironment["CLAVE_IOS_ISSUER"] = facts.issuerURL
    app.launchEnvironment["CLAVE_IOS_RELAY"] = facts.relayURL
    app.launch()
    return app
  }

  /// Ends on Machines, signed in as the fixture owner: at once when the keychain kept a sign-in,
  /// else through ASWebAuthenticationSession and the springboard's consent alert.
  @MainActor
  fileprivate func ensureSignedIn(_ app: XCUIApplication) {
    showMachines(app)
    let name = element(app, "machines.account.name")
    if name.exists {
      XCTAssertTrue(name.label.contains("Fixture Owner"), "signed in as \(name.label), not the fixture owner")
      return
    }
    let signIn = app.buttons["machines.signin"]
    XCTAssertTrue(signIn.waitForExistence(timeout: 10), "no sign-in button on Machines")
    signIn.tap()

    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let proceed = springboard.buttons["Continue"]
    if !proceed.waitForExistence(timeout: 20) {
      XCTFail("the sign-in consent alert never showed; springboard showed: \(visibleElements(springboard))")
      return
    }
    // The button exists while the alert is still animating in, and a tap then is dropped: the alert
    // stays and the sign-in never starts. Tap again while it stays, three taps at most.
    let gone = NSPredicate(format: "exists == false")
    var dismissed = false
    for _ in 0..<3 where !dismissed {
      proceed.tap()
      dismissed =
        XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: gone, object: proceed)], timeout: 5) == .completed
    }
    if !dismissed {
      XCTFail("the sign-in consent alert stayed after three taps on Continue; springboard showed: \(visibleElements(springboard))")
      return
    }

    XCTAssertTrue(name.waitForExistence(timeout: 30), "the account never showed after the sign-in")
    expectLabel(of: name, containing: "Fixture Owner", timeout: 5)
    XCTAssertTrue(app.buttons["machines.signout"].exists)
  }

  /// From Machines, signed in: pairs the fixture machine when the relay lists it unpaired.
  /// Returns true when it paired now (the app then stands on the machine's Workspaces), false
  /// when the row was paired already (the app stays on Machines).
  @MainActor
  @discardableResult
  fileprivate func ensurePaired(_ app: XCUIApplication, _ facts: FixtureFacts) -> Bool {
    let row = element(app, "machines.row.\(facts.machineId)")
    if !row.waitForExistence(timeout: 10) {
      // One pull to refresh: the relay's list is read again.
      let list = app.collectionViews.firstMatch
      (list.exists ? list : app).swipeDown()
      XCTAssertTrue(row.waitForExistence(timeout: 20), "the relay does not list the fixture machine")
    }
    if element(app, "machines.paired.\(facts.machineId)").exists { return false }

    let pair = app.buttons["machines.pair.\(facts.machineId)"]
    XCTAssertTrue(pair.waitForExistence(timeout: 10), "no Pair button on the fixture machine's row")
    // An offline row disables Pair; the machine comes online once the server holds its relay link.
    let enabled = NSPredicate(format: "isEnabled == true")
    XCTAssertEqual(
      XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: enabled, object: pair)], timeout: 20),
      .completed, "the fixture machine stays offline: Pair is disabled")
    pair.tap()

    let state = element(app, "pairing.state")
    XCTAssertTrue(state.waitForExistence(timeout: 10), "no pairing state")
    let paired = NSPredicate(format: "label BEGINSWITH 'Paired'")
    let outcome = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: paired, object: state)], timeout: 40)
    XCTAssertEqual(outcome, .completed, "the pairing was not approved: \(state.label)")

    let next = app.buttons["pairing.continue"]
    XCTAssertTrue(next.waitForExistence(timeout: 5))
    next.tap()
    return true
  }

  /// Ends on the fixture machine's Workspaces, connected: signs in and pairs first when needed.
  @MainActor
  fileprivate func openWorkspaces(_ app: XCUIApplication, _ facts: FixtureFacts) {
    let landed = waitForAnyScreen(app)
    let onWorkspaces = landed && element(app, "machine.state").exists
      && app.buttons["workspaces.requests"].exists
    if !onWorkspaces {
      ensureSignedIn(app)
      if !ensurePaired(app, facts) {
        let open = app.buttons["machines.open.\(facts.machineId)"]
        XCTAssertTrue(open.waitForExistence(timeout: 5), "no Open button on the paired row")
        open.tap()
      }
    }
    XCTAssertTrue(app.buttons["workspaces.requests"].waitForExistence(timeout: 20), "Workspaces did not open")
    expectLabel(of: element(app, "machine.state"), equalTo: "Connected", timeout: 20)
  }

  /// Brings the app back to Machines: a cold launch with a paired machine opens its Workspaces.
  @MainActor
  fileprivate func showMachines(_ app: XCUIApplication) {
    XCTAssertTrue(waitForAnyScreen(app), "the launch reached neither Machines nor Workspaces")
    for _ in 0..<5 where !onMachines(app) {
      let back = app.navigationBars.buttons.element(boundBy: 0)
      guard back.waitForExistence(timeout: 5) else { break }
      back.tap()
      // Wait for the pushed screen to leave before reading the screen again.
      let gone = NSPredicate(format: "exists == false")
      _ = XCTWaiter().wait(
        for: [XCTNSPredicateExpectation(predicate: gone, object: element(app, "machine.state"))], timeout: 5)
    }
    XCTAssertTrue(onMachines(app), "could not get back to Machines")
  }

  @MainActor
  private func onMachines(_ app: XCUIApplication) -> Bool {
    // Machines stays under a pushed Workspaces in the stack, so its elements alone do not prove it shows.
    (app.buttons["machines.signin"].exists || element(app, "machines.account.name").exists)
      && !element(app, "machine.state").exists
  }

  /// Waits until the launch has settled on Machines (signed in or out) or on Workspaces.
  @MainActor
  private func waitForAnyScreen(_ app: XCUIApplication, timeout: TimeInterval = 20) -> Bool {
    let identifiers = ["machines.signin", "machines.account.name", "machine.state"]
    return app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier IN %@", identifiers))
      .firstMatch
      .waitForExistence(timeout: timeout)
  }

  /// The scratch workspace's row: by its id when the driver passes it, else by its label.
  @MainActor
  fileprivate func workspaceRow(_ app: XCUIApplication, _ facts: FixtureFacts) -> XCUIElement {
    if let id = facts.workspaceId { return element(app, "workspaces.row.\(id)") }
    return app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "workspaces.row.", FixtureFacts.workspaceName))
      .firstMatch
  }

  /// A turn by its identifier's prefix and its words: the person's turn is one element whose label
  /// holds them, the agent's a group of its drawn blocks with no label of its own, one of which holds
  /// them (ChatFlowTests reads the turns the same way).
  @MainActor
  private func chatElement(_ app: XCUIApplication, prefix: String, containing text: String) -> XCUIElement {
    let words = NSPredicate(format: "label CONTAINS %@", text)
    let turns = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix))
    return prefix == "chat.assistant." ? turns.containing(words).firstMatch : turns.matching(words).firstMatch
  }

  @MainActor
  private func composerField(_ app: XCUIApplication) -> XCUIElement {
    let view = app.textViews["chat.composer.field"]
    return view.exists ? view : app.textFields["chat.composer.field"]
  }

  @MainActor
  private func expectLabel(of target: XCUIElement, equalTo text: String, timeout: TimeInterval) {
    let predicate = NSPredicate(format: "label == %@", text)
    let outcome = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: target)], timeout: timeout)
    XCTAssertEqual(outcome, .completed, "\(target.identifier) reads \(target.exists ? target.label : "nothing"), not \(text)")
  }

  @MainActor
  private func expectLabel(of target: XCUIElement, containing text: String, timeout: TimeInterval) {
    let predicate = NSPredicate(format: "label CONTAINS %@", text)
    let outcome = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: target)], timeout: timeout)
    XCTAssertEqual(outcome, .completed, "\(target.identifier) reads \(target.exists ? target.label : "nothing"), not \(text)")
  }

  /// The springboard's alerts and buttons, by identifier and label only.
  @MainActor
  private func visibleElements(_ springboard: XCUIApplication) -> String {
    let found = (springboard.alerts.allElementsBoundByIndex + springboard.buttons.allElementsBoundByIndex)
      .prefix(30)
      .map { "[\($0.elementType == .alert ? "alert" : "button") id=\($0.identifier) label=\($0.label)]" }
    return found.isEmpty ? "nothing" : found.joined(separator: " ")
  }

  @MainActor
  private func keepScreenshot(_ app: XCUIApplication, named name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}

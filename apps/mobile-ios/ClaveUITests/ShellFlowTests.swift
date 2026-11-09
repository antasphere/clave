import XCTest

/// The shell end to end against the in-process fake (`--ui-test-fake`): the
/// hub, the relay and one machine answer inside the app, so these tests open
/// no socket and reach no server.
final class ShellFlowTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["--ui-test-fake"]
    app.launch()
    return app
  }

  @MainActor
  private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: identifier).firstMatch
  }

  @MainActor
  private func signIn(_ app: XCUIApplication) {
    let signIn = app.buttons["machines.signin"]
    XCTAssertTrue(signIn.waitForExistence(timeout: 10))
    signIn.tap()
    // The fake opener answers the browser's redirect itself: no sheet appears.
    XCTAssertTrue(app.staticTexts["Fake Person"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["machines.signout"].exists)
  }

  @MainActor
  func testSignInPairAndOpenWorkspaces() {
    let app = launch()
    signIn(app)

    let field = app.textFields["machines.relay.field"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.tap()
    field.typeText("https://relay.fake")
    app.buttons["machines.relay.save"].tap()

    XCTAssertTrue(element(app, "machines.row.m_fake").waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Fake Mac"].exists)
    // The row reads as one sentence to VoiceOver: name, online, platform.
    XCTAssertTrue(element(app, "machines.online.m_fake").label.contains("Online"))

    app.buttons["machines.pair.m_fake"].tap()
    // The fake approves on the second read, two polls of two seconds apart.
    let state = element(app, "pairing.state")
    XCTAssertTrue(state.waitForExistence(timeout: 5))
    let paired = NSPredicate(format: "label BEGINSWITH 'Paired'")
    expectation(for: paired, evaluatedWith: state)
    waitForExpectations(timeout: 15)

    app.buttons["pairing.continue"].tap()
    XCTAssertTrue(element(app, "placeholder.workspaces").waitForExistence(timeout: 5))
  }

  @MainActor
  func testRelaunchStartsSignedOut() {
    let app = launch()
    signIn(app)
    app.terminate()
    app.launch()
    // The fake keeps every store in memory, so a new process remembers no
    // sign-in: this is the fake's clean start, not the product's cold launch,
    // which keeps the sign-in in the Keychain and opens the paired machine.
    XCTAssertTrue(app.buttons["machines.signin"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["machines.signout"].exists)
  }

  @MainActor
  func testAppearanceFromTheHeader() {
    let app = launch()
    let gear = app.buttons["machines.appearance"]
    XCTAssertTrue(gear.waitForExistence(timeout: 10))
    gear.tap()

    let coffee = app.buttons["appearance.option.coffee"]
    let dark = app.buttons["appearance.option.dark"]
    XCTAssertTrue(coffee.waitForExistence(timeout: 5))
    dark.tap()
    waitUntilSelected(dark)
    XCTAssertFalse(coffee.isSelected)
    coffee.tap()
    waitUntilSelected(coffee)
    XCTAssertFalse(dark.isSelected)
  }

  /// The checkmark moves on the next render, a moment after the tap.
  @MainActor
  private func waitUntilSelected(_ element: XCUIElement) {
    expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: element)
    waitForExpectations(timeout: 5)
  }
}

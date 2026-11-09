import XCTest

// The steps every flow on the in-process fake (`--ui-test-fake`) starts with: launch, sign in
// through the fake hub, save the fake relay, pair `m_fake` and land on its Workspaces screen.

extension XCTestCase {
  /// The app launched on the fake.
  @MainActor
  func launchFake() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["--ui-test-fake"]
    app.launch()
    return app
  }

  /// Any element by its accessibility identifier, whatever its type.
  @MainActor
  func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: identifier).firstMatch
  }

  @MainActor
  func signIn(_ app: XCUIApplication) {
    let signIn = app.buttons["machines.signin"]
    XCTAssertTrue(signIn.waitForExistence(timeout: 10))
    signIn.tap()
    // The fake opener answers the browser's redirect itself: no sheet appears.
    XCTAssertTrue(app.staticTexts["Fake Person"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["machines.signout"].exists)
  }

  /// Launches `app` on the fake, signs in, pairs the fake machine and ends on its Workspaces screen.
  @MainActor
  @discardableResult
  func signInAndPair(_ app: XCUIApplication = XCUIApplication()) -> XCUIApplication {
    // Arguments the caller set (a text size, the notification permission) stay beside the fake's.
    if !app.launchArguments.contains("--ui-test-fake") { app.launchArguments.append("--ui-test-fake") }
    app.launch()
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
    XCTAssertTrue(app.buttons["workspaces.row.scratch"].waitForExistence(timeout: 10))
    return app
  }
}

import XCTest

/// The shell end to end against the in-process fake (`--ui-test-fake`): the
/// hub, the relay and one machine answer inside the app, so these tests open
/// no socket and reach no server.
final class ShellFlowTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testSignInPairAndOpenWorkspaces() {
    let app = signInAndPair()
    // The real Workspaces screen, over the fake machine's one workspace.
    let row = app.buttons["workspaces.row.scratch"]
    XCTAssertTrue(row.exists)
    XCTAssertEqual(row.label, "scratch")
    XCTAssertFalse(element(app, "placeholder.workspaces").exists)
  }

  /// Saving the relay address puts the keyboard away: the field gives up its focus.
  @MainActor
  func testSavingTheRelayAddressPutsTheKeyboardAway() {
    let app = launchFake()
    signIn(app)
    let field = app.textFields["machines.relay.field"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "No keyboard for the relay address")
    field.typeText("https://relay.fake")
    app.buttons["machines.relay.save"].tap()
    XCTAssertTrue(element(app, "machines.row.m_fake").waitForExistence(timeout: 10))
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5), "The keyboard stays up after the save")
  }

  @MainActor
  func testRelaunchStartsSignedOut() {
    let app = launchFake()
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
    let app = launchFake()
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

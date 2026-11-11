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
    tapAndWaitUntilSelected("dark", in: app)
    XCTAssertFalse(coffee.isSelected)
    tapAndWaitUntilSelected("coffee", in: app)
    XCTAssertFalse(dark.isSelected)
  }

  private static let appearanceOptions = ["system", "dark", "light", "coffee", "charcoal"]

  /// Taps an appearance option, then waits until it shows selected.
  @MainActor
  private func tapAndWaitUntilSelected(_ name: String, in app: XCUIApplication) {
    let identifier = "appearance.option.\(name)"
    let option = app.buttons[identifier]
    let asked = Date()
    option.tap()
    waitUntilSelected(option, identifier, in: app, tapAsked: asked, tapReturned: Date())
  }

  /// The checkmark moves on the next render, a moment after the tap; on a loaded runner the tap
  /// itself and the snapshots that read the screen can take seconds, so the wait allows 20. When even
  /// that passes, a screenshot and what the test could read of every appearance option are attached
  /// before the failure, which names the option waited for.
  @MainActor
  private func waitUntilSelected(
    _ option: XCUIElement, _ identifier: String, in app: XCUIApplication, tapAsked: Date, tapReturned: Date
  ) {
    let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isSelected == true"), object: option)
    let result = XCTWaiter.wait(for: [selected], timeout: 20)
    guard result != .completed else { return }
    let since = Date().timeIntervalSince(tapReturned)
    let ended = result == .timedOut ? "timed out" : "ended with result \(result.rawValue)"
    var options: [String] = []
    for name in Self.appearanceOptions {
      let id = "appearance.option.\(name)"
      if let seen = try? app.buttons[id].firstMatch.snapshot() {
        options.append("\(seen.identifier): exists true, isSelected \(seen.isSelected), label \"\(seen.label)\"")
      } else {
        options.append("\(id): exists false")
      }
    }
    let timing = String(
      format: "%.2f s since the tap returned (the tap took %.2f s)", since, tapReturned.timeIntervalSince(tapAsked))
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "Appearance when the wait for \(identifier) \(ended)"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let report = XCTAttachment(
      string: (["The wait for \(identifier) to be selected \(ended), \(timing)."] + options).joined(separator: "\n"))
    report.name = "Appearance options when the wait for \(identifier) \(ended)"
    report.lifetime = .keepAlways
    add(report)
    XCTFail("\(identifier) was not selected within 20 seconds, \(timing): \(options.joined(separator: "; "))")
  }
}

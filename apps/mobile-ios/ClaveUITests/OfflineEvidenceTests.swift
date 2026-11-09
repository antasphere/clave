import XCTest

/// Evidence H: the fake drops every socket on an `offline:` message and refuses new ones for a
/// few seconds; the machine's state line on Workspaces reads Offline, then Connected again on its own.
final class OfflineEvidenceTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testTheMachineGoesOfflineAndComesBack() {
    let app = signInAndPair()
    let state = element(app, "machine.state")
    XCTAssertTrue(state.waitForExistence(timeout: 5))
    expectation(for: NSPredicate(format: "label == 'Connected'"), evaluatedWith: state)
    waitForExpectations(timeout: 10)

    // The chat opened by its deep link sits right over Workspaces: one step back to the state line.
    // Opened by the system, as a tapped link would: `XCUIApplication.open(_:)` relaunches the app,
    // and the fake keeps nothing across launches.
    XCUIDevice.shared.system.open(URL(string: "clave-ios://chat/m_fake/s_fake")!)
    let field = chatComposerField(app)
    XCTAssertTrue(element(app, "chat.markdown.code").waitForExistence(timeout: 10))
    field.tap()
    field.typeText("offline:")
    app.buttons["chat.composer.send"].tap()
    let sent = Date()
    goBack(app)

    let offlineLine = app.staticTexts.matching(NSPredicate(format: "identifier == 'machine.state' AND label == 'Offline'")).firstMatch
    XCTAssertTrue(offlineLine.waitForExistence(timeout: 5), "The state line never read Offline")
    let offline = Date()
    keepScreenshot(topic: "offline", name: "state-line")
    let reason = element(app, "machine.state.reason")
    let said = reason.exists ? reason.label : "(no reason shown)"

    let line = element(app, "machine.state")
    expectation(for: NSPredicate(format: "label == 'Connected'"), evaluatedWith: line)
    waitForExpectations(timeout: 15)
    let back = Date()
    keepScreenshot(topic: "offline", name: "state-line-connected")
    keepText(
      String(
        format: "send to Offline seen %.2f s\nsend to Connected again %.2f s\nreason: %@\n",
        offline.timeIntervalSince(sent), back.timeIntervalSince(sent), said),
      topic: "offline", name: "timings.txt")
  }
}

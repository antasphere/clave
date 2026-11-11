import XCTest

/// Evidence F on this notch device: the header below the status bar, the send button above the
/// home indicator with the keyboard down and above the keyboard with it up.
final class SafeAreaEvidenceTests: XCTestCase {
  /// The status bar's height on the smallest notch phones; an iPhone 15 Pro's is taller still.
  private let statusBar: CGFloat = 44
  /// The home indicator's strip at the foot of a phone without a home button.
  private let homeIndicator: CGFloat = 34

  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testHeadersAndTheComposerKeepClearOfTheSystemBars() {
    let app = signInAndPair()
    let window = app.windows.firstMatch.frame
    var lines = ["window \(window)"]

    goToMachines(app)
    let machinesTitle = element(app, "pane.title")
    XCTAssertTrue(machinesTitle.waitForExistence(timeout: 5))
    XCTAssertEqual(machinesTitle.label, "Machines")
    XCTAssertGreaterThan(machinesTitle.frame.minY, statusBar, "\(machinesTitle.frame)")
    lines.append("machines title \(machinesTitle.frame)")
    keepScreenshot(topic: "safe-area", name: "machines")

    app.buttons["machines.open.m_fake"].tap()
    openSeededChat(app)
    let chatTitle = app.staticTexts.matching(identifier: "pane.title").matching(NSPredicate(format: "label == 'Seeded chat'")).firstMatch
    XCTAssertTrue(chatTitle.waitForExistence(timeout: 5))
    XCTAssertGreaterThan(chatTitle.frame.minY, statusBar, "\(chatTitle.frame)")
    lines.append("chat title \(chatTitle.frame)")

    let send = app.buttons["chat.composer.send"]
    XCTAssertTrue(send.exists)
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    XCTAssertLessThanOrEqual(send.frame.maxY, window.maxY - homeIndicator, "\(send.frame) in \(window)")
    lines.append("send, keyboard down \(send.frame)")
    keepScreenshot(topic: "safe-area", name: "chat-keyboard-down")

    let field = chatComposerField(app)
    field.tap()
    let keyboard = app.keyboards.firstMatch
    XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
    // XCUITest reads the frames once the app is idle, the keyboard's animation done.
    XCTAssertLessThanOrEqual(send.frame.maxY, keyboard.frame.minY, "\(send.frame) over \(keyboard.frame)")
    XCTAssertGreaterThan(chatTitle.frame.minY, statusBar, "\(chatTitle.frame)")
    lines.append("send, keyboard up \(send.frame), keyboard \(keyboard.frame), title \(chatTitle.frame)")
    keepScreenshot(topic: "safe-area", name: "chat-keyboard-up")
    keepText(lines.joined(separator: "\n") + "\n", topic: "safe-area", name: "frames.txt")
  }
}

import XCTest

/// Evidence D: the six screens at the largest accessibility text size. Each screen's title must
/// be reachable, and the buttons the flow needs on it hittable without scrolling past them.
final class DynamicTypeEvidenceTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testTheScreensAtTheLargestTextSize() {
    let app = XCUIApplication()
    // The raw value of `UIContentSizeCategory.accessibilityExtraExtraExtraLarge`; the spelled-out
    // name is not one UIKit reads, and the launch then keeps the default size.
    app.launchArguments = ["--ui-test-fake", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
    signInAndPair(app)
    var lines: [String] = []
    walkScreens(app) { screen in
      keepScreenshot(topic: "dynamic-type", name: screen.rawValue)
      let titles = app.staticTexts.matching(identifier: "pane.title")
      let title = titles.element(boundBy: titles.count - 1)
      XCTAssertTrue(title.exists, "\(screen): no title")
      XCTAssertTrue(title.isHittable, "\(screen): the title \(title.label) is not on screen")
      // At the default size the title is 20.7 points tall: the setting must have reached the screen.
      XCTAssertGreaterThan(title.frame.height, 30, "\(screen): the text size did not apply")
      var report = ["\(screen.rawValue): title '\(title.label)' \(title.frame)"]
      for identifier in required(screen) {
        let target = element(app, identifier)
        XCTAssertTrue(target.exists, "\(screen): no \(identifier)")
        XCTAssertTrue(target.isHittable, "\(screen): \(identifier) is off screen at \(target.frame)")
        report.append("  \(identifier) \(target.frame)")
      }
      lines.append(report.joined(separator: "\n"))
    }
    keepText(lines.joined(separator: "\n") + "\n", topic: "dynamic-type", name: "frames.txt")
  }

  /// The buttons a person needs on each screen of the flow.
  private func required(_ screen: EvidenceScreen) -> [String] {
    switch screen {
    case .machines: ["machines.appearance", "machines.open.m_fake"]
    case .workspaces: ["workspaces.requests", "workspaces.row.scratch"]
    case .sessions: ["sessions.new", "sessions.row.s_fake"]
    case .launch: []
    case .chat: ["chat.composer.field", "chat.composer.send", "chat.composer.attach"]
    case .requests: ["requests.answer.r_fake"]
    }
  }
}

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
      if screen == .chat { report += composerFits(app) + toolRunFits(app) }
      lines.append(report.joined(separator: "\n"))
    }
    keepText(lines.joined(separator: "\n") + "\n", topic: "dynamic-type", name: "frames.txt")
  }

  /// The composer at this size: the send and attach buttons lie inside the dock's box, and the send
  /// button's frame has grown with its scaled circle (44 points at the default size), so the box
  /// that holds the frame holds the circle. Kept as `dynamic-type/composer.png`.
  @MainActor
  private func composerFits(_ app: XCUIApplication) -> [String] {
    let dock = element(app, "chat.composer.dock")
    XCTAssertTrue(dock.exists, "chat: no composer dock")
    var report = ["  chat.composer.dock \(dock.frame)"]
    for identifier in ["chat.composer.send", "chat.composer.attach"] {
      let frame = element(app, identifier).frame
      XCTAssertTrue(
        dock.frame.insetBy(dx: -0.5, dy: -0.5).contains(frame), "chat: \(identifier) \(frame) is not inside the dock \(dock.frame)")
    }
    let send = element(app, "chat.composer.send").frame
    XCTAssertGreaterThan(send.height, 44, "chat: the send button's frame \(send) did not grow with its circle")
    keepScreenshot(topic: "dynamic-type", name: "composer", of: dock)
    return report
  }

  /// The seeded failed run (`make check`) at this size: its row on screen inside the window, its
  /// failure in its label. Kept as `dynamic-type/chat-tool-row.png`, the picture of "1 failed"
  /// under the summary: the row is one button for VoiceOver, so no test reads the lines inside it.
  @MainActor
  private func toolRunFits(_ app: XCUIApplication) -> [String] {
    let row = element(app, "chat.tool.t_failed")
    XCTAssertTrue(row.waitForExistence(timeout: 5), "chat: no row for the failed tool run")
    XCTAssertTrue(row.isHittable, "chat: the failed tool run's row is off screen at \(row.frame)")
    let window = app.windows.firstMatch.frame
    XCTAssertTrue(
      window.insetBy(dx: -0.5, dy: -0.5).contains(row.frame), "chat: the failed tool run's row \(row.frame) is not inside the window \(window)")
    XCTAssertTrue(row.label.hasSuffix("1 failed"), "chat: the failed tool run reads '\(row.label)'")
    keepScreenshot(topic: "dynamic-type", name: "chat-tool-row", of: row)
    return ["  chat.tool.t_failed '\(row.label)' \(row.frame)"]
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

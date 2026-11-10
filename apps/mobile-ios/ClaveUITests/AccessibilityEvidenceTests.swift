import XCTest

/// Evidence C: Xcode's accessibility audit on each of the six screens, and the order VoiceOver
/// meets their buttons, texts and fields, written to `evidence/a11y/<screen>-order.txt`. What the
/// audit still reports is written to `evidence/a11y/<screen>-audit.txt` in its own words; the same
/// walk with the app at the largest accessibility text size writes `xxxl-<screen>-audit.txt`.
final class AccessibilityEvidenceTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  /// The audit's findings recorded rather than fixed (in the dark theme), by screen: the audit's
  /// compact description and the element's identifier, else its label. Anything else the audit
  /// reports fails the test, so a new finding is seen.
  private let recorded: [EvidenceScreen: Set<String>] = AccessibilityEvidenceTests.unresolvedContrast

  /// The same, the app launched at the largest accessibility text size.
  private let recordedAtTheLargestTextSize: [EvidenceScreen: Set<String>] = AccessibilityEvidenceTests.unresolvedContrast

  // unresolved: red in the full run, green alone, cause unknown
  private static let unresolvedContrast: [EvidenceScreen: Set<String>] = [
    .chat: ["Contrast failed | Name", "Contrast failed | Value", "Contrast failed | alpha", "Contrast failed | 1"],
    .requests: ["Contrast failed | requests.dismiss.r_fake"],
  ]

  @MainActor
  func testEachScreenPassesTheAuditAndKeepsItsOrder() throws {
    let app = signInAndPair()
    pickAppearance(app, "dark")
    auditEachScreen(app, recorded: recorded, prefix: "")
  }

  @MainActor
  func testEachScreenPassesTheAuditAtTheLargestTextSize() throws {
    let app = XCUIApplication()
    // The raw value of `UIContentSizeCategory.accessibilityExtraExtraExtraLarge`.
    app.launchArguments = ["--ui-test-fake", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
    signInAndPair(app)
    pickAppearance(app, "dark")
    auditEachScreen(app, recorded: recordedAtTheLargestTextSize, prefix: "xxxl-")
  }

  /// The walk over the six screens: on each, the order, the audit against `recorded`, and the
  /// fields' own frames; the files named with `prefix`.
  @MainActor
  private func auditEachScreen(_ app: XCUIApplication, recorded: [EvidenceScreen: Set<String>], prefix: String) {
    var unexpected: [String] = []
    var summary: [String] = []
    var fields: [String: CGRect] = [:]
    walkScreens(app) { screen in
      // An audit reads the screen, not a keyboard over it.
      dismissKeyboard(app)
      keepScreenshot(topic: "a11y", name: "\(prefix)\(screen.rawValue)")
      writeOrder(app, screen, prefix: prefix)
      if let field = Self.field[screen] { fields[field] = element(app, field).frame }
      var found: [String] = []
      do {
        try app.performAccessibilityAudit(for: .all) { issue in
          let target = issue.element.map { "\($0.elementType.rawValue) '\($0.identifier)' '\($0.label)' \($0.frame)" } ?? "no element"
          found.append("\(issue.compactDescription) | \(issue.detailedDescription) | \(target)")
          let key = "\(issue.compactDescription) | \(issue.element.map { $0.identifier.isEmpty ? $0.label : $0.identifier } ?? "")"
          if !(recorded[screen] ?? []).contains(key) {
            unexpected.append("\(screen.rawValue): \(issue.compactDescription) on \(target)")
          }
          return true
        }
      } catch {
        unexpected.append("\(screen.rawValue): the audit did not run: \(error)")
      }
      keepText(
        found.isEmpty ? "no issue\n" : found.joined(separator: "\n") + "\n", topic: "a11y",
        name: "\(prefix)\(screen.rawValue)-audit.txt")
      summary.append("\(screen.rawValue): \(found.count) issue(s)")
    }
    summary += fields.keys.sorted().map { "\($0) \(fields[$0] ?? .null)" }
    keepText(summary.joined(separator: "\n") + "\n", topic: "a11y", name: "\(prefix)summary.txt")
    XCTAssertTrue(unexpected.isEmpty, unexpected.joined(separator: "\n"))
    // The fields' own frames, the elements a finger and VoiceOver reach, are at least 44 points tall.
    for (field, frame) in fields {
      XCTAssertGreaterThanOrEqual(frame.height, 44, "\(field) is \(frame.height) points tall")
    }
  }

  /// The text field of each screen that has one.
  private static let field: [EvidenceScreen: String] = [
    .chat: "chat.composer.field",
    .requests: "chat.permission.r_fake.question.0.answer",
  ]

  /// The labels of the buttons, texts and fields of the screen, in the accessibility tree's order.
  @MainActor
  private func writeOrder(_ app: XCUIApplication, _ screen: EvidenceScreen, prefix: String) {
    let kinds: [XCUIElement.ElementType: String] = [
      .button: "button", .staticText: "text", .textField: "field", .textView: "field", .link: "link", .image: "image",
    ]
    var lines: [String] = []
    func walk(_ node: any XCUIElementSnapshot) {
      if let kind = kinds[node.elementType], !(node.label.isEmpty && node.identifier.isEmpty) {
        let label = node.label.replacingOccurrences(of: "\n", with: " / ")
        lines.append("\(kind): \(label)" + (node.identifier.isEmpty ? "" : "  [\(node.identifier)]"))
      }
      for child in node.children { walk(child) }
    }
    do {
      walk(try app.snapshot())
    } catch {
      XCTFail("No snapshot of \(screen): \(error)")
    }
    keepText(lines.joined(separator: "\n") + "\n", topic: "a11y", name: "\(prefix)\(screen.rawValue)-order.txt")
  }
}

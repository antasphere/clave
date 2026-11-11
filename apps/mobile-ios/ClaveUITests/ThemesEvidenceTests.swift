import XCTest

/// Evidence A: each of the four themes on the six screens of a paired machine, against the
/// in-process fake. Every screen is kept as `evidence/themes/<theme>-<screen>.png`, and its ground
/// is read off the screenshot: dark and light must paint every screen differently, so the theme
/// reaches the screens and not only the picker.
final class ThemesEvidenceTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testEveryThemeOnEveryScreen() {
    let app = signInAndPair()
    var grounds: [String: [EvidenceScreen: Pixel]] = [:]
    for theme in ["dark", "light", "coffee", "charcoal"] {
      pickAppearance(app, theme)
      walkScreens(app) { screen in
        let shot = keepScreenshot(topic: "themes", name: "\(theme)-\(screen.rawValue)")
        grounds[theme, default: [:]][screen] = groundPixel(shot)
      }
    }

    var lines: [String] = []
    for screen in EvidenceScreen.allCases {
      let dark = grounds["dark"]?[screen]
      let light = grounds["light"]?[screen]
      XCTAssertNotNil(dark)
      XCTAssertNotNil(light)
      if let dark, let light {
        // #0e0d0c against #fbfbf9 on the tokens: far apart, whatever the screenshot's colour handling.
        XCTAssertGreaterThan(dark.distance(to: light), 300, "\(screen): dark \(dark) and light \(light) paint the same ground")
      }
      let row = ["dark", "light", "coffee", "charcoal"].map { "\($0) \(grounds[$0]?[screen]?.description ?? "-")" }
      lines.append("\(screen.rawValue): " + row.joined(separator: ", "))
    }
    keepText(lines.joined(separator: "\n") + "\n", topic: "themes", name: "grounds.txt")
    // The four themes are four grounds on the Machines screen.
    let machines = Set(["dark", "light", "coffee", "charcoal"].compactMap { grounds[$0]?[.machines]?.description })
    XCTAssertEqual(machines.count, 4, lines.joined(separator: "\n"))
  }
}

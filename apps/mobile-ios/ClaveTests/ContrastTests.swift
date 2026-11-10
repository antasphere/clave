import XCTest
@testable import Clave

/// The palette the text rules rely on, measured from the generated tokens as WCAG 2 defines
/// contrast: an ink's opacity composited over the opaque surface in sRGB, then the relative
/// luminance of each. Words use the three text inks on the surfaces below, and never a shared
/// semantic ink: the last test says why.
final class ContrastTests: XCTestCase {
  /// WCAG 2's AA ratio for text under 18 points: every word of the app is such text at some size.
  private static let required = 4.5

  /// The contrast of `ink` over `surface`, from 1 to 21.
  static func ratio(_ ink: TokenColor, on surface: TokenColor) -> Double {
    let alpha = ink.opacity
    func over(_ channel: Double, _ ground: Double) -> Double { channel * alpha + ground * (1 - alpha) }
    let composed = luminance(over(ink.red, surface.red), over(ink.green, surface.green), over(ink.blue, surface.blue))
    let ground = luminance(surface.red, surface.green, surface.blue)
    return (max(composed, ground) + 0.05) / (min(composed, ground) + 0.05)
  }

  private static func luminance(_ red: Double, _ green: Double, _ blue: Double) -> Double {
    func linear(_ channel: Double) -> Double {
      channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
  }

  private func surfaces(_ colors: ThemeColors) -> [(String, TokenColor)] {
    [
      ("surface0", colors.surface0), ("surface50", colors.surface50), ("surface100", colors.surface100),
      ("surface200", colors.surface200), ("surfaceRaised", colors.surfaceRaised),
    ]
  }

  /// textPrimary on every surface, textSecondary on all but surface200, textTertiary on the
  /// ground, the first step and a raised box: in all four themes.
  func testTheTextInksPassWhereTheRulesPutThemInEveryTheme() throws {
    var below: [String] = []
    for name in ThemeName.allCases {
      let colors = try XCTUnwrap(themeColors[name])
      let rules: [(String, TokenColor, Set<String>)] = [
        ("textPrimary", colors.textPrimary, ["surface0", "surface50", "surface100", "surface200", "surfaceRaised"]),
        ("textSecondary", colors.textSecondary, ["surface0", "surface50", "surface100", "surfaceRaised"]),
        ("textTertiary", colors.textTertiary, ["surface0", "surface50", "surfaceRaised"]),
      ]
      for (ink, value, allowed) in rules {
        for (surface, ground) in surfaces(colors) where allowed.contains(surface) {
          let ratio = Self.ratio(value, on: ground)
          if ratio < Self.required { below.append("\(name) \(ink) on \(surface): \(String(format: "%.2f", ratio))") }
        }
      }
    }
    XCTAssertTrue(below.isEmpty, "Below 4.5: " + below.joined(separator: ", "))
  }

  /// Where the rules send words elsewhere: tertiary words leave surface100 and surface200, and
  /// surface200 takes textPrimary, because these pairs read below 4.5.
  func testThePairsTheRulesRouteAroundReadBelowTheRatio() throws {
    let light = try XCTUnwrap(themeColors[.light])
    let charcoal = try XCTUnwrap(themeColors[.charcoal])
    let pairs: [(String, Double)] = [
      ("light textTertiary on surface100", Self.ratio(light.textTertiary, on: light.surface100)),
      ("light textTertiary on surface200", Self.ratio(light.textTertiary, on: light.surface200)),
      ("charcoal textSecondary on surface200", Self.ratio(charcoal.textSecondary, on: charcoal.surface200)),
    ]
    for (pair, ratio) in pairs {
      XCTAssertLessThan(ratio, Self.required, "\(pair) reads \(String(format: "%.2f", ratio))")
    }
  }

  /// Why no word is drawn in a shared semantic ink: on the light ground at least one of them
  /// (here most of them) reads below 4.5; they stay on glyphs, the words beside them in text inks.
  func testASharedSemanticInkReadsBelowTheRatioOnTheLightGround() throws {
    let ground = try XCTUnwrap(themeColors[.light]).surface0
    let inks: [(String, TokenColor)] = [
      ("destructive", sharedColors.destructive), ("success", sharedColors.success), ("warning", sharedColors.warning),
      ("statusWorking", sharedColors.statusWorking), ("statusReady", sharedColors.statusReady),
      ("statusWaiting", sharedColors.statusWaiting), ("statusInactive", sharedColors.statusInactive),
    ]
    let below = inks.map { ($0.0, Self.ratio($0.1, on: ground)) }.filter { $0.1 < Self.required }
    XCTAssertFalse(below.isEmpty, "Every semantic ink reads 4.5 or more on the light ground")
    XCTAssertTrue(below.contains { $0.0 == "warning" }, below.map { "\($0.0) \(String(format: "%.2f", $0.1))" }.joined(separator: ", "))
  }
}

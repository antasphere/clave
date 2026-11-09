import SwiftUI
import UIKit
import XCTest
@testable import Clave

@MainActor
final class ThemeTests: XCTestCase {
  func testThemeForResolvesEveryAppearance() {
    XCTAssertEqual(themeFor(.system, colorScheme: .light), .light)
    XCTAssertEqual(themeFor(.system, colorScheme: .dark), .dark)
    XCTAssertEqual(themeFor(.system, colorScheme: nil), .dark)
    for scheme: ColorScheme? in [.light, .dark, nil] {
      XCTAssertEqual(themeFor(.dark, colorScheme: scheme), .dark)
      XCTAssertEqual(themeFor(.light, colorScheme: scheme), .light)
      XCTAssertEqual(themeFor(.coffee, colorScheme: scheme), .coffee)
      XCTAssertEqual(themeFor(.charcoal, colorScheme: scheme), .charcoal)
    }
  }

  func testAppearanceLabels() {
    XCTAssertEqual(Appearance.allCases.map(\.label), ["Match the system", "Dark", "Light", "Coffee", "Charcoal"])
  }

  func testEveryThemeHasColorsAndTheGroundsDiffer() {
    XCTAssertEqual(themeColors.count, ThemeName.allCases.count)
    let grounds = ThemeName.allCases.compactMap { themeColors[$0]?.surface0 }
    XCTAssertEqual(grounds.count, ThemeName.allCases.count)
    XCTAssertEqual(Set(grounds.map { "\($0.red) \($0.green) \($0.blue)" }).count, grounds.count)
    XCTAssertEqual(ThemeName.allCases.filter { Theme($0).isDark }, [.dark, .charcoal])
  }

  func testGeistFacesAreRegistered() {
    for name in [GeistWeight.regularFontName, GeistWeight.mediumFontName, GeistWeight.semiboldFontName] {
      XCTAssertNotNil(UIFont(name: name, size: 13), "\(name) is not registered by the bundle")
    }
    XCTAssertEqual(fontWeightMedium, 400)
    XCTAssertEqual(GeistWeight.medium.fontName, "Geist-Regular")
    XCTAssertEqual(GeistWeight.regular.fontName, "Geist-Regular")
    XCTAssertEqual(GeistWeight.semibold.fontName, "Geist-SemiBold")
  }

  func testEveryIconIsInTheCatalog() {
    XCTAssertFalse(IconName.allCases.isEmpty)
    for icon in IconName.allCases {
      XCTAssertNotNil(UIImage(named: icon.assetName, in: .main, with: nil), "\(icon.assetName) is missing")
    }
  }

  func testAppearanceStorePersistsAndFallsBack() throws {
    let suite = "clave.tests.appearance.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }

    XCTAssertEqual(AppearanceStore(defaults: defaults).appearance, .system)

    let store = AppearanceStore(defaults: defaults)
    store.appearance = .coffee
    XCTAssertEqual(defaults.string(forKey: "clave.appearance"), "coffee")
    XCTAssertEqual(AppearanceStore(defaults: defaults).appearance, .coffee)

    defaults.set("sepia", forKey: "clave.appearance")
    XCTAssertEqual(AppearanceStore(defaults: defaults).appearance, .system)
    defaults.set(42, forKey: "clave.appearance")
    XCTAssertEqual(AppearanceStore(defaults: defaults).appearance, .system)
  }
}

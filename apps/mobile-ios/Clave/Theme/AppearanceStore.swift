import Foundation
import Observation

/// The person's appearance choice, kept across launches.
@Observable @MainActor final class AppearanceStore {
  static let defaultsKey = "clave.appearance"

  @ObservationIgnored private let defaults: UserDefaults

  var appearance: Appearance {
    didSet { defaults.set(appearance.rawValue, forKey: Self.defaultsKey) }
  }

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    // A value written by another build, or by hand, must not strand the app on no theme.
    appearance = defaults.string(forKey: Self.defaultsKey).flatMap(Appearance.init(rawValue:)) ?? .system
  }

  // The target's default MainActor isolation makes deinit hop to the main
  // executor, and the back-deployed hop frees a task-local scope it never
  // allocated when the last release happens inside one (an XCTest assertion
  // autoclosure does exactly that). Nothing here needs the actor to tear down.
  nonisolated deinit {}
}

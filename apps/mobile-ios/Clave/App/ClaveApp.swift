import SwiftUI
import ClaveCore

@main
struct ClaveApp: App {
  var body: some Scene {
    WindowGroup {
      Text("Clave \(ClaveCoreInfo.version)")
        .accessibilityIdentifier("app.placeholder")
    }
  }
}

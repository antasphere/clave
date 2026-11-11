import ClaveCore
import SwiftUI

@main
struct ClaveApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @State private var model = AppModel(environment: .live())
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      ThemedRoot(model: model)
        .onAppear { delegate.model = model }
        .task { await model.start() }
        .onOpenURL { model.handle(url: $0) }
    }
    .onChange(of: scenePhase) { _, phase in model.scenePhaseChanged(phase) }
  }
}

/// Resolves the theme against the system's scheme, read outside the theme's
/// own scheme override so "Match the system" follows the phone.
private struct ThemedRoot: View {
  let model: AppModel
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    let theme = Theme(themeFor(model.appearance.appearance, colorScheme: colorScheme))
    RootView(model: model)
      .claveTheme(theme)
      .background(theme.colors.surface0.ignoresSafeArea())
  }
}

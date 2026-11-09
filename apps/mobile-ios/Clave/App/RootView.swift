import SwiftUI

/// The one navigation stack: Machines at its root, every other screen a route.
struct RootView: View {
  @Bindable var model: AppModel

  @Environment(\.claveTheme) private var theme

  var body: some View {
    NavigationStack(path: $model.path) {
      MachinesScreen(model: model)
        .navigationDestination(for: Route.self) { route in
          destination(route)
            .toolbarBackground(theme.colors.surface0, for: .navigationBar)
        }
    }
  }

  @ViewBuilder
  private func destination(_ route: Route) -> some View {
    switch route {
    case .machines:
      MachinesScreen(model: model)
    case .pairing(let machineId):
      PairingScreen(model: model, machineId: machineId)
    case .appearance:
      AppearanceScreen(store: model.appearance)
    case .workspaces:
      PlaceholderScreen(title: "Workspaces", identifier: "placeholder.workspaces")
    case .sessions:
      PlaceholderScreen(title: "Sessions", identifier: "placeholder.sessions")
    case .chat:
      PlaceholderScreen(title: "Conversation", identifier: "placeholder.chat")
    case .requests:
      PlaceholderScreen(title: "Requests", identifier: "placeholder.requests")
    case .launch:
      PlaceholderScreen(title: "New session", identifier: "placeholder.launch")
    }
  }
}

/// A screen another part of the app fills in later.
struct PlaceholderScreen: View {
  let title: String
  let identifier: String

  @Environment(\.claveTheme) private var theme

  var body: some View {
    EmptyState(icon: .wrench, title: "Coming next", text: "\(title) is the next screen to be built.")
      .accessibilityIdentifier(identifier)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(theme.colors.surface0)
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
  }
}

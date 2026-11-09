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
    case .workspaces(let machineId):
      WorkspacesScreen(model: model, machineId: machineId)
    case .sessions(let machineId, let workspaceId):
      SessionsScreen(model: model, machineId: machineId, workspaceId: workspaceId)
    case .chat(let machineId, let sessionId):
      ChatRoute(model: model, machineId: machineId, sessionId: sessionId)
    case .requests(let machineId):
      RequestsScreen(model: model, machineId: machineId)
    case .launch(let machineId, let workspaceId):
      LaunchScreen(model: model, machineId: machineId, workspaceId: workspaceId)
    }
  }
}

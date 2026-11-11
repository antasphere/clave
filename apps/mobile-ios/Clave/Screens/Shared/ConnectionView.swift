import ClaveCore
import SwiftUI

/// A screen over one machine's connection: a spinner while the connection is made, a way back to
/// Machines when this phone keeps no credential for the machine, else the screen itself. Pushed
/// screens keep the system bar for the back button, with an empty title: the title is the
/// screen's own PaneHeader.
struct ConnectionView<Content: View>: View {
  let model: AppModel
  let machineId: String
  @ViewBuilder let content: (MachineConnection) -> Content

  @Environment(\.claveTheme) private var theme
  @State private var connection: MachineConnection?
  @State private var answered = false

  init(model: AppModel, machineId: String, @ViewBuilder content: @escaping (MachineConnection) -> Content) {
    self.model = model
    self.machineId = machineId
    self.content = content
  }

  var body: some View {
    Group {
      if let connection, connection.machineId == machineId {
        content(connection)
      } else if answered {
        VStack(spacing: Theme.space(3)) {
          EmptyState(icon: .computerDesktop, title: "This machine is not paired any more.")
          Button("Back to machines") { model.path = [] }
            .buttonStyle(.clave(.secondary, size: .small))
            .accessibilityIdentifier("connection.unpaired")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ProgressView()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .accessibilityLabel("Reaching the machine")
          .accessibilityIdentifier("connection.loading")
      }
    }
    .background(theme.colors.surface0)
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(theme.colors.surface0, for: .navigationBar)
    .task(id: machineId) {
      answered = false
      connection = await model.connection(for: machineId)
      answered = true
    }
  }
}

/// The machine's state in words, with its dot; the reason under it when it is not reached.
struct MachineStateLine: View {
  let connection: MachineConnection

  @Environment(\.claveTheme) private var theme

  var body: some View {
    let state = Self.describe(connection.state)
    VStack(alignment: .leading, spacing: Theme.space(1.5)) {
      Text("Machine")
        .font(.geist(Theme.text.xs, weight: .regular, relativeTo: .caption))
        .foregroundStyle(theme.colors.textTertiary)
      HStack(spacing: Theme.space(1.5)) {
        StatusDot(state.status)
          .accessibilityHidden(true)
        Text(state.words)
          .font(.geist(Theme.text.sm, relativeTo: .body))
          .foregroundStyle(theme.colors.textPrimary)
          .accessibilityIdentifier("machine.state")
      }
      if let reason = state.reason {
        NoticeRow(text: reason, tone: state.isError ? .error : .warning)
          .accessibilityIdentifier("machine.state.reason")
      }
    }
    .padding(.vertical, Theme.space(1))
    .frame(minHeight: 44, alignment: .leading)
  }

  /// The words, the dot, and the reason a state shows.
  nonisolated static func describe(_ state: MachineConnection.State) -> (
    words: String, status: StatusKind, reason: String?, isError: Bool
  ) {
    switch state {
    case .connecting: ("Connecting", .waiting, nil, false)
    case .connected: ("Connected", .ready, nil, false)
    case .offline(let reason): ("Offline", .inactive, reason, false)
    case .unpaired(let reason): ("Unpaired", .inactive, reason, true)
    }
  }
}

/// A section's quiet uppercase title with its line of description under it.
struct SectionHeader: View {
  let title: String
  let description: String

  @Environment(\.claveTheme) private var theme

  init(_ title: String, description: String) {
    self.title = title
    self.description = description
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Theme.space(0.5)) {
      SectionTitle(title)
      Text(description)
        .font(.geist(Theme.text.xs, weight: .regular, relativeTo: .caption))
        .foregroundStyle(theme.colors.textSecondary)
        .textCase(nil)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

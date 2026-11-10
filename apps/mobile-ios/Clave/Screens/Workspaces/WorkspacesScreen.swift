import ClaveCore
import SwiftUI

/// A machine's workspaces: the folders registered on it, each opening its sessions; the
/// requests waiting for the person in the header.
struct WorkspacesScreen: View {
  let model: AppModel
  let machineId: String

  var body: some View {
    ConnectionView(model: model, machineId: machineId) { connection in
      WorkspacesContent(model: model, connection: connection)
    }
  }
}

private struct WorkspacesContent: View {
  let model: AppModel
  let connection: MachineConnection

  @Environment(\.claveTheme) private var theme

  var body: some View {
    VStack(spacing: 0) {
      PaneHeader(connection.name, subtitle: "Workspaces") {
        RequestsButton(count: connection.requests.count) {
          model.path.append(.requests(machineId: connection.machineId))
        }
      }
      List {
        Section {
          MachineStateLine(connection: connection)
          if let error = connection.lastError {
            NoticeRow(text: error, tone: .error)
              .accessibilityIdentifier("workspaces.error")
          }
        }
        .listRowBackground(theme.colors.surface50)
        Section {
          workspaceRows
        } header: {
          SectionHeader("Workspaces", description: "The folders registered on this machine.")
        }
        .listRowBackground(theme.colors.surface50)
      }
      .scrollContentBackground(.hidden)
      .listRowSeparatorTint(theme.colors.borderSubtle)
      .refreshable { await connection.reload() }
    }
  }

  @ViewBuilder
  private var workspaceRows: some View {
    if let workspaces = connection.workspaces?.workspaces {
      if workspaces.isEmpty {
        EmptyState(icon: .folder, title: "No workspace yet", text: "Add one on the Mac, in Settings → General → Workspaces.")
          .accessibilityIdentifier("workspaces.empty")
      }
      ForEach(workspaces) { workspace in
        Button {
          model.path.append(.sessions(machineId: connection.machineId, workspaceId: workspace.id))
        } label: {
          WorkspaceRow(workspace: workspace)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(workspace.name)
        .accessibilityHint(workspace.rootDir)
        .accessibilityIdentifier("workspaces.row.\(workspace.id)")
      }
    } else if connection.lastError == nil {
      ProgressView()
        .frame(maxWidth: .infinity, minHeight: 44)
        .accessibilityLabel("Reading the workspaces")
    }
  }
}

private struct WorkspaceRow: View {
  let workspace: WorkspaceView

  @Environment(\.claveTheme) private var theme

  var body: some View {
    HStack(spacing: Theme.space(3)) {
      Icon(.folder, size: 20)
        .foregroundStyle(theme.colors.textTertiary)
      VStack(alignment: .leading, spacing: Theme.space(0.5)) {
        Text(workspace.name)
          .font(.geist(Theme.text.sm, relativeTo: .body))
          .foregroundStyle(theme.colors.textPrimary)
          .lineLimit(1)
        Text(workspace.rootDir)
          .font(.geist(Theme.text.xs, weight: .regular, relativeTo: .caption))
          .foregroundStyle(theme.colors.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      Icon(.chevronRight, size: 14)
        .foregroundStyle(theme.colors.textTertiary)
    }
    .padding(.vertical, Theme.space(1))
    .frame(minHeight: 44)
    .contentShape(Rectangle())
  }
}

/// The inbox in the header: the glyph, and the count beside it when something waits.
private struct RequestsButton: View {
  let count: Int
  let open: () -> Void

  @Environment(\.claveTheme) private var theme

  var body: some View {
    HStack(spacing: Theme.space(1)) {
      Button(action: open) {
        Icon(.inboxStack, size: Theme.control.icon)
          .frame(minWidth: 44, minHeight: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(theme.colors.textSecondary)
      .accessibilityLabel("Requests, \(count) pending")
      .accessibilityIdentifier("workspaces.requests")
      if count > 0 {
        // Beside the button rather than in it, so the count is an element of its own; a tap on
        // it opens the requests all the same, on a target of at least 44 points.
        Button(action: open) {
          Chip("\(count)")
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(count)")
        .accessibilityIdentifier("workspaces.requests.badge")
      }
    }
  }
}

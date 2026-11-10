import ClaveCore
import SwiftUI

/// One row of a workspace's sessions, as the screen shows it.
nonisolated struct SessionListingRow: Equatable, Sendable, Identifiable {
  let id: String
  let title: String
  let description: String
  let state: PhoneSessionState
  let status: SessionStatus
  /// A chat opens on the phone; a terminal is read on the Mac.
  let isChat: Bool

  /// The rows of a workspace, in the core's order (chats first, then terminals, newest first; an
  /// unstamped session in every workspace).
  static func rows(in workspace: WorkspaceView, of all: [Session], workspaces: [WorkspaceView]) -> [SessionListingRow] {
    sessions(in: workspace, of: all, workspaces: workspaces).map(SessionListingRow.init)
  }

  init(_ session: Session) {
    let folder = (session.cwd as NSString).lastPathComponent
    let chat = session.transport == .events
    id = session.id
    title = session.title.isEmpty ? folder : session.title
    description = chat ? "\(session.provider) · \(folder)" : "Terminal · \(folder) · read-only on the phone"
    state = PhoneSessionState(session.state)
    status = state.status
    isChat = chat
  }
}

/// A workspace's sessions: its chats, which open here, and its terminals, read on the Mac.
struct SessionsScreen: View {
  let model: AppModel
  let machineId: String
  let workspaceId: String

  var body: some View {
    ConnectionView(model: model, machineId: machineId) { connection in
      SessionsContent(model: model, connection: connection, workspaceId: workspaceId)
    }
  }
}

private struct SessionsContent: View {
  let model: AppModel
  let connection: MachineConnection
  let workspaceId: String

  @Environment(\.claveTheme) private var theme
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  private var workspace: WorkspaceView? {
    connection.workspaces?.workspaces.first { $0.id == workspaceId }
  }

  var body: some View {
    VStack(spacing: 0) {
      PaneHeader(workspace?.name ?? "Sessions", subtitle: connection.name) {
        Button(action: newSession) {
          Icon(.plus, size: Theme.control.icon)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(theme.colors.textSecondary)
        .accessibilityLabel("New session")
        .accessibilityIdentifier("sessions.new")
      }
      List {
        Section {
          MachineStateLine(connection: connection)
          if let error = connection.lastError {
            NoticeRow(text: error, tone: .error)
              .accessibilityIdentifier("sessions.error")
          }
        }
        .listRowBackground(theme.colors.surface50)
        Section {
          rows
        } header: {
          SectionHeader("Sessions", description: "Chats open on the phone; terminals are read on the Mac.")
        }
        .listRowBackground(theme.colors.surface50)
      }
      .scrollContentBackground(.hidden)
      .listRowSeparatorTint(theme.colors.borderSubtle)
      .refreshable { await connection.reloadSessions() }
      // As on Machines: a list's rows kept the text size they were drawn at when the setting
      // changed (iOS 17.5 here, the rows after the first); the list is drawn anew for a new size.
      .id(dynamicTypeSize)
    }
    // The list may have changed on the Mac since the workspace was opened.
    .task { await connection.reloadSessions() }
  }

  @ViewBuilder
  private var rows: some View {
    if let workspace {
      let listed = SessionListingRow.rows(
        in: workspace, of: connection.sessions, workspaces: connection.workspaces?.workspaces ?? [])
      if listed.isEmpty {
        VStack(spacing: Theme.space(2)) {
          EmptyState(icon: .chatBubbleLeftRight, title: "No session in \(workspace.name) yet", text: "Start one from a saved profile.")
          Button("New session", action: newSession)
            .buttonStyle(.clave(.primary, size: .small))
            .accessibilityIdentifier("sessions.empty.new")
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sessions.empty")
      }
      ForEach(listed) { row in
        SessionRowView(row: row) {
          model.path.append(.chat(machineId: connection.machineId, sessionId: row.id))
        }
      }
    } else if connection.workspaces == nil, connection.lastError == nil {
      ProgressView()
        .frame(maxWidth: .infinity, minHeight: 44)
        .accessibilityLabel("Reading the sessions")
    } else {
      EmptyState(icon: .folder, title: "This workspace is not on the machine any more.")
        .accessibilityIdentifier("sessions.missing")
    }
  }

  private func newSession() {
    model.path.append(.launch(machineId: connection.machineId, workspaceId: workspaceId))
  }
}

private struct SessionRowView: View {
  let row: SessionListingRow
  let open: () -> Void

  @Environment(\.claveTheme) private var theme

  var body: some View {
    HStack(spacing: Theme.space(3)) {
      if row.isChat {
        Button(action: open) { summary }
          .buttonStyle(.plain)
          .accessibilityLabel(row.title)
          .accessibilityHint(row.description)
          .accessibilityIdentifier("sessions.row.\(row.id)")
      } else {
        summary
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("sessions.row.\(row.id)")
      }
      // Beside the button so the state is an element of its own; on a chat, a tap on it opens the
      // chat too. Either way it stands on at least 44 points.
      if row.isChat {
        Button(action: open) {
          stateWord
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("sessions.state.\(row.id)")
      } else {
        stateWord
          .minimumAccessibilityTarget()
          .accessibilityIdentifier("sessions.state.\(row.id)")
      }
      if row.isChat {
        Icon(.chevronRight, size: 14)
          .foregroundStyle(theme.colors.textTertiary)
          .onTapGesture(perform: open)
          .accessibilityHidden(true)
      }
    }
    .padding(.vertical, Theme.space(1))
    .frame(minHeight: 44)
  }

  /// The state in its word, in a text ink: the row's StatusDot carries the state's ink.
  private var stateWord: some View {
    Text(row.state.label)
      .font(.geist(Theme.text.xs, relativeTo: .caption))
      .foregroundStyle(theme.colors.textSecondary)
      .lineLimit(1)
  }

  private var summary: some View {
    HStack(spacing: Theme.space(3)) {
      StatusDot(StatusKind(row.status))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Theme.space(0.5)) {
        Text(row.title)
          .font(.geist(Theme.text.sm, relativeTo: .body))
          .foregroundStyle(theme.colors.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
        Text(row.description)
          .font(.geist(Theme.text.xs, weight: .regular, relativeTo: .caption))
          .foregroundStyle(theme.colors.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(minHeight: 44)
    .contentShape(Rectangle())
  }
}

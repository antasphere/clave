import ClaveCore
import SwiftUI

/// Starting a session in a workspace from a saved profile: the profiles of the person's main
/// machine when it is reached, else the target's own.
struct LaunchScreen: View {
  let model: AppModel
  let machineId: String
  let workspaceId: String

  var body: some View {
    ConnectionView(model: model, machineId: machineId) { target in
      LaunchContent(model: model, target: target, workspaceId: workspaceId)
    }
  }
}

private struct LaunchContent: View {
  let model: AppModel
  let target: MachineConnection
  let workspaceId: String

  @Environment(\.claveTheme) private var theme
  @State private var launch: LaunchModel?

  private var workspace: WorkspaceView? {
    target.workspaces?.workspaces.first { $0.id == workspaceId }
  }

  var body: some View {
    VStack(spacing: 0) {
      PaneHeader("Start a session", subtitle: workspace.map { "in \($0.name)" })
      List {
        if let launch {
          content(launch)
        } else if workspace == nil, target.workspaces != nil {
          EmptyState(icon: .folder, title: "This workspace is not on the machine any more.")
            .accessibilityIdentifier("launch.missing")
            .listRowBackground(theme.colors.surface50)
        } else {
          ProgressView()
            .frame(maxWidth: .infinity, minHeight: 44)
            .listRowBackground(theme.colors.surface50)
        }
      }
      .scrollContentBackground(.hidden)
      .listRowSeparatorTint(theme.colors.borderSubtle)
      .refreshable { await launch?.load() }
    }
    .task(id: workspace?.id) {
      guard launch == nil, let workspace else { return }
      let source = await sourceConnection()
      let made = LaunchModel(target: target, source: source, workspace: workspace)
      launch = made
      await made.load()
    }
  }

  /// The person's main machine when it is paired and reached, else the target itself.
  private func sourceConnection() async -> MachineConnection {
    guard let machines = model.machines,
      let mainId = (try? await machines.credentials.mainMachineId()) ?? nil,
      mainId != target.machineId,
      let main = await model.connection(for: mainId)
    else { return target }
    return main
  }

  @ViewBuilder
  private func content(_ launch: LaunchModel) -> some View {
    if let refusal = launch.refusal {
      Section {
        NoticeRow(text: refusal, tone: .error)
          .accessibilityIdentifier("launch.refusal")
      }
      .listRowBackground(theme.colors.surface50)
    }
    Section {
      if let error = launch.loadError {
        NoticeRow(text: error, tone: .error)
          .accessibilityIdentifier("launch.error")
      } else if !launch.loaded {
        ProgressView()
          .frame(maxWidth: .infinity, minHeight: 44)
          .accessibilityLabel("Reading the saved profiles")
      } else if launch.profiles.isEmpty {
        EmptyState(icon: .bookOpen, title: "No saved profile", text: "Save one on \(launch.source.name), in Settings → Agents.")
          .accessibilityIdentifier("launch.empty")
      }
      ForEach(launch.profiles) { profile in
        Button {
          Task { await start(profile, launch) }
        } label: {
          ProfileRow(profile: profile, starting: launch.starting == profile.id)
        }
        .buttonStyle(.plain)
        .disabled(launch.starting != nil)
        .accessibilityLabel(profile.name)
        .accessibilityHint(ProfileRow.description(profile))
        .accessibilityIdentifier("launch.profile.\(profile.id)")
      }
    } header: {
      SectionHeader(
        "Saved profiles",
        description: "Runs on \(target.name)"
          + (launch.sourceDiffers ? " · profiles of \(launch.source.name)" : " · its own saved profiles"))
    }
    .listRowBackground(theme.colors.surface50)
  }

  private func start(_ profile: LaunchProfileView, _ launch: LaunchModel) async {
    guard let session = await launch.start(profile) else { return }
    model.path = LaunchModel.path(afterStarting: session.id, machineId: target.machineId, from: model.path)
  }
}

private struct ProfileRow: View {
  let profile: LaunchProfileView
  let starting: Bool

  @Environment(\.claveTheme) private var theme

  var body: some View {
    HStack(spacing: Theme.space(3)) {
      mark
      VStack(alignment: .leading, spacing: Theme.space(0.5)) {
        Text(profile.name)
          .font(.geist(Theme.text.sm, relativeTo: .body))
          .foregroundStyle(theme.colors.textPrimary)
          .lineLimit(1)
        Text(Self.description(profile))
          .font(.geist(Theme.text.xs, weight: .regular, relativeTo: .caption))
          .foregroundStyle(theme.colors.textSecondary)
          .lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if isChatProfile(profile) { Chip("Chat") }
      if starting {
        ProgressView().accessibilityLabel("Starting")
      }
    }
    .padding(.vertical, Theme.space(1))
    .frame(minHeight: 44)
    .contentShape(Rectangle())
  }

  /// The family's mark, as the desktop draws it (the prototype's launch-family.ts).
  @ViewBuilder
  private var mark: some View {
    switch profile.family {
    case .claude: Icon(.logoClaude, size: 20).foregroundStyle(theme.colors.brandClaude)
    case .codex: Icon(.logoCodex, size: 20).foregroundStyle(theme.colors.textSecondary)
    case .pi: Icon(.logoPi, size: 20).foregroundStyle(theme.colors.textSecondary)
    case .antigravity: Icon(.logoAntigravity, size: 20).foregroundStyle(theme.colors.textSecondary)
    }
  }

  nonisolated static func description(_ profile: LaunchProfileView) -> String {
    [profile.family.rawValue, isChatProfile(profile) ? "chat" : "terminal", profile.command.joined(separator: " ")]
      .filter { !$0.isEmpty }
      .joined(separator: " · ")
  }
}

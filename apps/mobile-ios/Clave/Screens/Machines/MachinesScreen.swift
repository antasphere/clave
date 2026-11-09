import ClaveCore
import SwiftUI

/// The first screen: the account, the relay the machines are listed by, the
/// machines with their pairing, and in a development build the developer
/// connection at its foot.
struct MachinesScreen: View {
  let model: AppModel

  @Environment(\.claveTheme) private var theme
  @State private var relayText = ""
  @State private var relayEdited = false

  var body: some View {
    VStack(spacing: 0) {
      PaneHeader("Machines", subtitle: "A Mac running Clave, paired with this phone.") {
        Button {
          model.path.append(.appearance)
        } label: {
          Icon(.paintBrush, size: Theme.control.icon)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(theme.colors.textSecondary)
        .accessibilityLabel("Appearance")
        .accessibilityIdentifier("machines.appearance")
      }
      List {
        if let notice = model.notice {
          Section {
            NoticeRow(text: notice, tone: .warning)
          }
          .listRowBackground(theme.colors.surface50)
        }
        accountSection
        if let machines = model.machines {
          relaySection(machines)
          machinesSection(machines)
          #if DEBUG
            if model.environment.offersDeveloperConnection {
              DeveloperConnectionSection(machines: machines)
            }
          #endif
        }
      }
      .scrollContentBackground(.hidden)
      .listRowSeparatorTint(theme.colors.borderSubtle)
      .refreshable { await model.machines?.refresh() }
    }
    .background(theme.colors.surface0)
    .toolbar(.hidden, for: .navigationBar)
    .task(id: model.machines?.namespace) {
      guard let machines = model.machines else { return }
      await machines.load()
      if !relayEdited { relayText = machines.relayURL }
    }
  }

  // MARK: account

  private var accountSection: some View {
    Section {
      let account = model.account
      switch account.phase {
      case .signingIn where !account.isSignedIn:
        HStack(spacing: Theme.space(3)) {
          ProgressView()
          Text("Signing in with Antasphere…")
            .font(.geist(Theme.text.sm, relativeTo: .body))
            .foregroundStyle(theme.colors.textSecondary)
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("machines.signingin")
      default:
        if let person = account.person {
          HStack(spacing: Theme.space(3)) {
            Icon(.userCircle, size: 24).foregroundStyle(theme.colors.textTertiary)
            VStack(alignment: .leading, spacing: Theme.space(0.5)) {
              Text(person.name ?? person.email ?? "Your Antasphere account")
                .font(.geist(Theme.text.sm, relativeTo: .body))
                .foregroundStyle(theme.colors.textPrimary)
                .accessibilityIdentifier("machines.account.name")
              if let email = person.email, person.name != nil {
                Text(email)
                  .font(.geist(Theme.text.xs, weight: .regular, relativeTo: .caption))
                  .foregroundStyle(theme.colors.textSecondary)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button("Sign out") { Task { await model.account.signOut() } }
              .buttonStyle(.clave(.secondary, size: .small))
              .accessibilityIdentifier("machines.signout")
          }
        } else {
          VStack(alignment: .leading, spacing: Theme.space(3)) {
            Text("Sign in with your Antasphere account to see your machines.")
              .font(.geist(Theme.text.sm, relativeTo: .body))
              .foregroundStyle(theme.colors.textSecondary)
            Button("Sign in with Antasphere") { Task { await model.account.signIn() } }
              .buttonStyle(.clave(.primary))
              .accessibilityIdentifier("machines.signin")
          }
          .padding(.vertical, Theme.space(1))
        }
      }
      if let failure = model.account.failureSentence {
        NoticeRow(text: failure, tone: .error)
          .accessibilityIdentifier("machines.account.failure")
      }
    } header: {
      SectionTitle("Account")
    }
    .listRowBackground(theme.colors.surface50)
  }

  // MARK: relay

  private func relaySection(_ machines: MachinesModel) -> some View {
    Section {
      VStack(alignment: .leading, spacing: Theme.space(2)) {
        ClaveField(
          "https://your-team-relay.example",
          text: Binding(
            get: { relayText },
            set: {
              relayText = $0
              relayEdited = true
            }),
          label: "Team relay address"
        )
        .keyboardType(.URL)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.done)
        .onSubmit { save(machines) }
        .accessibilityIdentifier("machines.relay.field")
        HStack {
          if let refusal = machines.relayRefusal {
            Text(refusal)
              .font(.geist(Theme.text.xs, weight: .regular, relativeTo: .caption))
              .foregroundStyle(theme.colors.destructive)
              .accessibilityIdentifier("machines.relay.refusal")
          }
          Spacer(minLength: 0)
          Button("Save") { save(machines) }
            .buttonStyle(.clave(.secondary, size: .small))
            .accessibilityLabel("Save the relay address")
            .accessibilityIdentifier("machines.relay.save")
        }
      }
      .padding(.vertical, Theme.space(1))
    } header: {
      SectionTitle("Team relay")
    }
    .listRowBackground(theme.colors.surface50)
  }

  private func save(_ machines: MachinesModel) {
    let text = relayText
    Task {
      if await machines.saveRelay(text) { relayEdited = false }
    }
  }

  // MARK: machines

  private func machinesSection(_ machines: MachinesModel) -> some View {
    Section {
      if let error = machines.listError {
        NoticeRow(text: error, tone: .error)
          .accessibilityIdentifier("machines.list.error")
        if machines.needsSignIn {
          Button("Sign in again") { Task { await model.account.signIn() } }
            .buttonStyle(.clave(.primary, size: .small))
            .accessibilityIdentifier("machines.signin.again")
        }
      }
      if machines.rows.isEmpty {
        EmptyState(
          icon: .computerDesktop, title: machines.isLoading ? "Looking for machines…" : "No machine yet",
          text: machines.relayURL.isEmpty
            ? "Enter your team's relay address to list your machines."
            : "Sign in to Clave on your Mac with the same account, then pull to refresh.")
          .accessibilityIdentifier("machines.empty")
      }
      ForEach(machines.rows) { row in
        MachineRowView(
          row: row, isMain: machines.mainMachineId == row.id,
          pair: { model.path.append(.pairing(machineId: row.id)) },
          open: { model.open(machineId: row.id) }
        )
        .swipeActions(edge: .trailing) {
          if row.paired {
            Button("Forget", role: .destructive) { Task { await machines.forget(row.id) } }
              .accessibilityIdentifier("machines.forget.\(row.id)")
          }
        }
      }
    } header: {
      SectionTitle("Your machines")
    }
    .listRowBackground(theme.colors.surface50)
  }
}

/// One machine: its name, its platform and version, whether it is online,
/// and pairing or opening it.
private struct MachineRowView: View {
  let row: MachineRow
  let isMain: Bool
  let pair: () -> Void
  let open: () -> Void

  @Environment(\.claveTheme) private var theme

  var body: some View {
    HStack(spacing: Theme.space(3)) {
      Icon(row.isDeveloper ? .serverStack : .computerDesktop, size: 20)
        .foregroundStyle(theme.colors.textTertiary)
      VStack(alignment: .leading, spacing: Theme.space(0.5)) {
        Text(row.machine.name)
          .font(.geist(Theme.text.sm, relativeTo: .body))
          .foregroundStyle(theme.colors.textPrimary)
          .lineLimit(1)
        HStack(spacing: Theme.space(1.5)) {
          StatusDot(row.online ? .ready : .inactive)
            .accessibilityHidden(true)
          Text(row.online ? "Online" : "Offline")
            .accessibilityIdentifier("machines.online.\(row.id)")
          if !detail.isEmpty { Text(detail).lineLimit(1) }
        }
        .font(.geist(Theme.text.xs, weight: .regular, relativeTo: .caption))
        .foregroundStyle(theme.colors.textSecondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)
      if row.paired {
        Chip(isMain ? "Paired, main" : "Paired", icon: .check)
          .accessibilityIdentifier("machines.paired.\(row.id)")
        Button("Open", action: open)
          .buttonStyle(.clave(.primary, size: .small))
          .accessibilityLabel("Open \(row.machine.name)")
          .accessibilityIdentifier("machines.open.\(row.id)")
      } else {
        Button("Pair", action: pair)
          .buttonStyle(.clave(.secondary, size: .small))
          .disabled(!row.online)
          .accessibilityLabel("Pair with \(row.machine.name)")
          .accessibilityIdentifier("machines.pair.\(row.id)")
      }
    }
    .padding(.vertical, Theme.space(1))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("machines.row.\(row.id)")
  }

  private var detail: String {
    let platform: String
    switch row.machine.platform {
    case .macos: platform = "macOS"
    case .linux: platform = "Linux"
    case .unknown: platform = row.isDeveloper ? "Clave server" : ""
    }
    return [platform, row.machine.version.isEmpty ? "" : "Clave \(row.machine.version)"]
      .filter { !$0.isEmpty }.joined(separator: " · ")
  }
}

/// A sentence in a list row: a failure, a refusal, or a fallback reason.
struct NoticeRow: View {
  enum Tone { case error, warning }
  let text: String
  let tone: Tone

  @Environment(\.claveTheme) private var theme

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Theme.space(2)) {
      Icon(.exclamationTriangle, size: 14)
        .foregroundStyle(tone == .error ? theme.colors.destructive : theme.colors.warning)
      Text(text)
        .font(.geist(Theme.text.xs, weight: .regular, relativeTo: .caption))
        .foregroundStyle(theme.colors.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .combine)
  }
}

#if DEBUG
  /// A standalone server by its address and token, for a development build.
  private struct DeveloperConnectionSection: View {
    let machines: MachinesModel

    @Environment(\.claveTheme) private var theme
    @State private var url = ""
    @State private var token = ""

    var body: some View {
      Section {
        VStack(alignment: .leading, spacing: Theme.space(2)) {
          Text("A standalone server on this Mac or network, by address and token. This build only.")
            .font(.geist(Theme.text.xs, weight: .regular, relativeTo: .caption))
            .foregroundStyle(theme.colors.textSecondary)
          ClaveField("http://127.0.0.1:43201", text: $url, label: "Server address")
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityIdentifier("developer.url")
          SecureField("Server token", text: $token, prompt: Text("Token").foregroundStyle(theme.colors.textTertiary))
            .font(.geist(Theme.field.text, relativeTo: .body))
            .foregroundStyle(theme.colors.textPrimary)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(.horizontal, Theme.field.px)
            .frame(minHeight: max(Theme.field.h, 44))
            .background(RoundedRectangle(cornerRadius: Theme.field.radius).fill(theme.colors.surface50))
            .overlay(RoundedRectangle(cornerRadius: Theme.field.radius).strokeBorder(theme.colors.border, lineWidth: 1))
            .accessibilityLabel("Server token")
            .accessibilityIdentifier("developer.token")
          HStack {
            if let error = machines.developerError {
              Text(error)
                .font(.geist(Theme.text.xs, weight: .regular, relativeTo: .caption))
                .foregroundStyle(theme.colors.destructive)
            }
            Spacer(minLength: 0)
            Button("Add") {
              let address = url
              let secret = token
              Task {
                if await machines.addDeveloperServer(url: address, token: secret) {
                  url = ""
                  token = ""
                }
              }
            }
            .buttonStyle(.clave(.secondary, size: .small))
            .accessibilityLabel("Add the developer server")
            .accessibilityIdentifier("developer.add")
          }
        }
        .padding(.vertical, Theme.space(1))
      } header: {
        SectionTitle("Developer connection")
      }
      .listRowBackground(theme.colors.surface50)
    }
  }
#endif

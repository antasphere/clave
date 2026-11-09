import ClaveCore
import SwiftUI

/// Pairing this phone with one machine: the ask, the wait for the owner's
/// word on the Mac, and where it ended.
struct PairingScreen: View {
  let model: AppModel
  let machineId: String

  @Environment(\.claveTheme) private var theme
  @State private var attempt = 0

  private var machines: MachinesModel? { model.machines }
  private var row: MachineRow? { machines?.row(machineId) }
  private var state: PairingState? {
    machines?.pairingMachineId == machineId ? machines?.pairingState : nil
  }

  var body: some View {
    ScrollView {
      VStack(spacing: Theme.space(5)) {
        VStack(spacing: Theme.space(1)) {
          Icon(.shieldCheck, size: 28).foregroundStyle(theme.colors.textTertiary)
          Text(row?.machine.name ?? "This machine")
            .font(.geist(Theme.text.lg, weight: .semibold, relativeTo: .title3))
            .foregroundStyle(theme.colors.textPrimary)
            .multilineTextAlignment(.center)
        }
        TimelineView(.periodic(from: .now, by: 1)) { context in
          VStack(spacing: Theme.space(3)) {
            if state.map({ !$0.isFinal }) ?? true { ProgressView() }
            Text(sentence(now: context.date))
              .font(.geist(Theme.text.sm, relativeTo: .body))
              .foregroundStyle(theme.colors.textPrimary)
              .multilineTextAlignment(.center)
              .fixedSize(horizontal: false, vertical: true)
              .accessibilityIdentifier("pairing.state")
          }
        }
        actions
      }
      .padding(Theme.gutter)
      .padding(.top, Theme.space(6))
      .frame(maxWidth: .infinity)
    }
    .background(theme.colors.surface0)
    .navigationTitle("Pair this phone")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: attempt) { start() }
    .onDisappear {
      if let state, !state.isFinal { machines?.cancelPairing() }
    }
  }

  @ViewBuilder
  private var actions: some View {
    switch state {
    case .approved?:
      Button("Continue to workspaces") { model.continueAfterPairing(machineId: machineId) }
        .buttonStyle(.clave(.primary))
        .accessibilityIdentifier("pairing.continue")
    case .refused?, .expired?, .failed?, .cancelled?:
      Button("Try again") { attempt += 1 }
        .buttonStyle(.clave(.secondary))
        .accessibilityIdentifier("pairing.retry")
    case nil, .requesting?, .waiting?:
      Button("Cancel") {
        machines?.cancelPairing()
        if case .pairing? = model.path.last { model.path.removeLast() }
      }
      .buttonStyle(.clave(.secondary))
      .accessibilityLabel("Cancel the pairing")
      .accessibilityIdentifier("pairing.cancel")
    }
  }

  private func start() {
    guard let machines else { return }
    // Coming back to a pairing already under way (or done) keeps it.
    if attempt == 0, machines.pairingMachineId == machineId, machines.pairingState != nil,
      machines.pairingState?.isFinal == false || isApproved
    { return }
    guard let machine = machines.row(machineId)?.machine else { return }
    machines.pair(machine)
  }

  private var isApproved: Bool {
    if case .approved? = state { return true }
    return false
  }

  private func sentence(now: Date) -> String {
    guard machines?.row(machineId) != nil || state != nil else {
      return "This machine is not listed any more. Go back to Machines and refresh."
    }
    switch state {
    case nil, .requesting?:
      return "Asking \(row?.machine.name ?? "the machine") to pair with this phone…"
    case .waiting(_, let expiresAt, _)?:
      return "Approve this phone on your Mac in Settings, Mobile. \(Self.timeLeft(until: expiresAt, now: now))"
    case .approved(let record)?:
      return "Paired with \(record.serverName.isEmpty ? (row?.machine.name ?? "the machine") : record.serverName)."
    case .refused?:
      return "The owner refused this pairing on the Mac."
    case .expired?:
      return "The pairing expired. Ask again when your Mac is at hand."
    case .cancelled?:
      return "The pairing was cancelled."
    case .failed(let error)?:
      if let check = error.check { return "The machine refused the sign-in by its \(check) check. \(error.message)" }
      return error.message
    }
  }

  nonisolated static func timeLeft(until expiresAt: Double, now: Date) -> String {
    let seconds = max(0, Int((expiresAt - now.timeIntervalSince1970 * 1000) / 1000))
    if seconds == 0 { return "The time to approve is up." }
    let minutes = seconds / 60
    let rest = seconds % 60
    return minutes > 0 ? "\(minutes) min \(rest) s left." : "\(rest) s left."
  }
}

import SwiftUI

/// The session states the sidebar's dot tells apart.
nonisolated enum AgentState: String, CaseIterable, Sendable {
  case working, ready, waiting, inactive

  var label: String {
    switch self {
    case .working: "Working"
    case .ready: "Ready"
    case .waiting: "Waiting for you"
    case .inactive: "Inactive"
    }
  }
}

/// `.pane-status-dot`: a session's state in the shared status inks. Working
/// breathes as it does on the desktop, unless the person asked for less motion.
struct StatusDot: View {
  let state: AgentState
  var size: CGFloat = 8

  @Environment(\.claveTheme) private var theme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var dimmed = false

  init(_ state: AgentState, size: CGFloat = 8) {
    self.state = state
    self.size = size
  }

  private var pulses: Bool { state == .working && !reduceMotion }

  var body: some View {
    Circle()
      .fill(color)
      .frame(width: size, height: size)
      .opacity(pulses && dimmed ? 0.4 : 1)
      .animation(pulses ? .easeInOut(duration: 1.25).repeatForever(autoreverses: true) : .default, value: dimmed)
      .onAppear { dimmed = pulses }
      .onChange(of: pulses) { _, now in dimmed = now }
      .accessibilityElement()
      .accessibilityLabel(state.label)
  }

  private var color: Color {
    switch state {
    case .working: theme.colors.statusWorking
    case .ready: theme.colors.statusReady
    case .waiting: theme.colors.statusWaiting
    case .inactive: theme.colors.statusInactive
    }
  }
}

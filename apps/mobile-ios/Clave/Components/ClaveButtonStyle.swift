import SwiftUI

/// `.btn-primary` (the verb in the action ink), `.btn-secondary` (the neutral
/// partner) and a destructive variant, sized by the control spec. The visible
/// box keeps the desktop's proportions while the tappable area never drops
/// under the 44pt the platform asks for.
struct ClaveButtonStyle: ButtonStyle {
  enum Role: Sendable { case primary, secondary, destructive }
  enum Size: Sendable { case regular, small }

  var role: Role = .primary
  var size: Size = .regular

  @Environment(\.claveTheme) private var theme
  @Environment(\.isEnabled) private var isEnabled

  private var spec: Theme.ControlMetrics { size == .regular ? Theme.control : Theme.controlSm }

  func makeBody(configuration: Configuration) -> some View {
    let shape = RoundedRectangle(cornerRadius: spec.radius, style: .continuous)
    HStack(spacing: spec.gap) {
      configuration.label
    }
    .font(.geist(spec.text, relativeTo: size == .regular ? .callout : .footnote))
    .lineLimit(1)
    .foregroundStyle(foreground)
    // The desktop's text buttons pad in multiples of the control's side: x2 primary, x1.5 the rest.
    .padding(.horizontal, spec.px * (role == .primary ? 2 : 1.5))
    .padding(.vertical, Theme.space(1))
    .frame(minHeight: spec.h)
    .background(shape.fill(background))
    .overlay {
      if role != .primary { shape.strokeBorder(theme.colors.border, lineWidth: 1) }
    }
    .frame(minHeight: 44)
    .contentShape(Rectangle())
    .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.4)
  }

  private var foreground: Color {
    switch role {
    case .primary: theme.colors.actionForeground
    case .secondary: theme.colors.textPrimary
    case .destructive: theme.colors.destructive
    }
  }

  private var background: Color {
    switch role {
    case .primary: theme.colors.action
    case .secondary, .destructive: theme.colors.surface100
    }
  }
}

extension ButtonStyle where Self == ClaveButtonStyle {
  static func clave(_ role: ClaveButtonStyle.Role = .primary, size: ClaveButtonStyle.Size = .regular) -> ClaveButtonStyle {
    ClaveButtonStyle(role: role, size: size)
  }
}

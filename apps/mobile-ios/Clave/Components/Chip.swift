import SwiftUI

/// A small label on the surface-200 fill: a count, a provider, a branch.
struct Chip: View {
  let title: String
  var icon: IconName?

  @Environment(\.claveTheme) private var theme
  @ScaledMetric(relativeTo: .caption2) private var iconSize: CGFloat = 10

  init(_ title: String, icon: IconName? = nil) {
    self.title = title
    self.icon = icon
  }

  var body: some View {
    HStack(spacing: Theme.space(1)) {
      if let icon { Icon(icon, size: iconSize) }
      Text(title)
        .font(.geist(Theme.text.badge, relativeTo: .caption2))
        .lineLimit(1)
    }
    .foregroundStyle(theme.colors.textSecondary)
    .padding(.horizontal, Theme.space(1.5))
    .padding(.vertical, Theme.space(0.5))
    .background(
      RoundedRectangle(cornerRadius: Theme.radius.md, style: .continuous)
        .fill(theme.colors.surface200)
    )
    .accessibilityElement(children: .combine)
  }
}

extension View {
  /// A small element that informs rather than acts, kept as drawn on an element frame of at least
  /// 44 by 44 points, so a finger and VoiceOver's cursor find it.
  func minimumAccessibilityTarget() -> some View {
    frame(minWidth: 44, minHeight: 44)
      .contentShape(.accessibility, Rectangle())
      .accessibilityElement(children: .combine)
  }
}

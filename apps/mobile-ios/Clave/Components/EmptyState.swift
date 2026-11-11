import SwiftUI

/// `.chat-empty`: the icon on its tile, a title, a line under it.
struct EmptyState: View {
  let icon: IconName
  let title: String
  var text: String?

  @Environment(\.claveTheme) private var theme
  @ScaledMetric(relativeTo: .title) private var tile: CGFloat = 44
  @ScaledMetric(relativeTo: .title) private var glyph: CGFloat = 22

  init(icon: IconName, title: String, text: String? = nil) {
    self.icon = icon
    self.title = title
    self.text = text
  }

  var body: some View {
    VStack(spacing: Theme.space(3)) {
      Icon(icon, size: glyph)
        .foregroundStyle(theme.colors.textTertiary)
        .frame(width: tile, height: tile)
        .background(
          RoundedRectangle(cornerRadius: Theme.radius.xl, style: .continuous)
            .fill(theme.colors.surface100)
        )
      VStack(spacing: Theme.space(0.5)) {
        Text(title)
          .font(.geist(Theme.text.sm, relativeTo: .subheadline))
          .foregroundStyle(theme.colors.textPrimary)
        if let text {
          Text(text)
            .font(.geist(Theme.text.xs, weight: .regular, relativeTo: .caption))
            .foregroundStyle(theme.colors.textTertiary)
        }
      }
      .multilineTextAlignment(.center)
    }
    .padding(Theme.space(6))
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
  }
}

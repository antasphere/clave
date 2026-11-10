import SwiftUI

/// The quiet uppercase label over a group of rows.
struct SectionTitle: View {
  let title: String

  @Environment(\.claveTheme) private var theme

  init(_ title: String) {
    self.title = title
  }

  var body: some View {
    Text(title)
      // Along caption, not caption2: caption2 keeps one size at every setting below the default,
      // so its text did not follow those settings.
      .font(.geist(Theme.text.meta, relativeTo: .caption))
      .textCase(.uppercase)
      .tracking(0.6)
      .foregroundStyle(theme.colors.textTertiary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityAddTraits(.isHeader)
  }
}

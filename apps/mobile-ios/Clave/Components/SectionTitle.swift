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
      .font(.geist(Theme.text.meta, relativeTo: .caption2))
      .textCase(.uppercase)
      .tracking(0.6)
      .foregroundStyle(theme.colors.textTertiary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityAddTraits(.isHeader)
  }
}

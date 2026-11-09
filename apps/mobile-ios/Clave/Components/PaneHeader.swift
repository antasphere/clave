import SwiftUI

/// `.pane-header`: the one row at the top of every pane on the desktop, and of
/// every screen here: an optional status dot, the title, a quiet line under it,
/// and the pane's own controls on the right.
struct PaneHeader<Trailing: View>: View {
  let title: String
  var subtitle: String?
  var status: StatusKind?
  @ViewBuilder var trailing: Trailing

  @Environment(\.claveTheme) private var theme

  init(_ title: String, subtitle: String? = nil, status: StatusKind? = nil, @ViewBuilder trailing: () -> Trailing) {
    self.title = title
    self.subtitle = subtitle
    self.status = status
    self.trailing = trailing()
  }

  var body: some View {
    HStack(alignment: .center, spacing: Theme.space(2)) {
      if let status { StatusDot(status) }
      VStack(alignment: .leading, spacing: Theme.space(0.5)) {
        Text(title)
          .font(.geist(Theme.text.lg, weight: .semibold, relativeTo: .title3))
          .foregroundStyle(theme.colors.textPrimary)
          .lineLimit(1)
          .accessibilityAddTraits(.isHeader)
          .accessibilityIdentifier("pane.title")
        if let subtitle {
          Text(subtitle)
            .font(.geist(Theme.text.sm, relativeTo: .subheadline))
            .foregroundStyle(theme.colors.textSecondary)
            .lineLimit(2)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      trailing
    }
    .padding(.horizontal, Theme.gutter)
    .padding(.vertical, Theme.space(2))
    .frame(minHeight: Theme.control.h + Theme.space(2))
    .background(theme.colors.surface0)
    .overlay(alignment: .bottom) {
      Rectangle().fill(theme.colors.borderSubtle).frame(height: 1)
    }
  }
}

extension PaneHeader where Trailing == EmptyView {
  init(_ title: String, subtitle: String? = nil, status: StatusKind? = nil) {
    self.init(title, subtitle: subtitle, status: status) { EmptyView() }
  }
}

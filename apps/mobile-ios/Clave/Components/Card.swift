import SwiftUI

/// A raised box with the hairline border: settings groups, a machine, a summary.
struct Card<Content: View>: View {
  @ViewBuilder var content: Content

  @Environment(\.claveTheme) private var theme

  init(@ViewBuilder content: () -> Content) {
    self.content = content()
  }

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: Theme.radius.lg, style: .continuous)
    content
      .padding(Theme.space(3))
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(shape.fill(theme.colors.surfaceRaised))
      .overlay(shape.strokeBorder(theme.colors.border, lineWidth: 1))
  }
}

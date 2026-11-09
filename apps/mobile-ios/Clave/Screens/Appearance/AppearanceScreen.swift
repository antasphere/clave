import SwiftUI

/// Settings > Appearance: the system's choice or one of the desktop's four themes.
struct AppearanceScreen: View {
  let store: AppearanceStore

  @Environment(\.claveTheme) private var theme

  var body: some View {
    List {
      ForEach(Appearance.allCases) { option in
        row(option)
          .listRowBackground(theme.colors.surface50)
          .listRowSeparatorTint(theme.colors.borderSubtle)
      }
    }
    .scrollContentBackground(.hidden)
    .background(theme.colors.surface0)
    .navigationTitle("Appearance")
  }

  private func row(_ option: Appearance) -> some View {
    let selected = store.appearance == option
    return Button {
      store.appearance = option
    } label: {
      HStack(spacing: Theme.space(3)) {
        SwatchStrip(theme: Theme(Self.swatchTheme(option)))
        Text(option.label)
          .font(.geist(Theme.text.sm, relativeTo: .body))
          .foregroundStyle(theme.colors.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
        if selected {
          Icon(.check, size: Theme.control.icon)
            .foregroundStyle(theme.colors.accent)
        }
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(option.label)
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    .accessibilityIdentifier("appearance.option.\(option.rawValue)")
  }

  /// The system row shows dark because dark is what an unknown scheme resolves to.
  private static func swatchTheme(_ option: Appearance) -> ThemeName {
    themeFor(option, colorScheme: .dark)
  }
}

/// Four squares that say what a theme is: its ground, its raised step, its accent, its action ink.
private struct SwatchStrip: View {
  let theme: Theme

  @Environment(\.claveTheme) private var current

  var body: some View {
    HStack(spacing: 0) {
      ForEach(Array([theme.colors.surface0, theme.colors.surface100, theme.colors.accent, theme.colors.action].enumerated()), id: \.offset) { _, color in
        color.frame(width: 12, height: 24)
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: Theme.radius.md, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: Theme.radius.md, style: .continuous)
        .strokeBorder(current.colors.edge, lineWidth: 1)
    )
    .accessibilityHidden(true)
  }
}

#Preview {
  @Previewable @State var store = AppearanceStore(defaults: UserDefaults(suiteName: "preview.appearance")!)
  NavigationStack {
    AppearanceScreen(store: store)
  }
  .claveTheme(Theme(themeFor(store.appearance, colorScheme: .dark)))
}

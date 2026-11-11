import SwiftUI

/// Every component in the current theme on one page: the place to look at a
/// token or a component change before it reaches a screen. Not wired into the app.
struct ThemeGallery: View {
  @Environment(\.claveTheme) private var theme
  @State private var text = ""
  @State private var filled = "clave-app"

  var body: some View {
    VStack(spacing: 0) {
      PaneHeader("Theme gallery", subtitle: theme.name.rawValue.capitalized, status: .working) {
        Chip("4 themes")
      }
      ScrollView {
        VStack(alignment: .leading, spacing: Theme.space(4)) {
          SectionTitle("Buttons")
          HStack(spacing: Theme.space(2)) {
            Button("Send") {}.buttonStyle(.clave(.primary))
            Button("Cancel") {}.buttonStyle(.clave(.secondary))
            Button("Delete") {}.buttonStyle(.clave(.destructive))
          }
          HStack(spacing: Theme.space(2)) {
            Button {} label: { Icon(.plus, size: Theme.controlSm.icon); Text("New") }
              .buttonStyle(.clave(.primary, size: .small))
            Button("Small") {}.buttonStyle(.clave(.secondary, size: .small))
            Button("Disabled") {}.buttonStyle(.clave(.primary, size: .small)).disabled(true)
          }

          SectionTitle("Status")
          HStack(spacing: Theme.space(4)) {
            ForEach(StatusKind.allCases, id: \.self) { state in
              HStack(spacing: Theme.space(1.5)) {
                StatusDot(state)
                Text(state.label)
                  .font(.geist(Theme.text.xs, relativeTo: .caption))
                  .foregroundStyle(theme.colors.textSecondary)
              }
            }
          }
          HStack(spacing: Theme.space(2)) {
            Chip("main", icon: .commandLine)
            Chip("Claude", icon: .logoClaude)
            Chip("12")
          }

          SectionTitle("Fields")
          ClaveField("Search sessions", text: $text)
          ClaveField("Project", text: $filled)

          SectionTitle("Card")
          Card {
            VStack(alignment: .leading, spacing: Theme.space(1)) {
              Text("MacBook Pro")
                .font(.geist(Theme.text.sm, weight: .semibold, relativeTo: .headline))
                .foregroundStyle(theme.colors.textPrimary)
              Text("3 sessions, 1 waiting")
                .font(.geist(Theme.text.xs, relativeTo: .caption))
                .foregroundStyle(theme.colors.textSecondary)
              Text("npm run dev -- --port 4720")
                .monoFont(Theme.codeSize)
                .foregroundStyle(theme.colors.termCwd)
            }
          }
          .claveShadow(theme.raised)

          SectionTitle("Icons")
          LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 8), spacing: Theme.space(3)) {
            ForEach(IconName.allCases, id: \.self) { name in
              Icon(name, size: Theme.control.icon)
                .foregroundStyle(theme.colors.textSecondary)
            }
          }

          SectionTitle("Empty state")
          EmptyState(icon: .chatBubbleLeftRight, title: "No sessions yet", text: "Start one on your Mac and it shows up here.")
        }
        .padding(Theme.gutter)
      }
    }
    .background(theme.colors.surface0)
  }
}

#Preview("Dark") { ThemeGallery().claveTheme(Theme(.dark)) }
#Preview("Light") { ThemeGallery().claveTheme(Theme(.light)) }
#Preview("Coffee") { ThemeGallery().claveTheme(Theme(.coffee)) }
#Preview("Charcoal") { ThemeGallery().claveTheme(Theme(.charcoal)) }

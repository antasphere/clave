// The desktop's design system, as the iPhone app wears it. A port of the React
// Native prototype's apps/mobile/src/ui/theme.ts: the colour roles come from
// Tokens.generated.swift (read out of packages/ui/src/tokens.css), the metrics
// are the desktop's control spec scaled once for a thumb instead of a pointer,
// and the type is Geist Sans at the three weights the desktop loads.
import SwiftUI
import UIKit

// MARK: - Appearance

/// What the person picked; the system's scheme may still decide the theme.
nonisolated enum Appearance: String, CaseIterable, Identifiable, Sendable {
  case system, dark, light, coffee, charcoal

  var id: String { rawValue }

  var label: String {
    switch self {
    case .system: "Match the system"
    case .dark: "Dark"
    case .light: "Light"
    case .coffee: "Coffee"
    case .charcoal: "Charcoal"
    }
  }
}

/// The theme an appearance resolves to under the system's scheme. An unknown
/// scheme reads as dark because dark is the desktop's default theme.
nonisolated func themeFor(_ appearance: Appearance, colorScheme: ColorScheme?) -> ThemeName {
  switch appearance {
  case .system: colorScheme == .light ? .light : .dark
  case .dark: .dark
  case .light: .light
  case .coffee: .coffee
  case .charcoal: .charcoal
  }
}

// MARK: - Colours

nonisolated extension Color {
  init(_ token: TokenColor) {
    self.init(.sRGB, red: token.red, green: token.green, blue: token.blue, opacity: token.opacity)
  }
}

/// One shadow of the desktop's two (`--raised-shadow`, `--overlay-shadow`),
/// reduced to the single layer SwiftUI draws.
nonisolated struct ShadowSpec: Equatable, Sendable {
  let color: Color
  let radius: CGFloat
  let x: CGFloat
  let y: CGFloat
}

nonisolated struct Theme: Equatable, Sendable {
  let name: ThemeName
  /// A dark ground (dark, charcoal): system chrome inside the app goes light.
  let isDark: Bool
  let colors: Colors
  /// The composer, the prompt dock.
  let raised: ShadowSpec
  /// A floating control over the transcript.
  let overlay: ShadowSpec

  init(_ name: ThemeName) {
    self.name = name
    isDark = name == .dark || name == .charcoal
    // The generator emits every ThemeName, so a missing entry is a broken build, not a state.
    guard let tokens = themeColors[name] else { preconditionFailure("no tokens for \(name)") }
    colors = Colors(tokens, shared: sharedColors, isDark: isDark)
    let ink = Self.shadowInk(name)
    raised = ShadowSpec(color: ink.color.opacity(ink.raised), radius: 6, x: 0, y: 2)
    overlay = ShadowSpec(color: ink.color.opacity(ink.overlay), radius: 8, x: 0, y: 3)
  }

  /// The ink each theme's shadows are drawn in, and how much of it: a coffee
  /// shadow is brown, a charcoal one heavier than dark's because its ground is lighter.
  private static func shadowInk(_ name: ThemeName) -> (color: Color, raised: Double, overlay: Double) {
    switch name {
    case .dark: (Color(.sRGB, red: 0, green: 0, blue: 0), 0.3, 0.24)
    case .light: (Color(.sRGB, red: 0, green: 0, blue: 0), 0.05, 0.07)
    case .coffee: (Color(.sRGB, red: 60 / 255, green: 45 / 255, blue: 30 / 255), 0.06, 0.08)
    case .charcoal: (Color(.sRGB, red: 9 / 255, green: 6 / 255, blue: 4 / 255), 0.34, 0.34)
    }
  }

  struct Colors: Equatable, Sendable {
    let surface0, surface50, surface100, surface200, surface300, surface400, surfaceRaised: Color
    let border, borderSubtle: Color
    let textPrimary, textSecondary, textTertiary: Color
    let accent, accentHover: Color
    let action, actionHover, actionForeground: Color
    let sidebarItemText, sidebarIconColor, selectedRing, scrim, gitWorktree, rule: Color

    let destructive, success, warning: Color
    let statusWorking, statusReady, statusWaiting, statusInactive: Color
    let switchKnob, brandClaude, gitModified, gitIncoming: Color
    let termCwd, termModel, termMode: Color

    /// The hairline edge of a raised control (`--raised-control-shadow`'s ring).
    let edge: Color

    init(_ t: ThemeColors, shared s: SharedColors, isDark: Bool) {
      surface0 = Color(t.surface0)
      surface50 = Color(t.surface50)
      surface100 = Color(t.surface100)
      surface200 = Color(t.surface200)
      surface300 = Color(t.surface300)
      surface400 = Color(t.surface400)
      surfaceRaised = Color(t.surfaceRaised)
      border = Color(t.border)
      borderSubtle = Color(t.borderSubtle)
      textPrimary = Color(t.textPrimary)
      textSecondary = Color(t.textSecondary)
      textTertiary = Color(t.textTertiary)
      accent = Color(t.accent)
      accentHover = Color(t.accentHover)
      action = Color(t.action)
      actionHover = Color(t.actionHover)
      actionForeground = Color(t.actionForeground)
      sidebarItemText = Color(t.sidebarItemText)
      sidebarIconColor = Color(t.sidebarIconColor)
      selectedRing = Color(t.selectedRing)
      scrim = Color(t.scrim)
      gitWorktree = Color(t.gitWorktree)
      rule = Color(t.rule)
      destructive = Color(s.destructive)
      success = Color(s.success)
      warning = Color(s.warning)
      statusWorking = Color(s.statusWorking)
      statusReady = Color(s.statusReady)
      statusWaiting = Color(s.statusWaiting)
      statusInactive = Color(s.statusInactive)
      switchKnob = Color(s.switchKnob)
      brandClaude = Color(s.brandClaude)
      gitModified = Color(s.gitModified)
      gitIncoming = Color(s.gitIncoming)
      termCwd = Color(s.termCwd)
      termModel = Color(s.termModel)
      termMode = Color(s.termMode)
      edge = (isDark ? Color(.sRGB, red: 1, green: 1, blue: 1) : Color(.sRGB, red: 0, green: 0, blue: 0))
        .opacity(0.16)
    }
  }
}

// MARK: - Metrics

// The desktop's control spec is 28 : 8 : 6 : 13 : 6 with a 16pt glyph. A thumb
// needs a taller box, so the box and its corner grow the way the desktop's
// density presets grow them while the label keeps the desktop's 13pt.
nonisolated extension Theme {
  struct ControlMetrics: Sendable {
    let h, px, gap, text, radius, icon: CGFloat
  }

  struct ControlXsMetrics: Sendable {
    let h, icon: CGFloat
  }

  struct FieldMetrics: Sendable {
    let h, px, radius, text: CGFloat
  }

  struct RadiusScale: Sendable {
    let sm, md, control, lg, xl, xxl, full: CGFloat
  }

  struct TypeScale: Sendable {
    let xs, sm, base, lg, control, meta, badge: CGFloat
  }

  static let control = ControlMetrics(h: 36, px: 10, gap: 6, text: 13, radius: 8, icon: 16)
  /// One size down, as a control inside a frame on the desktop. It keeps the
  /// full control's icon gap because the desktop restates no gap for it.
  static let controlSm = ControlMetrics(h: 32, px: 8, gap: 6, text: 12, radius: 7, icon: 14)
  /// A row-level affordance (the desktop's 20pt box).
  static let controlXs = ControlXsMetrics(h: 28, icon: 14)
  /// `.input-field`: the desktop's 32pt field, a touch step taller.
  static let field = FieldMetrics(h: 40, px: 12, radius: 8, text: 14)
  static let radius = RadiusScale(sm: 3, md: 4, control: 8, lg: 8, xl: 13, xxl: 16, full: 999)
  static let text = TypeScale(xs: 12, sm: 14, base: 16, lg: 18, control: 13, meta: 11, badge: 10)
  /// The chat view's code size: text-sm less a quarter spacing.
  static let codeSize: CGFloat = 13
  /// The chat's glyph: 3.5 spacings.
  static let chatGlyph: CGFloat = 14
  /// The page's horizontal gutter: the column padding the desktop gives a pane's content.
  static let gutter: CGFloat = space(4)

  /// `--spacing`, 4pt.
  static func space(_ n: CGFloat) -> CGFloat { n * 4 }
}

// MARK: - Fonts

/// The desktop's weight names. Its `font-medium` is 400 (`fontWeightMedium`),
/// so `.medium` draws the Regular face exactly as the desktop and the prototype do.
nonisolated enum GeistWeight: Sendable {
  case regular, medium, semibold

  var numericWeight: Int {
    switch self {
    case .regular: 400
    case .medium: fontWeightMedium
    case .semibold: 600
    }
  }

  /// One PostScript name per face: a custom family picks no weight by itself.
  var fontName: String { Self.fontName(forWeight: numericWeight) }

  static let regularFontName = "Geist-Regular"
  static let mediumFontName = "Geist-Medium"
  static let semiboldFontName = "Geist-SemiBold"

  static func fontName(forWeight weight: Int) -> String {
    switch weight {
    case ..<450: regularFontName
    case ..<550: mediumFontName
    default: semiboldFontName
    }
  }
}

nonisolated extension Font {
  /// Geist at a size from the type scale, scaling with Dynamic Type along `relativeTo`.
  static func geist(
    _ size: CGFloat,
    weight: GeistWeight = .medium,
    relativeTo textStyle: Font.TextStyle = .body
  ) -> Font {
    .custom(weight.fontName, size: size, relativeTo: textStyle)
  }
}

/// The system's monospaced design at a size of the type scale. SwiftUI has no sized, scaling
/// system font, so the size is a `@ScaledMetric` along `relativeTo`: it follows a change of the
/// text size while the view is on screen.
struct MonoFont: ViewModifier {
  @ScaledMetric private var size: CGFloat

  init(size: CGFloat, relativeTo textStyle: Font.TextStyle) {
    _size = ScaledMetric(wrappedValue: size, relativeTo: textStyle)
  }

  func body(content: Content) -> some View {
    content.font(.system(size: size, design: .monospaced))
  }
}

extension View {
  /// Monospaced text at `size`, scaled with Dynamic Type along `relativeTo`.
  func monoFont(_ size: CGFloat, relativeTo textStyle: Font.TextStyle = .body) -> some View {
    modifier(MonoFont(size: size, relativeTo: textStyle))
  }
}

// MARK: - Environment

nonisolated private struct ClaveThemeKey: EnvironmentKey {
  static let defaultValue = Theme(.dark)
}

extension EnvironmentValues {
  var claveTheme: Theme {
    get { self[ClaveThemeKey.self] }
    set { self[ClaveThemeKey.self] = newValue }
  }
}

extension View {
  /// Puts the theme in the environment. The color scheme follows the theme's
  /// ground so system controls inside (lists, pickers, the keyboard) match it.
  func claveTheme(_ theme: Theme) -> some View {
    environment(\.claveTheme, theme)
      .environment(\.colorScheme, theme.isDark ? .dark : .light)
      .tint(theme.colors.accent)
  }

  func claveShadow(_ spec: ShadowSpec) -> some View {
    shadow(color: spec.color, radius: spec.radius, x: spec.x, y: spec.y)
  }
}

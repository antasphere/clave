// Generated from packages/ui/src/tokens.css by apps/mobile-ios/scripts/generate-tokens.mjs.
// Do not edit: run `node scripts/generate-tokens.mjs` in apps/mobile-ios to rewrite it;
// `node scripts/generate-tokens.mjs --check` fails when it no longer matches the stylesheet.

nonisolated public enum ThemeName: String, CaseIterable, Codable, Sendable {
  case dark, light, coffee, charcoal
}

/// An sRGB colour, each component in 0...1.
nonisolated public struct TokenColor: Equatable, Sendable {
  public let red, green, blue, opacity: Double
}

nonisolated public struct ThemeColors: Equatable, Sendable {
  public let surface0: TokenColor
  public let surface50: TokenColor
  public let surface100: TokenColor
  public let surface200: TokenColor
  public let surface300: TokenColor
  public let surface400: TokenColor
  public let surfaceRaised: TokenColor
  public let border: TokenColor
  public let borderSubtle: TokenColor
  public let textPrimary: TokenColor
  public let textSecondary: TokenColor
  public let textTertiary: TokenColor
  public let accent: TokenColor
  public let accentHover: TokenColor
  public let action: TokenColor
  public let actionHover: TokenColor
  public let actionForeground: TokenColor
  public let sidebarItemText: TokenColor
  public let sidebarIconColor: TokenColor
  public let selectedRing: TokenColor
  public let scrim: TokenColor
  public let gitWorktree: TokenColor
  public let rule: TokenColor
}

nonisolated public let themeColors: [ThemeName: ThemeColors] = [
  .dark: ThemeColors(
    surface0: TokenColor(red: 0.054902, green: 0.05098, blue: 0.047059, opacity: 1.0), // #0e0d0c
    surface50: TokenColor(red: 0.086275, green: 0.082353, blue: 0.07451, opacity: 1.0), // #161513
    surface100: TokenColor(red: 0.113725, green: 0.109804, blue: 0.098039, opacity: 1.0), // #1d1c19
    surface200: TokenColor(red: 0.14902, green: 0.141176, blue: 0.12549, opacity: 1.0), // #262420
    surface300: TokenColor(red: 0.184314, green: 0.172549, blue: 0.156863, opacity: 1.0), // #2f2c28
    surface400: TokenColor(red: 0.219608, green: 0.207843, blue: 0.184314, opacity: 1.0), // #38352f
    surfaceRaised: TokenColor(red: 0.086275, green: 0.082353, blue: 0.07451, opacity: 1.0), // #161513
    border: TokenColor(red: 1.0, green: 1.0, blue: 1.0, opacity: 0.1), // rgba(255, 255, 255, 0.1)
    borderSubtle: TokenColor(red: 1.0, green: 1.0, blue: 1.0, opacity: 0.06), // rgba(255, 255, 255, 0.06)
    textPrimary: TokenColor(red: 1.0, green: 1.0, blue: 1.0, opacity: 0.95), // rgba(255, 255, 255, 0.95)
    textSecondary: TokenColor(red: 1.0, green: 1.0, blue: 1.0, opacity: 0.6), // rgba(255, 255, 255, 0.6)
    textTertiary: TokenColor(red: 1.0, green: 1.0, blue: 1.0, opacity: 0.47), // rgba(255, 255, 255, 0.47)
    accent: TokenColor(red: 0.352941, green: 0.635294, blue: 0.968627, opacity: 1.0), // #5aa2f7
    accentHover: TokenColor(red: 0.470588, green: 0.705882, blue: 0.976471, opacity: 1.0), // #78b4f9
    action: TokenColor(red: 0.945098, green: 0.941176, blue: 0.933333, opacity: 1.0), // #f1f0ee
    actionHover: TokenColor(red: 0.843137, green: 0.839216, blue: 0.831373, opacity: 1.0), // #d7d6d4
    actionForeground: TokenColor(red: 0.054902, green: 0.05098, blue: 0.047059, opacity: 1.0), // #0e0d0c
    sidebarItemText: TokenColor(red: 1.0, green: 1.0, blue: 1.0, opacity: 0.78), // rgba(255, 255, 255, 0.78)
    sidebarIconColor: TokenColor(red: 1.0, green: 1.0, blue: 1.0, opacity: 0.6), // rgba(255, 255, 255, 0.6)
    selectedRing: TokenColor(red: 0.0, green: 0.0, blue: 0.0, opacity: 0.12), // rgba(0, 0, 0, 0.12)
    scrim: TokenColor(red: 0.0, green: 0.0, blue: 0.0, opacity: 0.4), // rgb(0 0 0 / 0.4)
    gitWorktree: TokenColor(red: 0.654902, green: 0.545098, blue: 0.980392, opacity: 1.0), // #a78bfa
    rule: TokenColor(red: 1.0, green: 1.0, blue: 1.0, opacity: 0.045) // rgb(255 255 255 / 0.045)
  ),
  .light: ThemeColors(
    surface0: TokenColor(red: 0.984314, green: 0.984314, blue: 0.976471, opacity: 1.0), // #fbfbf9
    surface50: TokenColor(red: 0.960784, green: 0.956863, blue: 0.94902, opacity: 1.0), // #f5f4f2
    surface100: TokenColor(red: 0.933333, green: 0.929412, blue: 0.921569, opacity: 1.0), // #eeedeb
    surface200: TokenColor(red: 0.894118, green: 0.890196, blue: 0.878431, opacity: 1.0), // #e4e3e0
    surface300: TokenColor(red: 0.843137, green: 0.839216, blue: 0.827451, opacity: 1.0), // #d7d6d3
    surface400: TokenColor(red: 0.788235, green: 0.784314, blue: 0.772549, opacity: 1.0), // #c9c8c5
    surfaceRaised: TokenColor(red: 1.0, green: 1.0, blue: 1.0, opacity: 1.0), // #ffffff
    border: TokenColor(red: 0.0, green: 0.0, blue: 0.0, opacity: 0.1), // rgba(0, 0, 0, 0.1)
    borderSubtle: TokenColor(red: 0.0, green: 0.0, blue: 0.0, opacity: 0.05), // rgba(0, 0, 0, 0.05)
    textPrimary: TokenColor(red: 0.105882, green: 0.105882, blue: 0.094118, opacity: 1.0), // #1b1b18
    textSecondary: TokenColor(red: 0.360784, green: 0.360784, blue: 0.337255, opacity: 1.0), // #5c5c56
    textTertiary: TokenColor(red: 0.439216, green: 0.439216, blue: 0.415686, opacity: 1.0), // #70706a
    accent: TokenColor(red: 0.121569, green: 0.372549, blue: 0.811765, opacity: 1.0), // #1f5fcf
    accentHover: TokenColor(red: 0.101961, green: 0.317647, blue: 0.694118, opacity: 1.0), // #1a51b1
    action: TokenColor(red: 0.105882, green: 0.105882, blue: 0.094118, opacity: 1.0), // #1b1b18
    actionHover: TokenColor(red: 0.207843, green: 0.207843, blue: 0.196078, opacity: 1.0), // #353532
    actionForeground: TokenColor(red: 0.984314, green: 0.984314, blue: 0.976471, opacity: 1.0), // #fbfbf9
    sidebarItemText: TokenColor(red: 0.270588, green: 0.270588, blue: 0.247059, opacity: 1.0), // #45453f
    sidebarIconColor: TokenColor(red: 0.423529, green: 0.423529, blue: 0.396078, opacity: 1.0), // #6c6c65
    selectedRing: TokenColor(red: 0.0, green: 0.0, blue: 0.0, opacity: 0.12), // rgba(0, 0, 0, 0.12)
    scrim: TokenColor(red: 0.105882, green: 0.105882, blue: 0.094118, opacity: 0.25), // rgb(27 27 24 / 0.25)
    gitWorktree: TokenColor(red: 0.486275, green: 0.227451, blue: 0.929412, opacity: 1.0), // #7c3aed
    rule: TokenColor(red: 0.0, green: 0.0, blue: 0.0, opacity: 0.022) // rgb(0 0 0 / 0.022)
  ),
  .coffee: ThemeColors(
    surface0: TokenColor(red: 0.960784, green: 0.945098, blue: 0.921569, opacity: 1.0), // #f5f1eb
    surface50: TokenColor(red: 0.933333, green: 0.921569, blue: 0.898039, opacity: 1.0), // #eeebe5
    surface100: TokenColor(red: 0.909804, green: 0.894118, blue: 0.866667, opacity: 1.0), // #e8e4dd
    surface200: TokenColor(red: 0.866667, green: 0.85098, blue: 0.819608, opacity: 1.0), // #ddd9d1
    surface300: TokenColor(red: 0.815686, green: 0.796078, blue: 0.764706, opacity: 1.0), // #d0cbc3
    surface400: TokenColor(red: 0.764706, green: 0.741176, blue: 0.705882, opacity: 1.0), // #c3bdb4
    surfaceRaised: TokenColor(red: 0.988235, green: 0.980392, blue: 0.968627, opacity: 1.0), // #fcfaf7
    border: TokenColor(red: 0.470588, green: 0.392157, blue: 0.313725, opacity: 0.15), // rgba(120, 100, 80, 0.15)
    borderSubtle: TokenColor(red: 0.470588, green: 0.392157, blue: 0.313725, opacity: 0.08), // rgba(120, 100, 80, 0.08)
    textPrimary: TokenColor(red: 0.105882, green: 0.086275, blue: 0.062745, opacity: 1.0), // #1b1610
    textSecondary: TokenColor(red: 0.364706, green: 0.341176, blue: 0.309804, opacity: 1.0), // #5d574f
    textTertiary: TokenColor(red: 0.427451, green: 0.4, blue: 0.376471, opacity: 1.0), // #6d6660
    accent: TokenColor(red: 0.121569, green: 0.356863, blue: 0.768627, opacity: 1.0), // #1f5bc4
    accentHover: TokenColor(red: 0.101961, green: 0.305882, blue: 0.658824, opacity: 1.0), // #1a4ea8
    action: TokenColor(red: 0.105882, green: 0.086275, blue: 0.062745, opacity: 1.0), // #1b1610
    actionHover: TokenColor(red: 0.203922, green: 0.188235, blue: 0.164706, opacity: 1.0), // #34302a
    actionForeground: TokenColor(red: 0.960784, green: 0.945098, blue: 0.921569, opacity: 1.0), // #f5f1eb
    sidebarItemText: TokenColor(red: 0.301961, green: 0.282353, blue: 0.25098, opacity: 1.0), // #4d4840
    sidebarIconColor: TokenColor(red: 0.458824, green: 0.431373, blue: 0.4, opacity: 1.0), // #756e66
    selectedRing: TokenColor(red: 0.0, green: 0.0, blue: 0.0, opacity: 0.12), // rgba(0, 0, 0, 0.12)
    scrim: TokenColor(red: 0.168627, green: 0.133333, blue: 0.094118, opacity: 0.25), // rgb(43 34 24 / 0.25)
    gitWorktree: TokenColor(red: 0.486275, green: 0.227451, blue: 0.929412, opacity: 1.0), // #7c3aed
    rule: TokenColor(red: 0.470588, green: 0.392157, blue: 0.313725, opacity: 0.055) // rgb(120 100 80 / 0.055)
  ),
  .charcoal: ThemeColors(
    surface0: TokenColor(red: 0.168627, green: 0.152941, blue: 0.133333, opacity: 1.0), // #2b2722
    surface50: TokenColor(red: 0.203922, green: 0.188235, blue: 0.172549, opacity: 1.0), // #34302c
    surface100: TokenColor(red: 0.243137, green: 0.227451, blue: 0.207843, opacity: 1.0), // #3e3a35
    surface200: TokenColor(red: 0.298039, green: 0.278431, blue: 0.262745, opacity: 1.0), // #4c4743
    surface300: TokenColor(red: 0.352941, green: 0.337255, blue: 0.317647, opacity: 1.0), // #5a5651
    surface400: TokenColor(red: 0.415686, green: 0.396078, blue: 0.376471, opacity: 1.0), // #6a6560
    surfaceRaised: TokenColor(red: 0.203922, green: 0.188235, blue: 0.172549, opacity: 1.0), // #34302c
    border: TokenColor(red: 1.0, green: 0.952941, blue: 0.909804, opacity: 0.1), // rgba(255, 243, 232, 0.1)
    borderSubtle: TokenColor(red: 1.0, green: 0.952941, blue: 0.909804, opacity: 0.058), // rgba(255, 243, 232, 0.058)
    textPrimary: TokenColor(red: 0.937255, green: 0.92549, blue: 0.913725, opacity: 1.0), // #efece9
    textSecondary: TokenColor(red: 0.721569, green: 0.705882, blue: 0.690196, opacity: 1.0), // #b8b4b0
    textTertiary: TokenColor(red: 0.611765, green: 0.596078, blue: 0.576471, opacity: 1.0), // #9c9893
    accent: TokenColor(red: 0.470588, green: 0.690196, blue: 0.960784, opacity: 1.0), // #78b0f5
    accentHover: TokenColor(red: 0.576471, green: 0.752941, blue: 0.968627, opacity: 1.0), // #93c0f7
    action: TokenColor(red: 0.937255, green: 0.92549, blue: 0.913725, opacity: 1.0), // #efece9
    actionHover: TokenColor(red: 0.85098, green: 0.835294, blue: 0.823529, opacity: 1.0), // #d9d5d2
    actionForeground: TokenColor(red: 0.168627, green: 0.152941, blue: 0.133333, opacity: 1.0), // #2b2722
    sidebarItemText: TokenColor(red: 0.780392, green: 0.764706, blue: 0.752941, opacity: 1.0), // #c7c3c0
    sidebarIconColor: TokenColor(red: 0.623529, green: 0.603922, blue: 0.588235, opacity: 1.0), // #9f9a96
    selectedRing: TokenColor(red: 1.0, green: 0.952941, blue: 0.909804, opacity: 0.07), // rgba(255, 243, 232, 0.07)
    scrim: TokenColor(red: 0.094118, green: 0.070588, blue: 0.05098, opacity: 0.46), // rgb(24 18 13 / 0.46)
    gitWorktree: TokenColor(red: 0.654902, green: 0.545098, blue: 0.980392, opacity: 1.0), // #a78bfa
    rule: TokenColor(red: 1.0, green: 0.952941, blue: 0.909804, opacity: 0.045) // rgb(255 243 232 / 0.045)
  )
]

nonisolated public struct SharedColors: Equatable, Sendable {
  public let destructive: TokenColor
  public let success: TokenColor
  public let warning: TokenColor
  public let statusWorking: TokenColor
  public let statusReady: TokenColor
  public let statusWaiting: TokenColor
  public let statusInactive: TokenColor
  public let switchKnob: TokenColor
  public let brandClaude: TokenColor
  public let gitModified: TokenColor
  public let gitIncoming: TokenColor
  public let termCwd: TokenColor
  public let termModel: TokenColor
  public let termMode: TokenColor
}

nonisolated public let sharedColors = SharedColors(
  destructive: TokenColor(red: 0.937255, green: 0.266667, blue: 0.266667, opacity: 1.0), // #ef4444
  success: TokenColor(red: 0.133333, green: 0.772549, blue: 0.368627, opacity: 1.0), // #22c55e
  warning: TokenColor(red: 0.960784, green: 0.619608, blue: 0.043137, opacity: 1.0), // #f59e0b
  statusWorking: TokenColor(red: 0.231373, green: 0.509804, blue: 0.964706, opacity: 1.0), // #3b82f6
  statusReady: TokenColor(red: 0.133333, green: 0.772549, blue: 0.368627, opacity: 1.0), // #22c55e
  statusWaiting: TokenColor(red: 0.960784, green: 0.619608, blue: 0.043137, opacity: 1.0), // #f59e0b
  statusInactive: TokenColor(red: 0.419608, green: 0.447059, blue: 0.501961, opacity: 1.0), // #6b7280
  switchKnob: TokenColor(red: 1.0, green: 1.0, blue: 1.0, opacity: 1.0), // #ffffff
  brandClaude: TokenColor(red: 0.85098, green: 0.466667, blue: 0.341176, opacity: 1.0), // #d97757
  gitModified: TokenColor(red: 0.654902, green: 0.545098, blue: 0.980392, opacity: 1.0), // #a78bfa
  gitIncoming: TokenColor(red: 0.219608, green: 0.741176, blue: 0.972549, opacity: 1.0), // #38bdf8
  termCwd: TokenColor(red: 0.0, green: 0.623529, blue: 0.67451, opacity: 1.0), // oklch(0.64 0.11 205)
  termModel: TokenColor(red: 0.607843, green: 0.380392, blue: 0.917647, opacity: 1.0), // oklch(0.62 0.2 300)
  termMode: TokenColor(red: 0.764706, green: 0.505882, blue: 0.282353, opacity: 1.0) // oklch(0.66 0.11 60)
)

/// The desktop's `font-medium`.
nonisolated public let fontWeightMedium = 400

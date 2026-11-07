/* Generated from packages/ui/src/tokens.css by scripts/generate-tokens.mjs.
   Do not edit: `npm run tokens` in packages/mobile rewrites it, and
   src/ui/tokens.test.ts fails when it no longer matches the stylesheet. */

export const THEME_NAMES = ['dark', 'light', 'coffee', 'charcoal'] as const
export type ThemeName = (typeof THEME_NAMES)[number]

export interface ThemeColors {
  readonly surface0: string
  readonly surface50: string
  readonly surface100: string
  readonly surface200: string
  readonly surface300: string
  readonly surface400: string
  readonly surfaceRaised: string
  readonly border: string
  readonly borderSubtle: string
  readonly textPrimary: string
  readonly textSecondary: string
  readonly textTertiary: string
  readonly accent: string
  readonly accentHover: string
  readonly action: string
  readonly actionHover: string
  readonly actionForeground: string
  readonly sidebarItemText: string
  readonly sidebarIconColor: string
  readonly selectedRing: string
  readonly scrim: string
  readonly gitWorktree: string
  readonly rule: string
}

export const THEME_COLORS: Record<ThemeName, ThemeColors> = {
  dark: {
    surface0: '#0e0d0c',
    surface50: '#161513',
    surface100: '#1d1c19',
    surface200: '#262420',
    surface300: '#2f2c28',
    surface400: '#38352f',
    surfaceRaised: '#161513',
    border: 'rgba(255, 255, 255, 0.1)',
    borderSubtle: 'rgba(255, 255, 255, 0.06)',
    textPrimary: 'rgba(255, 255, 255, 0.95)',
    textSecondary: 'rgba(255, 255, 255, 0.6)',
    textTertiary: 'rgba(255, 255, 255, 0.47)',
    accent: '#5aa2f7',
    accentHover: '#78b4f9',
    action: '#f1f0ee',
    actionHover: '#d7d6d4',
    actionForeground: '#0e0d0c',
    sidebarItemText: 'rgba(255, 255, 255, 0.78)',
    sidebarIconColor: 'rgba(255, 255, 255, 0.6)',
    selectedRing: 'rgba(0, 0, 0, 0.12)',
    scrim: 'rgba(0, 0, 0, 0.4)',
    gitWorktree: '#a78bfa',
    rule: 'rgba(255, 255, 255, 0.045)'
  },
  light: {
    surface0: '#fbfbf9',
    surface50: '#f5f4f2',
    surface100: '#eeedeb',
    surface200: '#e4e3e0',
    surface300: '#d7d6d3',
    surface400: '#c9c8c5',
    surfaceRaised: '#ffffff',
    border: 'rgba(0, 0, 0, 0.1)',
    borderSubtle: 'rgba(0, 0, 0, 0.05)',
    textPrimary: '#1b1b18',
    textSecondary: '#5c5c56',
    textTertiary: '#70706a',
    accent: '#1f5fcf',
    accentHover: '#1a51b1',
    action: '#1b1b18',
    actionHover: '#353532',
    actionForeground: '#fbfbf9',
    sidebarItemText: '#45453f',
    sidebarIconColor: '#6c6c65',
    selectedRing: 'rgba(0, 0, 0, 0.12)',
    scrim: 'rgba(27, 27, 24, 0.25)',
    gitWorktree: '#7c3aed',
    rule: 'rgba(0, 0, 0, 0.022)'
  },
  coffee: {
    surface0: '#f5f1eb',
    surface50: '#eeebe5',
    surface100: '#e8e4dd',
    surface200: '#ddd9d1',
    surface300: '#d0cbc3',
    surface400: '#c3bdb4',
    surfaceRaised: '#fcfaf7',
    border: 'rgba(120, 100, 80, 0.15)',
    borderSubtle: 'rgba(120, 100, 80, 0.08)',
    textPrimary: '#1b1610',
    textSecondary: '#5d574f',
    textTertiary: '#6d6660',
    accent: '#1f5bc4',
    accentHover: '#1a4ea8',
    action: '#1b1610',
    actionHover: '#34302a',
    actionForeground: '#f5f1eb',
    sidebarItemText: '#4d4840',
    sidebarIconColor: '#756e66',
    selectedRing: 'rgba(0, 0, 0, 0.12)',
    scrim: 'rgba(43, 34, 24, 0.25)',
    gitWorktree: '#7c3aed',
    rule: 'rgba(120, 100, 80, 0.055)'
  },
  charcoal: {
    surface0: '#2b2722',
    surface50: '#34302c',
    surface100: '#3e3a35',
    surface200: '#4c4743',
    surface300: '#5a5651',
    surface400: '#6a6560',
    surfaceRaised: '#34302c',
    border: 'rgba(255, 243, 232, 0.1)',
    borderSubtle: 'rgba(255, 243, 232, 0.058)',
    textPrimary: '#efece9',
    textSecondary: '#b8b4b0',
    textTertiary: '#9c9893',
    accent: '#78b0f5',
    accentHover: '#93c0f7',
    action: '#efece9',
    actionHover: '#d9d5d2',
    actionForeground: '#2b2722',
    sidebarItemText: '#c7c3c0',
    sidebarIconColor: '#9f9a96',
    selectedRing: 'rgba(255, 243, 232, 0.07)',
    scrim: 'rgba(24, 18, 13, 0.46)',
    gitWorktree: '#a78bfa',
    rule: 'rgba(255, 243, 232, 0.045)'
  }
}

export const SHARED_COLORS = {
  destructive: '#ef4444',
  success: '#22c55e',
  warning: '#f59e0b',
  statusWorking: '#3b82f6',
  statusReady: '#22c55e',
  statusWaiting: '#f59e0b',
  statusInactive: '#6b7280',
  switchKnob: '#ffffff',
  brandClaude: '#d97757',
  gitModified: '#a78bfa',
  gitIncoming: '#38bdf8',
  termCwd: '#009fac',
  termModel: '#9b61ea',
  termMode: '#c38148'
} as const

export const FONT_WEIGHT_MEDIUM = 400

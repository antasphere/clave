/**
 * The phone's palette: the dark theme's tokens of `packages/ui/src/tokens.css`
 * (the surfaces, the two text roles, the one signal blue for state and the
 * ink for a verb), restated as values, since the phone has no CSS. The
 * rule the tokens carry comes with them: verbs are ink, states are blue,
 * everything else is neutral.
 */
export const colors = {
  surface0: '#0e0d0c',
  surface50: '#161513',
  surface100: '#1d1c19',
  surface200: '#262420',
  surface300: '#2f2c28',
  surface400: '#38352f',
  border: 'rgba(255, 255, 255, 0.1)',
  borderSubtle: 'rgba(255, 255, 255, 0.06)',
  textPrimary: 'rgba(255, 255, 255, 0.95)',
  textSecondary: 'rgba(255, 255, 255, 0.6)',
  textTertiary: 'rgba(255, 255, 255, 0.47)',
  accent: '#5aa2f7',
  action: '#f1f0ee',
  actionForeground: '#0e0d0c',
  destructive: '#ef4444',
  warning: '#f59e0b',
  success: '#34d399'
} as const

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const
export const radius = { sm: 6, md: 10, lg: 14 } as const
export const font = { xs: 12, sm: 13, md: 15, lg: 17, xl: 22 } as const

/** The tone of a state pill. */
export type Tone = 'neutral' | 'accent' | 'warning' | 'danger' | 'success'

export const toneColor: Record<Tone, string> = {
  neutral: colors.textSecondary,
  accent: colors.accent,
  warning: colors.warning,
  danger: colors.destructive,
  success: colors.success
}

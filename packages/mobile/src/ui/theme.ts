/**
 * The desktop's design system, as the phone wears it. The colour roles are
 * the desktop's own, read from `packages/ui/src/tokens.css` into
 * `tokens.generated.ts` (`npm run tokens`; `tokens.test.ts` fails when the
 * two drift): the four themes, the ladder of greys, the two colour roles
 * (verbs are ink, states are blue, everything else is neutral) and the
 * cross-theme inks. The metrics below are the desktop's control spec (one
 * control, five numbers: 28px tall, 8px sides, 6px icon gap, 13px label, 6px
 * corner) scaled once for a thumb instead of a pointer, the way a density
 * preset restates it; nothing else is multiplied. The type is Geist Sans at
 * the three weights the desktop loads, `font-medium` resolving to 400 there
 * and here.
 */
import { createContext, useContext, useMemo } from 'react'
import { Platform, useColorScheme, type TextStyle, type ViewStyle } from 'react-native'
import {
  FONT_WEIGHT_MEDIUM,
  SHARED_COLORS,
  THEME_COLORS,
  THEME_NAMES,
  type ThemeColors,
  type ThemeName
} from './tokens.generated'

export { THEME_NAMES, type ThemeName }

/** Appearance → Theme on the desktop; here the system's scheme may decide. */
export type Appearance = ThemeName | 'system'
export const APPEARANCE_KEY = 'clave.appearance'
export const APPEARANCES: readonly Appearance[] = ['system', ...THEME_NAMES]
export const THEME_LABELS: Record<Appearance, string> = {
  system: 'Match the system',
  dark: 'Dark',
  light: 'Light',
  coffee: 'Coffee',
  charcoal: 'Charcoal'
}
export const isAppearance = (value: unknown): value is Appearance =>
  typeof value === 'string' && (APPEARANCES as readonly string[]).includes(value)

/** The theme an appearance resolves to under the system's scheme. */
export function themeFor(
  appearance: Appearance,
  scheme: 'light' | 'dark' | null | undefined
): ThemeName {
  if (appearance !== 'system') return appearance
  return scheme === 'light' ? 'light' : 'dark'
}

/* ── The control spec, scaled for touch ──
   Desktop: 28 : 8 : 6 : 13 : 6, a 16px glyph. A thumb needs a taller box;
   the label stays the desktop's 13px and the corner grows with the box the
   way the density presets grow it (7px at Comfortable's 34px frame). */
export const control = { h: 36, px: 10, gap: 6, text: 13, radius: 8, icon: 16 } as const
/** One size down, as a control inside a frame on the desktop (24px, 14px glyph). */
export const controlSm = { h: 32, px: 8, text: 12, radius: 7, icon: 14 } as const
/** A row-level affordance (the desktop's 20px box). */
export const controlXs = { h: 28, icon: 14 } as const
/** `.input-field`: the desktop's 32px field, a touch step taller. */
export const field = { h: 40, px: 12, radius: 8, text: 14 } as const
/** The corners: sm, md, the control's, the surface's (derived from the
 *  control's plus the surface inset and the border), the 2xl of a user turn
 *  and the composer, and full. */
export const radius = { sm: 3, md: 4, control: 8, lg: 8, xl: 13, xxl: 16, full: 999 } as const
/** `--spacing`, 4px. */
export const space = (n: number): number => n * 4
/** The page's horizontal gutter: the column padding the desktop gives a pane's content. */
export const gutter = space(4)
/** The type scale the desktop's classes use: text-xs 12, text-sm 14, text-base
 *  16, text-lg 18, the control label 13, the meta line 11, a badge 10. */
export const text = { xs: 12, sm: 14, base: 16, lg: 18, control: 13, meta: 11, badge: 10 } as const
/** The chat view's code size: text-sm less a quarter spacing. */
export const codeSize = text.sm - 1
/** The chat's glyph: 3.5 spacings, 14px. */
export const chatGlyph = 14

export type Weight = 400 | 500 | 600
/** One family per weight: the phone's text engine picks no weight from a
 *  family, so each face is its own name (App.tsx loads the three). */
export const family: Record<Weight, string> = {
  400: 'Geist-Regular',
  500: 'Geist-Medium',
  600: 'Geist-SemiBold'
}
export const monoFamily = Platform.OS === 'ios' ? 'Menlo' : 'monospace'
/** The desktop's `font-medium`: 400. */
export const mediumWeight = FONT_WEIGHT_MEDIUM as Weight

/** A text style in Geist: the size, the weight (the desktop's medium by
 *  default) and the line height as a ratio, the way the stylesheet writes it. */
export function type(size: number, weight: Weight = mediumWeight, lineHeight?: number): TextStyle {
  return {
    fontFamily: family[weight],
    fontSize: size,
    ...(lineHeight === undefined ? {} : { lineHeight: Math.round(size * lineHeight) })
  }
}
export function mono(size: number, lineHeight = 1.5): TextStyle {
  return { fontFamily: monoFamily, fontSize: size, lineHeight: Math.round(size * lineHeight) }
}

/** A colour at another alpha: the desktop's color-mix toward transparent. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
  }
  const rgba = /^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(color)
  if (rgba) return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, ${alpha})`
  return color
}

export interface Theme {
  readonly name: ThemeName
  /** A dark ground (dark, charcoal): the status bar's text goes light. */
  readonly dark: boolean
  readonly colors: ThemeColors &
    typeof SHARED_COLORS & {
      /** The hairline edge of a raised control (`--raised-control-shadow`'s ring). */
      readonly edge: string
    }
  /** `--raised-shadow`: the composer, the prompt dock. */
  readonly raised: ViewStyle
  /** `--overlay-shadow`: a floating control over the transcript. */
  readonly overlay: ViewStyle
}

const SHADOW_INK: Record<ThemeName, { color: string; raised: number; overlay: number }> = {
  dark: { color: '#000000', raised: 0.3, overlay: 0.24 },
  light: { color: '#000000', raised: 0.05, overlay: 0.07 },
  coffee: { color: '#3c2d1e', raised: 0.06, overlay: 0.08 },
  charcoal: { color: '#090604', raised: 0.34, overlay: 0.34 }
}

export function buildTheme(name: ThemeName): Theme {
  const dark = name === 'dark' || name === 'charcoal'
  const colors = THEME_COLORS[name]
  const shadow = SHADOW_INK[name]
  return {
    name,
    dark,
    colors: {
      ...colors,
      ...SHARED_COLORS,
      edge: withAlpha(dark ? '#ffffff' : '#000000', 0.16)
    },
    raised: {
      shadowColor: shadow.color,
      shadowOpacity: shadow.raised,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 2 },
      elevation: 2
    },
    overlay: {
      shadowColor: shadow.color,
      shadowOpacity: shadow.overlay,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 },
      elevation: 4
    }
  }
}

const ThemeContext = createContext<Theme>(buildTheme('dark'))
export const ThemeProvider = ThemeContext.Provider

/** The theme of the appearance under the system's scheme, memoised. */
export function useResolvedTheme(appearance: Appearance): Theme {
  const scheme = useColorScheme()
  return useMemo(() => buildTheme(themeFor(appearance, scheme)), [appearance, scheme])
}

export function useTheme(): Theme {
  return useContext(ThemeContext)
}

/** Styles built from the theme once per theme: `make` is a module-level
 *  function, so the memo holds. */
export function useStyles<T>(make: (t: Theme) => T): T {
  const t = useTheme()
  return useMemo(() => make(t), [t, make])
}

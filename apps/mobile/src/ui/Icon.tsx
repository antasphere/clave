/**
 * A Heroicon (24/outline) or a provider mark, drawn from the rasters
 * `scripts/build-icons.mjs` makes out of the desktop's own icon modules, and
 * tinted at render time the way the desktop paints `currentColor`.
 */
import type { ReactNode } from 'react'
import { Image, type ImageStyle, type StyleProp } from 'react-native'
import { ICON_SOURCES, type IconName } from './icons.generated'

export type { IconName }

export function Icon({
  name,
  size = 16,
  color,
  style
}: {
  name: IconName
  size?: number
  color: string
  style?: StyleProp<ImageStyle>
}): ReactNode {
  return (
    <Image
      source={ICON_SOURCES[name]}
      style={[{ width: size, height: size, tintColor: color }, style]}
      resizeMode="contain"
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  )
}

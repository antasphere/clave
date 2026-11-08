import {
  UserIcon as UserHero,
  CodeBracketIcon,
  CommandLineIcon,
  RocketLaunchIcon,
  BoltIcon,
  FireIcon,
  HeartIcon,
  StarIcon,
  MoonIcon,
  SunIcon,
  CubeIcon,
  BeakerIcon
} from '@heroicons/react/24/solid'
import type { UserIcon } from '../../store/user-store'
import { fieldInk, type PaletteKey } from '../../lib/brand-field'
import { BrandField } from './BrandField'

const ICON_MAP: Record<UserIcon, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  user: UserHero,
  code: CodeBracketIcon,
  terminal: CommandLineIcon,
  rocket: RocketLaunchIcon,
  bolt: BoltIcon,
  fire: FireIcon,
  heart: HeartIcon,
  star: StarIcon,
  moon: MoonIcon,
  sun: SunIcon,
  cube: CubeIcon,
  beaker: BeakerIcon
}

/**
 * The avatar: an Antasphere field with the chosen glyph over it.
 *
 * The field is the identity — the icon rides on it, knocked out in the field's
 * own ink (near-black over a light palette, creme over a dark one) with a soft
 * halo so it survives whichever hue happens to pool underneath. It used to be
 * the other way round, an icon tinted over a 20% wash of one flat colour, and
 * at 24px that read as a coloured square with something in it.
 */
export function UserIconDisplay({
  icon,
  field,
  seed,
  size = 'md'
}: {
  icon: UserIcon
  field: PaletteKey
  seed: number
  size?: 'xs' | 'sm' | 'md' | 'lg'
}): React.ReactElement {
  const Icon = ICON_MAP[icon] ?? UserHero
  const sizeClasses = {
    xs: 'w-8 h-8 rounded-lg',
    sm: 'w-8 h-8 rounded-lg',
    md: 'w-11 h-11 rounded-xl',
    lg: 'w-16 h-16 rounded-2xl'
  }
  const iconSizes = {
    xs: 'w-4 h-4',
    sm: 'w-4 h-4',
    md: 'w-5 h-5',
    lg: 'w-7 h-7'
  }
  const ink = fieldInk(field)
  const light = ink === '#1C1915'

  return (
    <div
      className={`${sizeClasses[size]} relative flex-shrink-0 overflow-hidden isolate`}
      style={{ boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.18)' }}
    >
      <BrandField palette={field} seed={seed} className="absolute inset-0 w-full h-full" />
      <Icon
        className={`${iconSizes[size]} absolute inset-0 m-auto`}
        style={{
          color: ink,
          filter: light
            ? 'drop-shadow(0 0 3px rgba(255,255,255,0.55))'
            : 'drop-shadow(0 0 3px rgba(0,0,0,0.45))'
        }}
      />
    </div>
  )
}

export { ICON_MAP }

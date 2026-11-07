import type { GroupTerminalIcon } from '../../store/session-store'
import {
  CommandLineIcon,
  FireIcon,
  BoltIcon,
  RocketLaunchIcon,
  EyeIcon,
  GlobeAltIcon,
  CubeIcon,
  HeartIcon,
  StarIcon,
  UserIcon,
  ShieldCheckIcon,
  WrenchIcon,
  BeakerIcon,
  CpuChipIcon,
  SignalIcon,
  BugAntIcon,
  SparklesIcon,
  CloudIcon
} from '@heroicons/react/24/outline'

export const ICON_COMPONENTS: Record<
  GroupTerminalIcon,
  React.ComponentType<React.SVGProps<SVGSVGElement>>
> = {
  terminal: CommandLineIcon,
  fire: FireIcon,
  bolt: BoltIcon,
  rocket: RocketLaunchIcon,
  eye: EyeIcon,
  globe: GlobeAltIcon,
  cube: CubeIcon,
  heart: HeartIcon,
  star: StarIcon,
  user: UserIcon,
  shield: ShieldCheckIcon,
  wrench: WrenchIcon,
  beaker: BeakerIcon,
  cpu: CpuChipIcon,
  signal: SignalIcon,
  bug: BugAntIcon,
  sparkles: SparklesIcon,
  cloud: CloudIcon
}

export function getTerminalIconComponent(
  icon?: GroupTerminalIcon
): React.ComponentType<React.SVGProps<SVGSVGElement>> {
  return ICON_COMPONENTS[icon ?? 'terminal'] ?? CommandLineIcon
}

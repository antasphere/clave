import * as HeroIcons from '@heroicons/react/24/outline'

/** A manifest names its icon as a Heroicon export ("HandRaisedIcon"), the convention the
 *  app itself follows. The namespace import is deliberate: the name comes from a file on
 *  disk, so nothing can be resolved at build time, and an unknown name must not blank the
 *  contribution — it falls back to the puzzle piece rather than rendering nothing. */
export function PluginIcon({
  name,
  className = 'w-4 h-4'
}: {
  name: string
  className?: string
}): React.JSX.Element {
  const icons = HeroIcons as unknown as Record<
    string,
    ((props: { className?: string }) => React.JSX.Element) | undefined
  >
  const Icon = icons[name] ?? HeroIcons.PuzzlePieceIcon
  return <Icon className={className} />
}

import { SwatchIcon } from '@heroicons/react/24/outline'
import { useSkinStore, skinAction } from '../../lib/skin'

export function ThemeToggle(): React.JSX.Element {
  const { skins, activeId } = useSkinStore()
  const bundled = skins.filter((skin) => skin.bundled)
  const next = bundled[(bundled.findIndex((skin) => skin.id === activeId) + 1) % bundled.length]
  return (
    <button
      className="btn-icon btn-icon-md"
      title={`Switch to ${next.name}`}
      onClick={() => void skinAction(() => window.electronAPI.skinsActivate(next.id))}
    >
      <SwatchIcon className="w-4 h-4" />
    </button>
  )
}

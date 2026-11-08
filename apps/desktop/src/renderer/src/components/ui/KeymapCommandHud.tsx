import type { CommandHud } from '../../hooks/use-keymap-manager'

export function KeymapCommandHud({ hud }: { hud: CommandHud | null }): React.JSX.Element | null {
  if (!hud) return null
  return (
    <div className="keymap-command-hud menu-surface menu-pop-mount" data-state={hud.state}>
      {hud.text}
    </div>
  )
}

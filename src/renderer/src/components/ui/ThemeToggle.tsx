import { ThemeToggle as UIThemeToggle } from '@clave/ui/components'
import { useSessionStore } from '../../store/session-store'

export function ThemeToggle(): React.JSX.Element {
  const theme = useSessionStore((s) => s.theme)
  const setTheme = useSessionStore((s) => s.setTheme)
  return <UIThemeToggle theme={theme} setTheme={setTheme} />
}

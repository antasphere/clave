import { useFullScreen } from './use-fullscreen'

/**
 * Whether macOS is drawing its traffic lights INSIDE this window's own chrome
 * right now — the one question the app's top-left chrome is laid out around.
 *
 * Two conditions, and both are about a hole. On macOS the window is
 * `titleBarStyle: 'hiddenInset'` (apps/desktop/src/main/index.ts), so the three buttons are
 * painted over our first rows and the chrome under them has to stand back. In
 * FULLSCREEN macOS takes them away, and clearance held for buttons that are not
 * there reads as the mark shoved into the middle of the strip. On Windows and
 * Linux the window keeps its native frame: the controls live above our content,
 * never over it, so that clearance is a hole from the very first paint — which
 * is why this is not `!fullScreen` alone.
 *
 * `platform` comes across the bridge as a constant, so this is one boolean the
 * first render already knows; only fullscreen moves after mount.
 */
export function useTrafficLights(): boolean {
  const fullScreen = useFullScreen()
  return window.electronAPI?.platform === 'darwin' && !fullScreen
}

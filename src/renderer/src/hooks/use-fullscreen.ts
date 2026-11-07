import { useEffect, useState } from 'react'

/**
 * Whether THIS window is in macOS fullscreen.
 *
 * The one thing it is for: in fullscreen the traffic lights are gone, so chrome
 * that was holding clearance for them is holding a hole. Read it through
 * `useTrafficLights()` rather than directly — fullscreen is only half of that
 * question, since Windows and Linux never put the buttons over our content at
 * all. Asked once on mount (a window can be restored straight into fullscreen,
 * and the event only fires on a change) and then kept by the main-process
 * event, which is sent to one window rather than broadcast — fullscreen is a
 * window's state, not the app's, and two windows are rarely in the same one.
 */
export function useFullScreen(): boolean {
  const [fullScreen, setFullScreen] = useState(false)

  useEffect(() => {
    let alive = true
    window.electronAPI?.windowIsFullScreen?.().then((value) => {
      if (alive) setFullScreen(value)
    })
    const off = window.electronAPI?.onWindowFullScreenChanged?.(setFullScreen)
    return () => {
      alive = false
      off?.()
    }
  }, [])

  return fullScreen
}

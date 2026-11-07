import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ClaveMark } from './ClaveMark'

/**
 * "Clave is here" overlay shown while macOS Mission Control is active, so the
 * window is recognizable among the Exposé thumbnails (like Granola).
 * Driven by mission-control:entered/exited pushed from the main process.
 */
export function MissionControlOverlay(): ReactNode {
  const [active, setActive] = useState(false)

  useEffect(() => {
    if (!window.electronAPI?.onMissionControlEntered) return
    return window.electronAPI.onMissionControlEntered(() => setActive(true))
  }, [])

  useEffect(() => {
    if (!window.electronAPI?.onMissionControlExited) return
    return window.electronAPI.onMissionControlExited(() => setActive(false))
  }, [])

  // Clicking our thumbnail focuses the window — hide immediately.
  useEffect(() => {
    const hide = (): void => setActive(false)
    window.addEventListener('focus', hide)
    return () => window.removeEventListener('focus', hide)
  }, [])

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
          transition={{ duration: 0.2 }}
          aria-hidden
          className="fixed inset-0 z-[9990] flex items-center justify-center pointer-events-none select-none bg-surface-0/50 backdrop-blur-[2px]"
        >
          <ClaveMark className="w-48 h-48" />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

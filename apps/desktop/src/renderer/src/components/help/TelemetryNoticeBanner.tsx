import { useState, useEffect, type ReactNode } from 'react'
import { ShieldCheckIcon } from '@heroicons/react/24/outline'

/** One-time notice about the anonymous daily usage ping (see packages/host/src/telemetry.ts). */
export function TelemetryNoticeBanner(): ReactNode {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function check(): Promise<void> {
      try {
        const state = await window.electronAPI.telemetryGetState()
        if (!cancelled && !state.noticeShown && state.enabled) {
          setVisible(true)
        }
      } catch {
        // Silently fail — never block the sidebar on telemetry state
      }
    }
    check()
    return () => {
      cancelled = true
    }
  }, [])

  function dismiss(): void {
    setVisible(false)
    window.electronAPI?.telemetrySetNoticeShown()
  }

  function turnOff(): void {
    setVisible(false)
    window.electronAPI?.telemetrySetEnabled(false)
    window.electronAPI?.telemetrySetNoticeShown()
  }

  if (!visible) return null

  return (
    <div>
      <div className="px-2.5 py-2 rounded-xl bg-accent/8 border border-accent/15">
        <div className="flex items-start gap-2">
          <ShieldCheckIcon className="w-3.5 h-3.5 text-accent flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <span className="text-[12px] font-medium text-text-primary">Anonymous usage ping</span>
            <p className="text-[11px] text-text-secondary mt-0.5 leading-relaxed">
              Clave sends one anonymous ping a day — a random ID, the app version, and your platform
              — so we know how many people use it. Nothing else is collected, ever.
            </p>
            <div className="flex items-center gap-3 mt-1">
              <button
                onClick={dismiss}
                className="text-[11px] text-accent hover:text-accent-hover font-medium"
              >
                OK
              </button>
              <button
                onClick={turnOff}
                className="text-[11px] text-text-tertiary hover:text-text-secondary font-medium"
              >
                Turn off
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

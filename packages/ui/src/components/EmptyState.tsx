import type { ReactNode } from 'react'

export function EmptyState({ action }: { action?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-center animate-fade-in">
        {/* Terminal icon */}
        <div className="p-4 rounded-2xl bg-surface-100">
          <svg
            width="32"
            height="32"
            viewBox="0 0 32 32"
            fill="none"
            className="text-text-tertiary"
          >
            <rect x="2" y="4" width="28" height="24" rx="4" stroke="currentColor" strokeWidth="2" />
            <path
              d="M8 12l4 4-4 4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <line
              x1="16"
              y1="20"
              x2="22"
              y2="20"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </div>

        <div>
          <h3 className="text-sm font-medium text-text-primary mb-1">No active sessions</h3>
          <p className="text-xs text-text-tertiary mb-4">
            Open a project folder to start a session
          </p>
        </div>

        <div className="w-48">{action}</div>
      </div>
    </div>
  )
}

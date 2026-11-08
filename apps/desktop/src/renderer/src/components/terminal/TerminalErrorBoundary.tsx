import { Component, type ReactNode } from 'react'

interface Props {
  sessionId: string
  children: ReactNode
}

interface State {
  hasError: boolean
  error: string | null
}

export class TerminalErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error: error.message }
  }

  componentDidCatch(error: Error): void {
    console.error(`Terminal error [${this.props.sessionId}]:`, error)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full bg-surface-0 text-text-tertiary gap-2 p-4">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
            <path d="M12 8v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="12" cy="16" r="1" fill="currentColor" />
          </svg>
          <span className="text-xs">Terminal failed to load</span>
          <span className="text-xs text-text-tertiary/60 max-w-xs text-center truncate">
            {this.state.error}
          </span>
        </div>
      )
    }
    return this.props.children
  }
}

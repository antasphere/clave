import type React from 'react'
import { ArrowDownIcon } from '@heroicons/react/24/outline'

/** The way back down, over the transcript's foot while the end is out of view. */
export function JumpToEnd({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="chat-jump-end menu-pop-mount"
      aria-label="Scroll to end"
      title="Scroll to end"
      onClick={onClick}
    >
      <ArrowDownIcon />
    </button>
  )
}

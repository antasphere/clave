import type React from 'react'

/** A keycap beside a button: the key that presses it. Hidden from the
 *  accessible name, which stays the button's own words. Shared by the
 *  question card and the permission prompt. */
export function Key({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="chat-prompt-key" aria-hidden="true">
      {children}
    </kbd>
  )
}

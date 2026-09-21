import { useState, useCallback, useRef, useEffect } from 'react'
import { ArrowUpIcon } from '@heroicons/react/24/outline'

interface ChatInputProps {
  onSend: (content: string) => void
  disabled?: boolean
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }, [value])

  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setValue('')
  }, [value, disabled, onSend])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  return (
    <div className="px-4 pb-4 pt-2 mx-auto w-full max-w-2xl">
      <div className="flex flex-col gap-2 bg-surface-0 border border-border rounded-3xl px-4 py-3 focus-within:border-border transition-colors">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a message..."
          disabled={disabled}
          rows={1}
          className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none resize-none max-h-40 leading-relaxed"
        />
        <div className="flex items-center justify-end">
          <button
            onClick={handleSend}
            disabled={!value.trim() || disabled}
            aria-label="Send message"
            className="flex items-center justify-center w-7 h-control-md rounded-full bg-accent text-white hover:bg-accent-hover disabled:opacity-30 disabled:hover:bg-accent transition-colors flex-shrink-0"
          >
            <ArrowUpIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

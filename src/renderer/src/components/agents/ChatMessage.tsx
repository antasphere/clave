import { memo } from 'react'
import { MarkdownRenderer } from '../files/MarkdownRenderer'
import type { ChatMessage as ChatMessageType } from '../../../../shared/remote-types'

interface ChatMessageProps {
  message: ChatMessageType
}

function ChatMessageImpl({ message }: ChatMessageProps): React.JSX.Element {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  if (isSystem) {
    return (
      <div className="flex justify-center py-2">
        <span className="badge bg-surface-100 text-text-tertiary px-3 py-1">{message.content}</span>
      </div>
    )
  }

  // User: compact rounded bubble, right-aligned. Assistant: no box, plain text full width.
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-surface-100 px-4 py-2.5 text-sm text-text-primary">
          <p className="whitespace-pre-wrap">{message.content}</p>
          {message.status === 'error' && (
            <span className="text-xs text-red-400 mt-1 block">Failed to send</span>
          )}
        </div>
      </div>
    )
  }

  const isStreaming = message.status === 'streaming'

  return (
    <div className="text-sm text-text-primary">
      <div className="prose-sm">
        {/* While streaming, render plain text — re-parsing the full markdown and
            re-running syntax highlighting on every delta is O(n²) and janks long
            answers. The markdown/shiki pipeline runs once when the turn completes. */}
        {isStreaming ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <MarkdownRenderer content={message.content} />
        )}
      </div>
      {isStreaming && (
        <span className="inline-block w-1.5 h-4 bg-current opacity-60 animate-pulse ml-0.5 align-text-bottom" />
      )}
      {message.status === 'error' && (
        <span className="text-xs text-red-400 mt-1 block">Failed to send</span>
      )}
    </div>
  )
}

// Only re-render when this message's own content/status changes, so streaming
// deltas to the in-flight message don't re-render every other message.
export const ChatMessage = memo(ChatMessageImpl, (prev, next) => {
  return (
    prev.message.content === next.message.content &&
    prev.message.status === next.message.status &&
    prev.message.role === next.message.role
  )
})

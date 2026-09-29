import { useAgentStore } from '../../store/agent-store'
import { useAgentChat } from '../../hooks/use-agent-chat'
import { AgentHeader } from './AgentHeader'
import { ChatMessage } from './ChatMessage'
import { ChatInput } from './ChatInput'
import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline'

export function AgentChatPanel(): React.JSX.Element {
  const activeAgentId = useAgentStore((s) => s.activeAgentId)
  const agent = useAgentStore((s) => s.agents.find((a) => a.id === activeAgentId))
  const { messages, sendMessage, scrollRef } = useAgentChat(activeAgentId)

  if (!agent) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <ChatBubbleLeftRightIcon className="w-12 h-12 text-text-tertiary mx-auto mb-3" />
          <p className="text-sm text-text-tertiary">Select an agent to start chatting</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <AgentHeader />
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-text-tertiary">Start a conversation with {agent.name}</p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6">
            {messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} />
            ))}
          </div>
        )}
      </div>
      <ChatInput
        onSend={sendMessage}
        disabled={agent.status === 'offline' || agent.status === 'error'}
      />
    </div>
  )
}

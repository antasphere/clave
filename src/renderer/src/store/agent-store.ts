import { create } from 'zustand'
import type {
  Agent,
  AgentStatus,
  ChatMessage,
  ChatMessageStatus
} from '../../../shared/remote-types'

interface AgentState {
  agents: Agent[]
  activeAgentId: string | null
  messages: Record<string, ChatMessage[]>
  loadAgents: (locationId: string) => Promise<void>
  loadHistory: (locationId: string, agentIds: string[]) => Promise<void>
  setAgents: (locationId: string, agents: Agent[]) => void
  setMessages: (agentId: string, messages: ChatMessage[]) => void
  setActiveAgent: (id: string | null) => void
  addMessage: (agentId: string, message: ChatMessage) => void
  updateMessageStatus: (agentId: string, messageId: string, status: ChatMessageStatus) => void
  appendMessageContent: (agentId: string, messageId: string, content: string) => void
  setAgentStatus: (agentId: string, status: AgentStatus) => void
  clearMessages: (agentId: string) => void
}

export const useAgentStore = create<AgentState>((set) => ({
  agents: [],
  activeAgentId: null,
  messages: {},

  loadAgents: async (locationId) => {
    if (!window.electronAPI?.agentList) return
    await window.electronAPI.agentList(locationId)
  },

  loadHistory: async (locationId, agentIds) => {
    if (!window.electronAPI?.agentChatHistory) return

    for (const agentId of agentIds) {
      const sessionKey = `agent:${agentId}:main`
      try {
        const history = (await window.electronAPI.agentChatHistory(locationId, sessionKey)) as {
          messages?: Array<{
            role?: string
            content?: Array<{ type?: string; text?: string; thinking?: string }>
            timestamp?: number
          }>
        }
        if (!history?.messages?.length) continue

        const chatMessages: ChatMessage[] = history.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => {
            // Content is an array of blocks — extract text blocks only
            const content = Array.isArray(m.content)
              ? m.content
                  .filter((b) => b.type === 'text' && b.text)
                  .map((b) => b.text!)
                  .join('\n')
              : ''
            return {
              id: crypto.randomUUID(),
              agentId,
              role: m.role as 'user' | 'assistant',
              content,
              timestamp: m.timestamp || Date.now(),
              status: 'delivered' as const
            }
          })
          .filter((m) => m.content.length > 0)

        if (chatMessages.length > 0) {
          set((s) => ({
            messages: { ...s.messages, [agentId]: chatMessages }
          }))
        }
      } catch {
        // Failed to load history for this agent — skip
      }
    }
  },

  setAgents: (locationId, agents) => {
    set((s) => {
      // Merge: replace agents for this location, keep others
      const otherAgents = s.agents.filter((a) => a.locationId !== locationId)
      return { agents: [...otherAgents, ...agents] }
    })
  },

  setMessages: (agentId, messages) => {
    set((s) => ({
      messages: { ...s.messages, [agentId]: messages }
    }))
  },

  setActiveAgent: (id) => set({ activeAgentId: id }),

  addMessage: (agentId, message) => {
    set((s) => ({
      messages: {
        ...s.messages,
        [agentId]: [...(s.messages[agentId] || []), message]
      }
    }))
  },

  updateMessageStatus: (agentId, messageId, status) => {
    set((s) => ({
      messages: {
        ...s.messages,
        [agentId]: (s.messages[agentId] || []).map((m) =>
          m.id === messageId ? { ...m, status } : m
        )
      }
    }))
  },

  appendMessageContent: (agentId, messageId, content) => {
    set((s) => ({
      messages: {
        ...s.messages,
        [agentId]: (s.messages[agentId] || []).map((m) =>
          m.id === messageId ? { ...m, content: m.content + content } : m
        )
      }
    }))
  },

  setAgentStatus: (agentId, status) => {
    set((s) => ({
      agents: s.agents.map((a) => (a.id === agentId ? { ...a, status } : a))
    }))
  },

  clearMessages: (agentId) => {
    set((s) => ({
      messages: { ...s.messages, [agentId]: [] }
    }))
  }
}))

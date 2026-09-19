import { useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useAgentStore } from '../../store/agent-store'
import { useLocationStore } from '../../store/location-store'
import { useSessionStore } from '../../store/session-store'
import { cn } from '@clave/ui/components'
import { CheckIcon } from '@heroicons/react/24/outline'

const statusColors: Record<string, string> = {
  online: 'bg-green-500',
  offline: 'bg-gray-400',
  busy: 'bg-amber-500',
  error: 'bg-red-500'
}

interface AgentPickerPopoverProps {
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
}

export function AgentPickerPopover({ anchorRef, onClose }: AgentPickerPopoverProps) {
  const agents = useAgentStore((s) => s.agents)
  const locations = useLocationStore((s) => s.locations)
  const sessions = useSessionStore((s) => s.sessions)
  const menuRef = useRef<HTMLDivElement>(null)

  const handleAgentClick = useCallback(
    (agent: typeof agents[0], locationId: string) => {
      const sessionId = `agent-${locationId}-${agent.id}`

      // Set the active agent for the chat panel
      useAgentStore.getState().setActiveAgent(agent.id)

      // Ensure agent session exists
      const store = useSessionStore.getState()
      if (!store.sessions.some((s) => s.id === sessionId)) {
        store.addAgentSession(agent, locationId)
      }

      // Select the session (sets activeView to 'agents' for agent sessions)
      useSessionStore.getState().selectSession(sessionId, false)

      onClose()
    },
    [onClose]
  )

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  // Group agents by location, deduplicate by agent id globally
  // (same Mac Mini may appear under multiple locationIds due to reconnects)
  const agentsByLocation = new Map<string, typeof agents>()
  const seenAgentIds = new Set<string>()
  for (const agent of agents) {
    if (seenAgentIds.has(agent.id)) continue
    seenAgentIds.add(agent.id)
    const list = agentsByLocation.get(agent.locationId) || []
    list.push(agent)
    agentsByLocation.set(agent.locationId, list)
  }
  // Merge location groups that share the same name
  const locationGroups: Array<{ locationId: string; name: string; agents: typeof agents }> = []
  const seenLocationNames = new Map<string, number>()
  for (const [locationId, locationAgents] of agentsByLocation) {
    const location = locations.find((l) => l.id === locationId)
    const name = location?.name ?? 'Unknown'
    const existingIdx = seenLocationNames.get(name)
    if (existingIdx !== undefined) {
      // Merge into existing group, skip agents already added
      const existing = locationGroups[existingIdx]
      for (const agent of locationAgents) {
        if (!existing.agents.some((a) => a.id === agent.id)) {
          existing.agents.push(agent)
        }
      }
    } else {
      seenLocationNames.set(name, locationGroups.length)
      locationGroups.push({ locationId, name, agents: [...locationAgents] })
    }
  }

  if (agents.length === 0) {
    return createPortal(
      <div
        ref={menuRef}
        className="menu-surface menu-pop-mount fixed z-50 min-w-[220px] py-3 px-3"
        style={{
          top: (anchorRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
          left: anchorRef.current?.getBoundingClientRect().left ?? 0
        }}
      >
        <p className="text-[13px] text-text-tertiary text-center">
          No connected locations have agents.
          <br />
          Connect a location in Settings.
        </p>
      </div>,
      document.body
    )
  }

  return createPortal(
    <div
      ref={menuRef}
      className="menu-surface menu-pop-mount fixed z-50 min-w-[220px] flex flex-col"
      style={{
        top: (anchorRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
        left: anchorRef.current?.getBoundingClientRect().left ?? 0
      }}
    >
      <div className="max-h-[50vh] overflow-y-auto p-1">
      {locationGroups.map((group) => {
        return (
          <div key={group.locationId}>
            <div className="menu-label">
              {group.name}
            </div>
            {group.agents.map((agent) => {
              const sessionId = `agent-${agent.locationId}-${agent.id}`
              const inSidebar = sessions.some((s) => s.id === sessionId)
              return (
                <button
                  key={agent.id}
                  onClick={() => handleAgentClick(agent, agent.locationId)}
                  className="menu-item"
                >
                  <div
                    className={cn(
                      'w-2 h-2 rounded-full flex-shrink-0',
                      statusColors[agent.status] || 'bg-gray-400'
                    )}
                  />
                  <span className="flex-1 text-left truncate">{agent.name}</span>
                  {inSidebar ? (
                    <CheckIcon className="w-3.5 h-3.5 text-accent flex-shrink-0" />
                  ) : (
                    <span className="text-[11px] text-text-tertiary flex-shrink-0">Add</span>
                  )}
                </button>
              )
            })}
          </div>
        )
      })}
      </div>
    </div>,
    document.body
  )
}

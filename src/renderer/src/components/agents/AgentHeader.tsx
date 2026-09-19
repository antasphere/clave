import { useAgentStore } from '../../store/agent-store'
import { useLocationStore } from '../../store/location-store'
import { cn } from '@clave/ui/components'

const statusColors: Record<string, string> = {
  online: 'bg-green-500',
  offline: 'bg-gray-400',
  busy: 'bg-amber-500',
  error: 'bg-red-500'
}

export function AgentHeader() {
  const activeAgentId = useAgentStore((s) => s.activeAgentId)
  const agent = useAgentStore((s) => s.agents.find((a) => a.id === activeAgentId))
  const location = useLocationStore((s) => s.locations.find((l) => l.id === agent?.locationId))

  if (!agent) return null

  return (
    <div className="h-12 flex items-center gap-3 px-4 border-b border-border-subtle flex-shrink-0">
      <div className={cn('w-2 h-2 rounded-full flex-shrink-0', statusColors[agent.status] || 'bg-gray-400')} />
      <span className="text-sm font-medium text-text-primary truncate">{agent.name}</span>
      {agent.model && (
        <span className="text-xs text-text-tertiary">{agent.model}</span>
      )}
      {location && location.type === 'remote' && (
        <span className="badge ml-auto bg-surface-100 text-text-tertiary">
          {location.name}
        </span>
      )}
    </div>
  )
}

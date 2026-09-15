import { useEffect, useState } from 'react'
import { useLocationStore } from '../../store/location-store'
import { AddLocationDialog } from './AddLocationDialog'
import {
  PlusIcon,
  TrashIcon,
  ArrowPathIcon,
  SignalIcon,
  SignalSlashIcon
} from '@heroicons/react/24/outline'
import { SettingsSection, SettingsCard } from './primitives'
import type { Location } from '../../../../shared/remote-types'

const statusLabels: Record<string, string> = {
  connected: 'Connected',
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  error: 'Error'
}

function LocationCard({ location }: { location: Location }): React.JSX.Element {
  const removeLocation = useLocationStore((s) => s.removeLocation)
  const setLocationStatus = useLocationStore((s) => s.setLocationStatus)
  const isLocal = location.type === 'local'
  const status = statusLabels[location.status] ? location.status : 'disconnected'

  const handleConnect = async (): Promise<void> => {
    if (location.status === 'connected') {
      // Disconnect OpenClaw + SSH
      try {
        await window.electronAPI.agentDisconnect(location.id)
      } catch {
        /* ok */
      }
      await window.electronAPI.sshDisconnect(location.id)
      setLocationStatus(location.id, 'disconnected')
    } else {
      setLocationStatus(location.id, 'connecting')
      try {
        await window.electronAPI.sshConnect(location.id)
        setLocationStatus(location.id, 'connected')
        // Connect OpenClaw WebSocket for agents if location has openclawPort
        if (location.openclawPort && location.host) {
          try {
            await window.electronAPI.agentConnect(location.id)
            await window.electronAPI.agentList(location.id)
          } catch {
            /* OpenClaw not available — SSH still works */
          }
        }
      } catch {
        setLocationStatus(location.id, 'error')
      }
    }
  }

  return (
    <div className="settings-row">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="settings-row-title truncate">{location.name}</span>
          {isLocal && (
            <span className="badge badge-uppercase bg-surface-200 text-text-tertiary">Local</span>
          )}
        </div>
        {location.host && (
          <span className="settings-row-description">
            {location.username}@{location.host}:{location.port || 22}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <span className="status-text" data-status={status}>
          {statusLabels[status]}
        </span>
        {!isLocal && (
          <>
            <button
              onClick={handleConnect}
              className="btn-icon btn-icon-sm"
              title={location.status === 'connected' ? 'Disconnect' : 'Connect'}
              aria-label={location.status === 'connected' ? 'Disconnect' : 'Connect'}
            >
              {location.status === 'connected' ? (
                <SignalSlashIcon className="w-4 h-4" />
              ) : location.status === 'connecting' ? (
                <ArrowPathIcon className="w-4 h-4 animate-spin" />
              ) : (
                <SignalIcon className="w-4 h-4" />
              )}
            </button>
            <button
              onClick={() => removeLocation(location.id)}
              className="btn-icon btn-icon-sm btn-icon--danger"
              title="Remove location"
              aria-label="Remove location"
            >
              <TrashIcon className="w-4 h-4" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export function LocationsTab(): React.JSX.Element {
  const locations = useLocationStore((s) => s.locations)
  const loaded = useLocationStore((s) => s.loaded)
  const loadLocations = useLocationStore((s) => s.loadLocations)
  const [showAddDialog, setShowAddDialog] = useState(false)

  useEffect(() => {
    if (!loaded) loadLocations()
  }, [loaded, loadLocations])

  return (
    <SettingsSection
      title="Locations"
      description="The machines a terminal or an agent can run on: this Mac, and any remote reached over SSH."
    >
      <SettingsCard>
        {locations.map((loc) => (
          <LocationCard key={loc.id} location={loc} />
        ))}

        <button onClick={() => setShowAddDialog(true)} className="settings-row-action">
          <PlusIcon className="w-4 h-4" />
          Add Location
        </button>
      </SettingsCard>

      {showAddDialog && <AddLocationDialog onClose={() => setShowAddDialog(false)} />}
    </SettingsSection>
  )
}

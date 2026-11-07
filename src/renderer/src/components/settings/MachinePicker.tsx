import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import { useFleetStore } from '../../store/fleet-store'
import { useSettingsMachineStore } from '../../store/settings-machine-store'
import { describeServerState } from '../../lib/server-connection-text'
import { SettingsSelect } from './primitives'

/**
 * Which machine the Agents group of Settings shows: this Mac, or a saved
 * Clave server. One picker at the top of the group rather than a page per
 * server, so a server's accounts and usage read exactly as this Mac's do.
 * Drawn only once a server is saved: with none, the group is this Mac's and
 * a choice of one is no choice.
 */
export function MachinePicker(): React.JSX.Element | null {
  const connections = useFleetStore((s) => s.connections)
  const statuses = useFleetStore((s) => s.statuses)
  const machine = useSettingsMachineStore((s) => s.machine)
  const setMachine = useSettingsMachineStore((s) => s.setMachine)
  if (connections.length === 0) return null
  const options = [
    { value: LOCAL_SERVER_ID, label: 'This Mac' },
    ...connections.map((connection) => ({
      value: connection.id,
      label: connection.name,
      hint: describeServerState(statuses[connection.id], connection.enabled).label
    }))
  ]
  return (
    <div className="px-1 pb-1.5" data-settings-machine-picker>
      <SettingsSelect
        value={options.some((o) => o.value === machine) ? machine : LOCAL_SERVER_ID}
        options={options}
        onChange={setMachine}
        ariaLabel="Machine shown by the Agents pages"
        className="w-full"
        testId="settings-machine"
      />
    </div>
  )
}

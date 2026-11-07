import { resourceKey } from '@clave/contract/fleet'
import { ArrowPathIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { useWorkspaceStore } from '../../store/workspace-store'
import { changePairing, usePairingStore } from '../../store/pairing-store'
import { SettingsRow, Toggle } from '../settings/primitives'

/**
 * Settings, Servers, one row per server (PRDCT-4151): the switch that lets
 * this server's tabs show inside the Mac workspaces paired with its own, and
 * the pairings recorded on this Mac, each with its way out. Off is how a
 * server behaved before any pairing: its tabs in its own workspaces only.
 */
export function ServerCombineRow({ id }: { id: string }): React.JSX.Element {
  const pairing = usePairingStore((s) => s.servers[id])
  const serverWorkspaces = useWorkspaceStore((s) => s.serverWorkspaces[id])
  const localWorkspaces = useWorkspaceStore((s) => s.workspaces)
  const on = pairing?.combine === true
  const pairs = Object.entries(pairing?.pairs ?? {}).map(([raw, localId]) => ({
    raw,
    server:
      serverWorkspaces?.find((w) => w.id === resourceKey('workspace', id, raw))?.name ??
      'a workspace the server no longer lists',
    local: localWorkspaces.find((w) => w.id === localId)?.name ?? 'a removed workspace'
  }))
  const declined = (pairing?.declined ?? []).map((raw) => ({
    raw,
    server:
      serverWorkspaces?.find((w) => w.id === resourceKey('workspace', id, raw))?.name ??
      'a workspace the server no longer lists'
  }))
  const label = "Show this server's tabs in my matching local workspace"
  return (
    <div data-server-combine={id} data-combine={on ? 'on' : 'off'}>
      <SettingsRow
        label={label}
        description={
          on
            ? 'A workspace of this server paired with a workspace of this Mac (the same git remote, confirmed once) shows its tabs there too, badged with the server’s name. The server’s own workspace keeps showing only its tabs.'
            : 'Off, this server’s tabs show only in its own workspaces, and Clave proposes no pairing for it. On, a workspace of this server that is the same tree as one of this Mac’s (the same git remote) is offered as a pairing, confirmed once.'
        }
        tags={
          pairs.length > 0 || declined.length > 0 ? (
            <>
              {declined.map((entry) => (
                <span
                  key={`declined:${entry.raw}`}
                  className="badge badge-muted"
                  data-server-declined={entry.raw}
                  title="You answered Not now to this pairing"
                >
                  {entry.server} · not paired
                  <button
                    type="button"
                    className="btn-icon btn-icon-xs"
                    aria-label={`Ask again about ${entry.server}`}
                    title="Propose this pairing again"
                    onClick={() =>
                      void changePairing({
                        kind: 'ask-again',
                        serverId: id,
                        serverWorkspaceId: entry.raw
                      })
                    }
                  >
                    <ArrowPathIcon className="w-3 h-3" />
                  </button>
                </span>
              ))}
              {pairs.map((pair) => (
                <span key={pair.raw} className="badge badge-muted" data-server-pair={pair.raw}>
                  {pair.server} · {pair.local}
                  <button
                    type="button"
                    className="btn-icon btn-icon-xs"
                    aria-label={`Forget the pairing of ${pair.server}`}
                    title="Forget this pairing"
                    onClick={() =>
                      void changePairing({
                        kind: 'forget',
                        serverId: id,
                        serverWorkspaceId: pair.raw
                      })
                    }
                  >
                    <XMarkIcon className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </>
          ) : undefined
        }
      >
        <Toggle
          checked={on}
          onChange={(value) => void changePairing({ kind: 'combine', serverId: id, on: value })}
          ariaLabel={label}
        />
      </SettingsRow>
    </div>
  )
}

import { useState } from 'react'
import { useFleetStore } from '../../store/fleet-store'
import { findWorkspace, useWorkspaceStore } from '../../store/workspace-store'
import { confirmProposal, declineProposal, usePairingStore } from '../../store/pairing-store'

/**
 * Clave proposes, the person confirms once (PRDCT-4151): over the stage of
 * a Mac workspace, when a connected server holds a workspace that is the same
 * tree (the same git remote), the offer to show that server's tabs here,
 * badged. "Not now" is remembered for that server workspace; the switch in
 * Settings, Servers turns the whole thing off for a server.
 */
export function WorkspacePairingNotice(): React.JSX.Element | null {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const proposal = usePairingStore((s) =>
    s.proposals.find((p) => p.localWorkspaceId === activeWorkspaceId)
  )
  const serverName = useFleetStore(
    (s) => s.connections.find((c) => c.id === proposal?.serverId)?.name ?? 'The server'
  )
  const serverWorkspace = useWorkspaceStore((s) => findWorkspace(s, proposal?.serverWorkspaceId))
  const [busy, setBusy] = useState(false)
  if (!proposal || !serverWorkspace) return null
  const answer = (run: () => Promise<void>): void => {
    setBusy(true)
    void run().finally(() => setBusy(false))
  }
  return (
    <div className="stage-notice">
      <div
        className="settings-callout"
        data-tone="accent"
        role="status"
        data-testid="pairing-proposal"
        data-server-workspace={proposal.serverWorkspaceId}
      >
        <p className="settings-callout-title">
          Combine {serverName}&rsquo;s &ldquo;{serverWorkspace.name}&rdquo; with this workspace?
        </p>
        <p className="settings-callout-text">
          Both are checkouts of {proposal.remote}. {serverName}&rsquo;s tabs will show here, badged
          with its name, and new tabs still start on this Mac unless you pick {serverName} in the
          launcher. {serverName}&rsquo;s own workspace keeps showing only its tabs. You can turn
          this off for {serverName} in Settings, Servers.
        </p>
        <div className="settings-callout-actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => answer(() => declineProposal(proposal))}
          >
            Not now
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => answer(() => confirmProposal(proposal))}
          >
            Combine
          </button>
        </div>
      </div>
    </div>
  )
}

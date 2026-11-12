import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import {
  ArrowDownTrayIcon,
  ArrowTopRightOnSquareIcon,
  ChevronRightIcon
} from '@heroicons/react/24/outline'
import { HARNESSES, type Harness, type HarnessId } from '../../../../shared/harness'
import { CLAUDE_MODELS } from '../../../../shared/claude-models'
import type { AgentUpdateStatus } from '../../../../shared/agent-updates'
import type { InstallableAgentId, OnboardingInstallResult } from '../../../../shared/onboarding'
import type { ModelOption } from '../../../../shared/session-model'
import { useAgentUpdatesStore } from '../../store/agent-updates-store'
import { useLaunchSettingsStore } from '../../store/launch-settings-store'
import { useWorkspaceStore } from '../../store/workspace-store'
import { useSessionStore } from '../../store/session-store'
import { connectionsForModel } from '../../lib/switch-account'
import { harnessPresent } from '../../lib/harness-presence'
import { useLaunchProfileStore } from '../../store/launch-profile-store'
import { CONNECTION_COMPANY_BY_POOL } from './connection-companies'
import { AgentRow } from './AgentUpdatesSection'
import { LaunchProfilesFamily } from './AgentsSettings'
import {
  SettingsCallout,
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSelect,
  ToggleRow,
  type SelectOption
} from './primitives'

/** The select's value for "Default": no setting, the harness's own. */
const DEFAULT = '__default__'

/** The one-click installer of the first-run walk, over the four harnesses
 *  (`onboarding-handlers.ts` accepts the four). */
function installHarness(id: InstallableAgentId): Promise<OnboardingInstallResult> {
  return window.electronAPI.onboardingInstall(id)
}

/** The folder Codex is asked its models from: the active workspace's root,
 *  else the home folder the walk knows. */
async function modelsFolder(): Promise<string> {
  const { workspaces, activeWorkspaceId } = useWorkspaceStore.getState()
  const root = workspaces.find((w) => w.id === activeWorkspaceId)?.rootDir
  if (root) return root
  const state = await window.electronAPI.onboardingGetState?.().catch(() => null)
  return state?.home ?? '/'
}

/** Codex's models, asked of the CLI once when the row first draws. */
function useCodexModels(enabled: boolean): {
  models: ModelOption[] | null
  failed: boolean
} {
  const [models, setModels] = useState<ModelOption[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void (async () => {
      try {
        const list = await window.electronAPI.adaptersModels('codex-chat', await modelsFolder())
        if (cancelled) return
        if (Array.isArray(list) && list.length > 0) setModels(list)
        else setFailed(true)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled])
  return { models, failed }
}

/** The way to Settings → Connections, from a row that needs one. */
function ConnectionsLink({ harness }: { harness: Harness }): React.JSX.Element {
  return (
    <button
      className="btn-secondary"
      onClick={() => useSessionStore.getState().openSettings('accounts')}
      data-harness-connect={harness.id}
    >
      Connections
    </button>
  )
}

/**
 * Default model: what a click on the harness in the launcher runs, chosen
 * among the models the person's connections serve, the same list the
 * launcher offers on hover. A harness whose pool holds no usable connection
 * has no model to pick: the row says so and points at Connections. A
 * harness Clave holds no connection for yet (Pi) runs the model its own
 * config names; one that takes no model on its command line has no row.
 */
function DefaultModelRow({ harness }: { harness: Harness }): React.JSX.Element | null {
  const value = useLaunchSettingsStore((s) => s.harnesses[harness.id]?.preferredModel ?? '')
  const setHarness = useLaunchSettingsStore((s) => s.setHarness)
  const pool = harness.connectionPool
  const connected = pool !== null && connectionsForModel(pool, undefined).some((c) => c.usable)
  const codex = useCodexModels(harness.id === 'codex' && connected)
  if (!harness.takesModel) return null
  const write = (model: string | null): void =>
    void setHarness(harness.id, { preferredModel: model })
  const label = 'Default model'
  const description = `What a click on ${harness.name} in the launcher runs; hovering the row offers the others.`

  if (pool === null) {
    return (
      <SettingsRow
        label={label}
        description={`${harness.name} runs the model its own configuration names; Clave holds no connection for it yet.`}
      />
    )
  }
  if (!connected) {
    const company = CONNECTION_COMPANY_BY_POOL[pool].name
    return (
      <SettingsRow
        label={label}
        description={`Connect ${company} to pick one: the models offered are the ones your connections serve.`}
      >
        <ConnectionsLink harness={harness} />
      </SettingsRow>
    )
  }
  if (harness.id === 'codex' && codex.failed) {
    return (
      <SettingsRow
        label={label}
        description="Codex could not list its models from here; the launcher offers its default."
      />
    )
  }
  if (harness.id === 'codex' && !codex.models) {
    return (
      <SettingsRow label={label} description={description}>
        <span className="settings-row-value" data-harness-models-loading>
          Loading…
        </span>
      </SettingsRow>
    )
  }
  const listed: SelectOption<string>[] =
    harness.id === 'claude'
      ? CLAUDE_MODELS.filter((model) =>
          connectionsForModel('claude', model.id).some((c) => c.usable)
        ).map((model) => ({ value: model.id, label: model.name, hint: model.id }))
      : (codex.models ?? []).map((model) => ({
          value: model.id,
          label: model.label,
          hint: model.hint ?? model.id
        }))
  const known = !value || listed.some((option) => option.value === value)
  const options: SelectOption<string>[] = [
    { value: DEFAULT, label: 'Default', hint: "The harness's own" },
    ...listed,
    ...(known ? [] : [{ value, label: value }])
  ]
  return (
    <SettingsRow label={label} description={description}>
      <SettingsSelect<string>
        value={value || DEFAULT}
        options={options}
        onChange={(next) => write(next === DEFAULT ? null : next)}
        ariaLabel={`Default model for ${harness.name}`}
        testId={`harness-model-${harness.id}`}
      />
    </SettingsRow>
  )
}

/** Permissions: Default, then the harness's own ladder. None for a harness
 *  that never asks. */
function PermissionsRow({ harness }: { harness: Harness }): React.JSX.Element | null {
  const value = useLaunchSettingsStore((s) => s.harnesses[harness.id]?.permissionDefault ?? '')
  const setHarness = useLaunchSettingsStore((s) => s.setHarness)
  if (harness.permissionRungs.length === 0) return null
  const own = harness.defaultRung
    ? harness.permissionRungs.find((rung) => rung.id === harness.defaultRung)?.label
    : null
  return (
    <SettingsRow
      label="Permissions"
      description="What a new session may do without asking. One launch can still skip every prompt (Cmd+Y)."
    >
      <SettingsSelect<string>
        value={value || DEFAULT}
        options={[
          {
            value: DEFAULT,
            label: 'Default',
            hint: own ? `The harness's own: ${own}` : "The harness's own"
          },
          ...harness.permissionRungs.map((rung) => ({
            value: rung.id,
            label: rung.label,
            hint: rung.hint
          }))
        ]}
        onChange={(next) =>
          void setHarness(harness.id, { permissionDefault: next === DEFAULT ? null : next })
        }
        ariaLabel={`Permissions for ${harness.name}`}
        testId={`harness-permission-${harness.id}`}
      />
    </SettingsRow>
  )
}

type InstallState = { busy: boolean; result: { ok: boolean; message: string | null } | null }

function InstallAction({
  harness,
  state,
  onInstall
}: {
  harness: Harness
  state: InstallState
  onInstall: () => void
}): React.JSX.Element {
  if (!harness.install) {
    return (
      <>
        <span className="settings-row-value">Install it from its own page</span>
        <button
          className="btn-secondary"
          onClick={() => void window.electronAPI.openExternal(harness.docsUrl)}
          data-harness-docs={harness.id}
        >
          <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
          Open
        </button>
      </>
    )
  }
  return (
    <button
      className="btn-primary"
      onClick={onInstall}
      disabled={state.busy}
      title={harness.install}
      data-harness-install={harness.id}
    >
      <ArrowDownTrayIcon className="w-3.5 h-3.5" />
      {state.busy ? 'Installing…' : 'Install'}
    </button>
  )
}

/** One harness: its row (version, update, Install when missing), its two
 *  settings when it is there, and the Advanced fold with its launch profiles. */
function HarnessBlock({
  harness,
  status,
  autoUpdate
}: {
  harness: Harness
  status: AgentUpdateStatus | undefined
  autoUpdate: boolean
}): React.JSX.Element {
  const update = useAgentUpdatesStore((s) => s.update)
  const [open, setOpen] = useState(false)
  const [install, setInstall] = useState<InstallState>({ busy: false, result: null })
  // Missing only when a CHECK said so: before the first check main reports
  // every harness as not installed with no check time (the verifier's F4).
  // The selector answers the store's own array (a stable reference); the
  // filter runs outside it, or every read re-renders the page for good.
  const customProfiles = useLaunchProfileStore((s) => s.preferences.customProfiles)
  const missing = !harnessPresent(
    status,
    (customProfiles ?? []).filter((profile) => profile.family === harness.id)
  )

  const runInstall = async (): Promise<void> => {
    setInstall({ busy: true, result: null })
    try {
      const outcome = await installHarness(harness.id)
      setInstall({ busy: false, result: { ok: outcome.ok, message: outcome.message } })
      if (outcome.ok) void useAgentUpdatesStore.getState().check()
    } catch (error) {
      setInstall({
        busy: false,
        result: {
          ok: false,
          message: error instanceof Error ? error.message : 'The install failed.'
        }
      })
    }
  }

  const row: AgentUpdateStatus = status
    ? { ...status, name: harness.name }
    : {
        id: harness.id,
        name: harness.name,
        command: harness.command,
        installed: true,
        path: null,
        realPath: null,
        install: null,
        currentVersion: null,
        latestVersion: null,
        updateAvailable: false,
        phase: 'idle',
        lastCheckedAt: null,
        lastUpdatedAt: null,
        updatedFrom: null,
        heldBack: null,
        heldBackAt: null,
        note: null,
        error: null
      }

  return (
    <section data-harness={harness.id} data-harness-installed={missing ? 'false' : 'true'}>
      <SettingsCard>
        <AgentRow
          agent={row}
          autoUpdate={autoUpdate}
          onUpdate={() => void update(harness.id)}
          action={
            missing ? (
              <InstallAction
                harness={harness}
                state={install}
                onInstall={() => void runInstall()}
              />
            ) : undefined
          }
        />
        {install.result && (
          <SettingsCallout
            inset
            tone={install.result.ok ? 'accent' : 'danger'}
            text={
              install.result.ok
                ? `${harness.name} is installed.`
                : (install.result.message ?? 'The install failed.')
            }
          />
        )}
        {!missing && (
          <>
            <DefaultModelRow harness={harness} />
            <PermissionsRow harness={harness} />
          </>
        )}
        {/* The launch profiles stay reachable for a harness the PATH check did
            not find: a profile's wrapper is how such a harness is run. */}
        <button
          className="settings-row-action"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          data-harness-advanced={harness.id}
        >
          <ChevronRightIcon
            className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`}
            aria-hidden
          />
          Advanced: launch profiles
        </button>
        {/* The fold opens inside the harness's own card, animated like every
            fold of the house (420 ms), never as a block below it. */}
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="advanced"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
              style={{ overflow: 'hidden' }}
              data-harness-advanced-body={harness.id}
            >
              <div className="settings-card-inset">
                <LaunchProfilesFamily family={harness.id} label={harness.name} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </SettingsCard>
    </section>
  )
}

/**
 * Settings → Harnesses (PRDCT-4424): the coding tools on this Mac, one row
 * per harness of the table, each with its version and update state, an
 * Install when it is missing, the model a launcher click runs and the rung
 * of its own permission ladder it starts on. Who pays is Connections'; the
 * launch profiles sit in each harness's Advanced fold.
 */
export function HarnessesSettings(): React.JSX.Element {
  const supported = useAgentUpdatesStore((s) => s.supported)
  const autoUpdate = useAgentUpdatesStore((s) => s.autoUpdate)
  const agents = useAgentUpdatesStore((s) => s.agents)
  const setAutoUpdate = useAgentUpdatesStore((s) => s.setAutoUpdate)
  const byId = new Map<HarnessId, AgentUpdateStatus>(agents.map((a) => [a.id, a]))
  return (
    <SettingsPage
      title="Harnesses"
      description="The coding tools on this Mac. Install one; then pick the model a click runs and what a session may do without asking. Who pays is under Connections."
      testId="agents"
    >
      {HARNESSES.map((harness) => (
        <HarnessBlock
          key={harness.id}
          harness={harness}
          status={byId.get(harness.id)}
          autoUpdate={autoUpdate}
        />
      ))}
      {supported && (
        <SettingsCard>
          <ToggleRow
            label="Update harnesses automatically"
            description="Checks at launch and every six hours, and installs new releases in the background. Off, Clave only tells you."
            checked={autoUpdate}
            onChange={(value) => void setAutoUpdate(value)}
          />
        </SettingsCard>
      )}
    </SettingsPage>
  )
}

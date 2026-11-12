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

/** A text field that writes on Enter or blur: an empty one clears. */
function ModelTextInput({
  harness,
  value,
  placeholder,
  onCommit
}: {
  harness: Harness
  value: string
  placeholder: string
  onCommit: (value: string | null) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [synced, setSynced] = useState(value)
  if (synced !== value) {
    setSynced(value)
    setDraft(value)
  }
  const commit = (): void => {
    const next = draft.trim()
    if (next === value) return
    onCommit(next.length > 0 ? next : null)
  }
  return (
    <input
      className="input-compact w-56 font-mono"
      value={draft}
      placeholder={placeholder}
      aria-label={`Preferred model for ${harness.name}`}
      data-harness-model-input={harness.id}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
    />
  )
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

/** Preferred model: Default, then the models this harness can be put on. */
function PreferredModelRow({ harness }: { harness: Harness }): React.JSX.Element | null {
  const value = useLaunchSettingsStore((s) => s.harnesses[harness.id]?.preferredModel ?? '')
  const setHarness = useLaunchSettingsStore((s) => s.setHarness)
  const codex = useCodexModels(harness.id === 'codex')
  if (!harness.takesModel) return null
  const write = (model: string | null): void =>
    void setHarness(harness.id, { preferredModel: model })
  const description = 'What a click in the launcher runs. Default leaves it to the harness.'

  let control: React.ReactNode
  if (harness.id === 'pi' || (harness.id === 'codex' && codex.failed)) {
    control = (
      <ModelTextInput
        harness={harness}
        value={value}
        placeholder={harness.id === 'pi' ? 'provider/model' : 'Model id'}
        onCommit={write}
      />
    )
  } else if (harness.id === 'codex' && !codex.models) {
    control = (
      <span className="settings-row-value" data-harness-models-loading>
        Loading…
      </span>
    )
  } else {
    const listed: SelectOption<string>[] =
      harness.id === 'claude'
        ? CLAUDE_MODELS.map((model) => ({ value: model.id, label: model.name, hint: model.id }))
        : (codex.models ?? []).map((model) => ({
            value: model.id,
            label: model.label,
            hint: model.hint ?? model.id
          }))
    const known = !value || listed.some((option) => option.value === value)
    const options: SelectOption<string>[] = [
      { value: DEFAULT, label: 'Default' },
      ...listed,
      ...(known ? [] : [{ value, label: value }])
    ]
    control = (
      <SettingsSelect<string>
        value={value || DEFAULT}
        options={options}
        onChange={(next) => write(next === DEFAULT ? null : next)}
        ariaLabel={`Preferred model for ${harness.name}`}
        testId={`harness-model-${harness.id}`}
      />
    )
  }
  return (
    <SettingsRow label="Preferred model" description={description}>
      {control}
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
      description="What a new session may do without asking. Cmd+Y still skips every prompt for one launch."
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
  const missing = status?.installed === false && status.lastCheckedAt !== null

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
            <PreferredModelRow harness={harness} />
            <PermissionsRow harness={harness} />
          </>
        )}
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
      description="The coding tools on this Mac that Clave runs. Each one runs on a connection you pay for; the model is picked when you launch."
      testId="agents"
    >
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
      {HARNESSES.map((harness) => (
        <HarnessBlock
          key={harness.id}
          harness={harness}
          status={byId.get(harness.id)}
          autoUpdate={autoUpdate}
        />
      ))}
    </SettingsPage>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAgentStore } from '../../store/agent-store'
import { useLocationStore } from '../../store/location-store'
import { useClaudeProfileStore } from '../../store/claude-profile-store'
import { useClaudeAccountsUsage, useCodexAccountsUsage } from '../../store/usage-store'
import { useCodexAccountStore } from '../../store/codex-account-store'
import { useWorkspaceStore } from '../../store/workspace-store'
import {
  useLaunchPrefsStore,
  getLastAgentSetup,
  type AgentSetup,
  type AgentKind
} from '../../store/launch-prefs'
import { launchSession, type LaunchCwd } from '../../lib/launch-session'
import { setWorkspaceLaunchProfile, useLaunchProfileStore } from '../../store/launch-profile-store'
import { type LauncherFamily } from '../../../../shared/agent-launch'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import { localLaunchSource, serverLaunchSource, type LaunchSource } from '../../lib/launch-source'
import { HARNESSES, HARNESS_BY_ID, type Harness, type HarnessId } from '../../../../shared/harness'
import { CLAUDE_MODELS, claudeModelName } from '../../../../shared/claude-models'
import { isChatProfileRef } from '../../../../shared/open-session-modes'
import type { ModelOption } from '../../../../shared/session-model'
import { useLaunchSettingsStore } from '../../store/launch-settings-store'
import { useAgentUpdatesStore } from '../../store/agent-updates-store'
import { useSessionStore } from '../../store/session-store'
import {
  loadServerSettings,
  startServerSettingsEvents,
  useServerSettingsStore
} from '../../store/server-settings-store'
import {
  CommandLineIcon,
  FolderIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  BoltIcon,
  CheckIcon,
  PlusIcon,
  SparklesIcon
} from '@heroicons/react/24/outline'
import { AgentPickerPopover } from '../agents/AgentPickerPopover'
import { ClaudeLogo, AntigravityLogo, CodexLogo, PiLogo } from '../icons/cli-logos'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
} from '@clave/ui/components'
import { useShortcutLabel } from '../../store/keymap-store'
import { useFleetStore } from '../../store/fleet-store'
import { pairedServerWorkspaces, usePairingStore } from '../../store/pairing-store'
import { getWorkspaceById, workspaceServer } from '../../store/workspace-store'
import { ServerIcon } from '@heroicons/react/24/outline'

/** What the caret's remote entries hand back to the sidebar, which owns the
 *  remote directory picker (remote launches never touch the local cwd rules). */
export interface RemoteLaunchRequest {
  locationId: string
  locationName: string
  claudeMode: boolean
  antigravityMode: boolean
  codexMode: boolean
}

interface SessionLauncherProps {
  onRemoteLaunch: (request: RemoteLaunchRequest) => void
}

const AGENT_LOGOS: Record<AgentKind, typeof ClaudeLogo> = {
  claude: ClaudeLogo,
  'claude-agents': ClaudeLogo,
  antigravity: AntigravityLogo,
  codex: CodexLogo,
  pi: PiLogo
}

const AGENT_LABELS: Record<AgentKind, string> = {
  claude: 'Claude',
  'claude-agents': 'Agents',
  antigravity: 'Antigravity',
  codex: 'Codex',
  pi: 'Pi'
}

/** The caret's menu drops straight DOWN from the panel — the chevron says so —
 *  and its rows line up with the AGENT BUTTON, the control the caret belongs
 *  to, so the logo of the remembered agent and the logos of the rows sit on
 *  one vertical. (It used to hang off the panel's edge, which is the Terminal
 *  button's: every row's logo then sat a button to the left of the one it
 *  echoed.) A .menu-item's icon sits 13px inside the menu (1px border + 4px
 *  padding + 8px item padding) against 8px for a .launcher-btn's icon inside
 *  the button (its own padding), so the menu's left edge lands 5px left of
 *  the button's. Measured at open time, because the caret's own x moves with
 *  the agent label's width. */
const MENU_ICON_INSET = 5

/** Caret bottom → panel bottom is 3px (a 28px control centred in a 34px panel);
 *  the other 6px is the gap the menu leaves under the panel. */
const MENU_SIDE_OFFSET = 9

/** A model a harness row offers: `id` undefined is the harness's own
 *  default (no flag passed). `family` names whose credits it spends, for the
 *  hint of a model no connection can run. */
interface LauncherModel {
  id: string | undefined
  label: string
  family: string
}

const DEFAULT_MODEL: LauncherModel = { id: undefined, label: 'Default', family: 'Default' }

/** How a remembered model reads: a Claude id by its name, any other as it is. */
function modelLabel(setup: AgentSetup): string | null {
  if (!setup.model) return null
  return setup.kind === 'claude' || setup.kind === 'claude-agents'
    ? claudeModelName(setup.model)
    : setup.model
}

/** The sentence the button's tooltip says, so the remembered setup is legible
 *  without launching it — the whole point of remembering is that one click is
 *  enough, which only works if you can see what that click will do:
 *  "<Harness> · <model> · <connection>" (PRDCT-4423), each part left out
 *  when it is the harness's own default. */
function describeSetup(setup: AgentSetup, connectionLabel?: string): string {
  const family: LauncherFamily = setup.kind === 'claude-agents' ? 'claude' : setup.kind
  let harness = setup.kind === 'claude-agents' ? 'Claude Agents' : HARNESS_BY_ID[family].name
  if (setup.dangerousMode) harness += setup.kind === 'codex' ? ' (YOLO)' : ' (skip permissions)'
  const parts = [harness, modelLabel(setup), connectionLabel].filter(
    (part): part is string => !!part
  )
  return `New session — ${parts.join(' · ')}`
}

/**
 * The pinned session launcher: a plain-terminal button, an agent button that
 * relaunches whatever agent setup was last used IN THIS WORKSPACE, a caret for
 * a different setup, and a folder button for a directory other than the
 * workspace root.
 *
 * Both buttons start at the workspace root. The native folder dialog is no
 * longer on the common path — it is reached deliberately, through the folder
 * button or an Opt+click, rather than being asked on every single launch.
 *
 * The four sit in a panel (.launcher-panel) matching the toolbar's height,
 * border and surface, whose top edge the sidebar aligns with the first content
 * card. The sidebar's own top spacer owns that alignment, not this component.
 */
export function SessionLauncher({ onRemoteLaunch }: SessionLauncherProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [menuAlignOffset, setMenuAlignOffset] = useState(0)
  /** Codex's models, asked of its CLI when the menu first opens (there is
   *  no static list): undefined until the answer, `failed` when it could not
   *  be read (the row then offers its default alone). */
  const [codexModels, setCodexModels] = useState<ModelOption[] | 'failed' | undefined>(undefined)
  const caretRef = useRef<HTMLButtonElement | null>(null)
  const agentButtonRef = useRef<HTMLButtonElement | null>(null)
  const agents = useAgentStore((s) => s.agents)
  const locations = useLocationStore((s) => s.locations)
  // The local stores a source reads at render: subscribed here so a change
  // in any of them redraws the menu (the sources themselves read getState).
  const profiles = useClaudeProfileStore((s) => s.profiles)
  const selectedProfileId = useClaudeProfileStore((s) => s.selectedProfileId)
  const accountsUsage = useClaudeAccountsUsage((s) => s.byAccount)
  const codexAccounts = useCodexAccountStore((s) => s.accounts)
  const selectedCodexAccountId = useCodexAccountStore((s) => s.selectedAccountId)
  const codexAccountsUsage = useCodexAccountsUsage((s) => s.byAccount)
  void profiles
  void selectedProfileId
  void accountsUsage
  void codexAccounts
  void selectedCodexAccountId
  void codexAccountsUsage
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const launchProfilePreferences = useLaunchProfileStore((s) => s.preferences)
  void launchProfilePreferences
  const serverSettings = useServerSettingsStore((s) => s.byServer)
  // Subscribing to the map (not calling the getter) is what re-renders the
  // button when a launch changes what it remembers.
  const byWorkspace = useLaunchPrefsStore((s) => s.byWorkspace)
  void byWorkspace
  const setup = getLastAgentSetup(activeWorkspaceId)
  const terminalShortcut = useShortcutLabel('newTerminal')
  const claudeShortcut = useShortcutLabel('newClaude')
  const agentsShortcut = useShortcutLabel('newClaudeAgents')
  const antigravityShortcut = useShortcutLabel('newAntigravity')
  const codexShortcut = useShortcutLabel('newCodex')
  const piShortcut = useShortcutLabel('newPi')
  const HARNESS_SHORTCUTS: Record<HarnessId, string | null> = {
    claude: claudeShortcut,
    codex: codexShortcut,
    antigravity: antigravityShortcut,
    pi: piShortcut
  }
  const harnessSettings = useLaunchSettingsStore((s) => s.harnesses)
  const agentStatuses = useAgentUpdatesStore((s) => s.agents)
  /** Installed unless a CHECK said otherwise: before the first check main
   *  reports every harness as not installed with no check time, so a harness
   *  not checked yet keeps its row and the menu does not open empty at boot
   *  (found by the end-to-end run of 11 November 2026). */
  const harnessInstalled = (id: HarnessId): boolean => {
    const status = agentStatuses.find((entry) => entry.id === id)
    return !status || status.lastCheckedAt === null || status.installed
  }
  const installedCount = HARNESSES.filter((harness) => harnessInstalled(harness.id)).length

  const connectedRemoteLocations = locations.filter(
    (l) => l.type === 'remote' && l.status === 'connected'
  )
  // The servers whose workspace is paired with this one (PRDCT-4151): a new
  // tab starts on this Mac unless one of their rows is picked.
  const pairings = usePairingStore((s) => s.servers)
  const connections = useFleetStore((s) => s.connections)
  const statuses = useFleetStore((s) => s.statuses)
  const serverName = (serverId: string): string =>
    connections.find((c) => c.id === serverId)?.name ?? 'Server'
  const pairedServers = pairedServerWorkspaces(activeWorkspaceId)
    .map(({ serverId, workspaceId }) => ({
      serverId,
      workspace: getWorkspaceById(workspaceId),
      name: serverName(serverId),
      color: pairings[serverId]?.color,
      online: statuses[serverId]?.state === 'connected'
    }))
    .filter((s) => s.workspace !== undefined)
  // The machine the active workspace lives on is the one the top section and
  // the buttons start on (`launchServer`): a server workspace's launcher
  // offers that server's profiles and accounts, chat forms included (PRDCT-4162).
  const activeServerId = workspaceServer(activeWorkspaceId)
  const sourceFor = (serverId: string): LaunchSource =>
    serverId === LOCAL_SERVER_ID
      ? localLaunchSource(activeWorkspaceId)
      : serverLaunchSource(serverId, serverName(serverId), serverSettingsFor(serverId))
  const serverSettingsFor = (serverId: string): Parameters<typeof serverLaunchSource>[2] =>
    serverSettings[serverId] ?? {
      status: 'idle',
      error: null,
      claude: [],
      codex: [],
      migrated: [],
      profiles: null,
      usage: { claude: {}, codex: {} }
    }
  const topSource = sourceFor(activeServerId ?? LOCAL_SERVER_ID)
  const hasRemoteLocations = connectedRemoteLocations.length > 0 || pairedServers.length > 0
  const hasAgentLocations = agents.length > 0

  // The servers whose rows the menu draws, read while they are connected so
  // the rows are there before the menu opens; read again when a server
  // (re)connects (the store does that itself) and when the menu opens.
  const serversToRead = [
    ...(activeServerId && statuses[activeServerId]?.state === 'connected' ? [activeServerId] : []),
    ...pairedServers.filter((s) => s.online).map((s) => s.serverId)
  ]
  const serversKey = serversToRead.join('\u0000')
  useEffect(() => {
    if (!serversKey) return
    startServerSettingsEvents()
    for (const serverId of serversKey.split('\u0000')) void loadServerSettings(serverId)
  }, [serversKey])

  const AgentLogo = AGENT_LOGOS[setup.kind]
  const setupFamily: LauncherFamily = setup.kind === 'claude-agents' ? 'claude' : setup.kind
  // The connection the button's click goes out on: the one the setup names,
  // else the pool's suggestion for the setup's model. Named only when the
  // pool has a choice to make.
  const setupPool = HARNESS_BY_ID[setupFamily].connectionPool
  const connectionLabel =
    setupPool && topSource.accounts(setupPool).length > 1
      ? (() => {
          const named = setupPool === 'claude' ? setup.claudeProfileId : setup.codexAccountId
          const connections = topSource.connections(setupPool, setup.model)
          return (
            connections.find((c) => (named ? c.id === named : c.suggested)) ??
            (named
              ? undefined
              : connections.find((c) => c.id === topSource.selectedAccountId(setupPool)))
          )?.label
        })()
      : undefined

  /** Opening measures the agent button so the menu hangs off its left edge,
   *  not the caret's — see MENU_ICON_INSET. */
  const openMenu = useCallback(
    (open: boolean) => {
      if (open && agentButtonRef.current && caretRef.current) {
        const button = agentButtonRef.current.getBoundingClientRect()
        const caret = caretRef.current.getBoundingClientRect()
        setMenuAlignOffset(Math.round(button.left - caret.left - MENU_ICON_INSET))
      }
      if (open && serversKey) {
        for (const serverId of serversKey.split('\u0000'))
          if (serverSettings[serverId]?.status !== 'ready') void loadServerSettings(serverId)
      }
      if (open && (codexModels === undefined || codexModels === 'failed')) {
        const cwd = getWorkspaceById(activeWorkspaceId)?.rootDir ?? '/'
        const read = window.electronAPI?.adaptersModels?.('codex-chat', cwd)
        if (!read) setCodexModels('failed')
        else
          void read
            .then((models) => setCodexModels(models.length > 0 ? models : 'failed'))
            .catch(() => setCodexModels('failed'))
      }
      setMenuOpen(open)
    },
    [serversKey, serverSettings, codexModels, activeWorkspaceId]
  )

  const run = useCallback(async (request: Parameters<typeof launchSession>[0]) => {
    setBusy(true)
    try {
      await launchSession(request)
    } finally {
      setBusy(false)
    }
  }, [])

  /** Opt/Alt+click asks for the folder instead of using the workspace root —
   *  the same escape hatch the keyboard shortcuts carry. */
  const cwdFor = (e: { altKey: boolean }): LaunchCwd =>
    e.altKey ? { kind: 'ask' } : { kind: 'workspace-root' }

  /** `pinProfile`: a profile picked under Advanced becomes the workspace's
   *  default for its family, as a profile row did before PRDCT-4423; the
   *  transport a plain row derives from the interaction mode is not a pick
   *  and is never written. */
  const launchAgent = (
    next: AgentSetup,
    cwd: LaunchCwd,
    options: { pinProfile?: boolean } = {}
  ): void => {
    setMenuOpen(false)
    if (options.pinProfile && activeWorkspaceId && next.launchProfileId && !activeServerId) {
      const family: LauncherFamily = next.kind === 'claude-agents' ? 'claude' : next.kind
      void setWorkspaceLaunchProfile(activeWorkspaceId, family, next.launchProfileId)
    }
    void run({ setup: next, cwd, remember: true })
  }

  /** The models a harness's row offers on hover, or null for a harness with
   *  no model level (Antigravity takes no model on its command line). */
  const modelsFor = (
    source: LaunchSource,
    harness: Harness
  ): LauncherModel[] | 'loading' | null => {
    if (!harness.takesModel) return null
    if (harness.id === 'claude')
      return CLAUDE_MODELS.map((model) => ({
        id: model.id,
        label: model.name,
        family: model.alias.charAt(0).toUpperCase() + model.alias.slice(1)
      }))
    if (harness.id === 'codex') {
      if (codexModels === undefined) return 'loading'
      if (codexModels === 'failed' || codexModels.length === 0) return [DEFAULT_MODEL]
      return codexModels.map((model) => ({ id: model.id, label: model.label, family: model.label }))
    }
    // Pi runs whichever provider its own config names: its default, and the
    // models its saved profiles pin.
    const pinned = [
      ...new Set(
        source
          .profilesFor(harness.id)
          .map((profile) => profile.pi?.model)
          .filter((model): model is string => !!model)
      )
    ]
    return [DEFAULT_MODEL, ...pinned.map((id) => ({ id, label: id, family: id }))]
  }

  /** The harness rows of ONE machine, from its source: the one function the
   *  top section and every "Run on <server>" section render with, so a
   *  server offers exactly what it can start (PRDCT-4162). Three questions,
   *  one level each (PRDCT-4423): the row is the TOOL (a click launches it on
   *  its preferred model and the pool's suggested connection), hovering it
   *  offers the MODEL, hovering a model offers WHO PAYS (the pool's
   *  connections, judged for that model, the suggested one marked). This
   *  Mac lists the harnesses it has installed; a server lists every family
   *  its source exposes. `launch` is where the setup goes: the launcher's own
   *  path for the top section, an explicit server for a server section.
   *  Shortcuts are shown for the top section alone: they fire the machine
   *  the active workspace lives on. */
  const renderSourceEntries = (
    source: LaunchSource,
    launch: (setup: AgentSetup, options?: { pinProfile?: boolean }) => void,
    options: { shortcuts: boolean; disabled: boolean }
  ): React.JSX.Element => {
    const local = source.serverId === LOCAL_SERVER_ID
    const rows = HARNESSES.filter((harness) => !local || harnessInstalled(harness.id))
    if (rows.length === 0) {
      return (
        <>
          <DropdownMenuItem disabled data-no-harness>
            <span className="flex-1">No harness installed</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-install-harness
            onSelect={() => {
              setMenuOpen(false)
              useSessionStore.getState().openSettings('agents')
            }}
          >
            <span className="flex-1">Install a harness…</span>
          </DropdownMenuItem>
        </>
      )
    }
    return <>{rows.map((harness) => renderHarnessRow(source, harness, launch, options))}</>
  }

  const renderHarnessRow = (
    source: LaunchSource,
    harness: Harness,
    launch: (setup: AgentSetup, options?: { pinProfile?: boolean }) => void,
    options: { shortcuts: boolean; disabled: boolean }
  ): React.JSX.Element => {
    const Logo = AGENT_LOGOS[harness.id]
    const shortcut = options.shortcuts ? (HARNESS_SHORTCUTS[harness.id] ?? undefined) : undefined
    const preferredModel = harnessSettings[harness.id]?.preferredModel
    const pool = harness.connectionPool
    const go = (choice: { model?: string; accountId?: string; launchProfileId?: string }): void =>
      launch(
        {
          kind: harness.id,
          dangerousMode: false,
          // A plain row names no profile: the launch road derives the transport
          // from the interaction mode (`transportProfileFor`), the same way
          // the agent button and the shortcuts do. An Advanced pick names its.
          ...(choice.launchProfileId ? { launchProfileId: choice.launchProfileId } : {}),
          ...(choice.model ? { model: choice.model } : {}),
          ...(choice.accountId && pool === 'claude' ? { claudeProfileId: choice.accountId } : {}),
          ...(choice.accountId && pool === 'codex' ? { codexAccountId: choice.accountId } : {})
        },
        { pinProfile: choice.launchProfileId !== undefined }
      )
    const rowModel = harness.takesModel ? preferredModel : undefined
    const models = modelsFor(source, harness)
    const advanced = source
      .profilesFor(harness.id)
      .filter((profile) => !isChatProfileRef(harness.id, profile.id))
    const hasAdvanced = advanced.length > 1
    const isClaude = harness.id === 'claude'

    if (!models && !hasAdvanced && !isClaude) {
      return (
        <DropdownMenuItem
          key={harness.id}
          data-harness-row={harness.id}
          disabled={options.disabled}
          onSelect={() => go({ model: rowModel })}
        >
          <Logo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
          <span className="flex-1">{harness.name}</span>
          {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
        </DropdownMenuItem>
      )
    }

    const multiAccount = pool !== null && source.accounts(pool).length > 1

    const connectionRows = (model: string | undefined): React.JSX.Element[] =>
      pool
        ? source.connections(pool, model).map((connection) => (
            <DropdownMenuItem
              key={connection.id}
              data-harness-connection={connection.id}
              data-suggested={connection.suggested ? 'true' : undefined}
              disabled={!connection.usable}
              onSelect={() => go({ model, accountId: connection.id })}
            >
              <span className="flex-1 truncate">{connection.label}</span>
              {connection.suggested && (
                <span className="badge account-switch-suggested">
                  <SparklesIcon aria-hidden />
                  Suggested
                </span>
              )}
              {connection.headroom && (
                <span className="text-[11px] text-text-tertiary tabular-nums flex-shrink-0">
                  {connection.headroom}
                </span>
              )}
            </DropdownMenuItem>
          ))
        : []

    const modelRow = (model: LauncherModel): React.JSX.Element => {
      const key = model.id ?? 'default'
      const connections = pool ? source.connections(pool, model.id) : []
      const unavailable =
        pool !== null && connections.length > 0 && !connections.some((c) => c.usable)
      const hint = unavailable ? `No connection with ${model.family} credits` : undefined
      const check =
        model.id !== undefined && model.id === preferredModel ? (
          <CheckIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
        ) : null
      const body = (
        <>
          <span className="flex-1 truncate">{model.label}</span>
          {hint && (
            <span className="text-[11px] text-text-tertiary flex-shrink-0" data-model-hint>
              {hint}
            </span>
          )}
          {check}
        </>
      )
      if (multiAccount && !unavailable) {
        return (
          <DropdownMenuSub key={key}>
            <DropdownMenuSubTrigger
              data-harness-model={key}
              onClick={() => go({ model: model.id })}
            >
              {body}
              <ChevronRightIcon className="w-3 h-3 flex-shrink-0 text-text-tertiary" />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuLabel>Connection</DropdownMenuLabel>
              {connectionRows(model.id)}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )
      }
      return (
        <DropdownMenuItem
          key={key}
          data-harness-model={key}
          disabled={unavailable}
          title={hint}
          onSelect={() => go({ model: model.id })}
        >
          {body}
        </DropdownMenuItem>
      )
    }

    const selectedProfile = source.selectedProfileId(harness.id)
    return (
      <DropdownMenuSub key={harness.id}>
        <DropdownMenuSubTrigger
          data-harness-row={harness.id}
          disabled={options.disabled}
          // The row itself launches: hovering opens the next question, a
          // click answers it with the defaults.
          onClick={() => go({ model: rowModel })}
        >
          <Logo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
          <span className="flex-1">{harness.name}</span>
          {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
          <ChevronRightIcon className="w-3 h-3 flex-shrink-0 text-text-tertiary" />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {models && <DropdownMenuLabel>Model</DropdownMenuLabel>}
          {models === 'loading' ? (
            <DropdownMenuItem disabled data-harness-model="loading">
              <span className="flex-1">Loading…</span>
            </DropdownMenuItem>
          ) : (
            models?.map(modelRow)
          )}
          {(hasAdvanced || isClaude) && models && <DropdownMenuSeparator />}
          {hasAdvanced && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-harness-advanced={harness.id}>
                <span className="flex-1">Advanced</span>
                <ChevronRightIcon className="w-3 h-3 flex-shrink-0 text-text-tertiary" />
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuLabel>Launch profile</DropdownMenuLabel>
                {advanced.map((profile) => (
                  <DropdownMenuItem
                    key={profile.id}
                    data-launch-profile-entry={profile.id}
                    onSelect={() => go({ model: rowModel, launchProfileId: profile.id })}
                  >
                    <span className="flex-1 truncate">{profile.name}</span>
                    {profile.id === selectedProfile && (
                      <CheckIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {isClaude && (
            <DropdownMenuItem
              data-harness-agents
              onSelect={() => launch({ kind: 'claude-agents', dangerousMode: false })}
            >
              <span className="flex-1">Agents…</span>
              {options.shortcuts && agentsShortcut && (
                <DropdownMenuShortcut>{agentsShortcut}</DropdownMenuShortcut>
              )}
            </DropdownMenuItem>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )
  }

  const topLabel = hasRemoteLocations || topSource.serverId !== LOCAL_SERVER_ID

  return (
    <div className="relative">
      <div className="launcher-panel">
        <div className="launcher-row">
          <button
            disabled={busy}
            className="launcher-btn"
            title={`New terminal — workspace root${terminalShortcut ? ` (${terminalShortcut})` : ''}; ⌥ to choose a folder`}
            onClick={(e) => void run({ setup: null, cwd: cwdFor(e) })}
          >
            <CommandLineIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
            <span>Terminal</span>
          </button>

          <span className="launcher-sep" aria-hidden="true" />

          <div className="launcher-split">
            <button
              ref={agentButtonRef}
              disabled={busy}
              className="launcher-btn"
              data-launcher-agent
              title={`${describeSetup(setup, connectionLabel)} — workspace root (⌥ to choose a folder)`}
              onClick={(e) => void run({ setup, cwd: cwdFor(e), remember: true })}
            >
              <AgentLogo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
              <span className="truncate">{AGENT_LABELS[setup.kind]}</span>
              {setup.dangerousMode && (
                <BoltIcon
                  className="w-3 h-3 flex-shrink-0 text-text-tertiary"
                  title="Permissions skipped"
                />
              )}
            </button>
            <DropdownMenu open={menuOpen} onOpenChange={openMenu}>
              <DropdownMenuTrigger asChild>
                <button
                  ref={(el) => {
                    caretRef.current = el
                  }}
                  disabled={busy}
                  className="launcher-caret"
                  title="Start with another agent setup"
                  aria-label="Start with another agent setup"
                >
                  <ChevronDownIcon className="w-3 h-3" />
                </button>
              </DropdownMenuTrigger>

              <DropdownMenuContent
                animated
                open={menuOpen}
                side="bottom"
                align="start"
                sideOffset={MENU_SIDE_OFFSET}
                alignOffset={menuAlignOffset}
              >
                {topLabel && (
                  <DropdownMenuLabel>
                    <span
                      className="flex items-center gap-1.5"
                      data-launch-source={topSource.serverId}
                    >
                      {topSource.serverId !== LOCAL_SERVER_ID && (
                        <ServerIcon
                          className="w-3 h-3 flex-shrink-0"
                          style={
                            pairings[topSource.serverId]?.color
                              ? { color: pairings[topSource.serverId]?.color }
                              : undefined
                          }
                        />
                      )}
                      <span className="truncate">{topSource.name}</span>
                    </span>
                  </DropdownMenuLabel>
                )}

                {renderSourceEntries(
                  topSource,
                  (next, options) => launchAgent(next, { kind: 'workspace-root' }, options),
                  { shortcuts: true, disabled: false }
                )}
                {topSource.serverId === LOCAL_SERVER_ID && installedCount > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      data-other-harness
                      onSelect={() => {
                        setMenuOpen(false)
                        useSessionStore.getState().openSettings('agents')
                      }}
                    >
                      <PlusIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                      <span className="flex-1">Other harness…</span>
                    </DropdownMenuItem>
                  </>
                )}

                {pairedServers.map((server) => (
                  <div
                    key={`${server.serverId}:${server.workspace!.id}`}
                    data-run-on-server={server.serverId}
                  >
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>
                      <span className="flex items-center gap-1.5">
                        <ServerIcon
                          className="w-3 h-3 flex-shrink-0"
                          style={server.color ? { color: server.color } : undefined}
                        />
                        <span className="truncate">Run on {server.name}</span>
                        {!server.online && (
                          <span className="text-text-tertiary/60 font-normal normal-case">
                            (offline)
                          </span>
                        )}
                      </span>
                    </DropdownMenuLabel>
                    <DropdownMenuItem
                      disabled={!server.online}
                      onSelect={() =>
                        void run({
                          serverId: server.serverId,
                          setup: null,
                          cwd: { kind: 'path', path: server.workspace!.rootDir },
                          workspaceId: server.workspace!.id
                        })
                      }
                    >
                      <CommandLineIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                      <span className="flex-1">Terminal</span>
                    </DropdownMenuItem>
                    {renderSourceEntries(
                      sourceFor(server.serverId),
                      (next) => {
                        setMenuOpen(false)
                        void run({
                          serverId: server.serverId,
                          setup: next,
                          cwd: { kind: 'path', path: server.workspace!.rootDir },
                          workspaceId: server.workspace!.id
                        })
                      },
                      { shortcuts: false, disabled: !server.online }
                    )}
                  </div>
                ))}

                {connectedRemoteLocations.map((loc) => (
                  <div key={loc.id}>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>
                      <span className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
                        <span className="truncate">{loc.name}</span>
                        {loc.host && (
                          <span className="text-text-tertiary/60 font-normal normal-case">
                            ({loc.host})
                          </span>
                        )}
                      </span>
                    </DropdownMenuLabel>
                    <DropdownMenuItem
                      onSelect={() => {
                        setMenuOpen(false)
                        onRemoteLaunch({
                          locationId: loc.id,
                          locationName: loc.name,
                          claudeMode: false,
                          antigravityMode: false,
                          codexMode: false
                        })
                      }}
                    >
                      <CommandLineIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                      <span className="flex-1">Terminal</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        setMenuOpen(false)
                        onRemoteLaunch({
                          locationId: loc.id,
                          locationName: loc.name,
                          claudeMode: true,
                          antigravityMode: false,
                          codexMode: false
                        })
                      }}
                    >
                      <ClaudeLogo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                      <span className="flex-1">Claude Code</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        setMenuOpen(false)
                        onRemoteLaunch({
                          locationId: loc.id,
                          locationName: loc.name,
                          claudeMode: false,
                          antigravityMode: true,
                          codexMode: false
                        })
                      }}
                    >
                      <AntigravityLogo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                      <span className="flex-1">Antigravity</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        setMenuOpen(false)
                        onRemoteLaunch({
                          locationId: loc.id,
                          locationName: loc.name,
                          claudeMode: false,
                          antigravityMode: false,
                          codexMode: true
                        })
                      }}
                    >
                      <CodexLogo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                      <span className="flex-1">Codex</span>
                    </DropdownMenuItem>
                  </div>
                ))}

                {hasAgentLocations && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => {
                        setMenuOpen(false)
                        setAgentPickerOpen(true)
                      }}
                    >
                      <BoltIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                      <span className="flex-1">OpenClaw Agent...</span>
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <span className="launcher-sep" aria-hidden="true" />

          <button
            disabled={busy}
            className="launcher-icon-btn"
            title={`${describeSetup(setup, connectionLabel)} — in another folder…`}
            aria-label="New session in another folder"
            onClick={() => void run({ setup, cwd: { kind: 'ask' }, remember: true })}
          >
            <FolderIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {agentPickerOpen && (
        <AgentPickerPopover anchorRef={caretRef} onClose={() => setAgentPickerOpen(false)} />
      )}
    </div>
  )
}

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
import type { LaunchProfile, LauncherFamily } from '../../../../shared/agent-launch'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import {
  localLaunchSource,
  serverLaunchPick,
  serverLaunchSource,
  type LaunchAccount,
  type LaunchSource,
  type PooledFamily
} from '../../lib/launch-source'
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
  CheckIcon
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

/** The sentence the button's tooltip says, so the remembered setup is legible
 *  without launching it — the whole point of remembering is that one click is
 *  enough, which only works if you can see what that click will do. */
function describeSetup(setup: AgentSetup, profileLabel?: string): string {
  const parts = [AGENT_LABELS[setup.kind]]
  if (setup.kind === 'claude-agents') parts[0] = 'Claude Agents'
  if (setup.dangerousMode) parts.push(setup.kind === 'codex' ? '(YOLO)' : '(skip permissions)')
  if (profileLabel) parts.push(`· ${profileLabel}`)
  return `New session — ${parts.join(' ')}`
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
  const dangerousShortcut = useShortcutLabel('newDangerousClaude')
  const agentsShortcut = useShortcutLabel('newClaudeAgents')
  const antigravityShortcut = useShortcutLabel('newAntigravity')
  const codexShortcut = useShortcutLabel('newCodex')
  const yoloCodexShortcut = useShortcutLabel('newYoloCodex')
  const piShortcut = useShortcutLabel('newPi')

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
  const multiProfile = topSource.accounts('claude').length > 1

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
  const binaryProfile =
    topSource.profilesFor(setupFamily).find((p) => p.id === setup.launchProfileId) ??
    topSource
      .profilesFor(setupFamily)
      .find((p) => p.id === topSource.selectedProfileId(setupFamily))
  const profileLabel =
    multiProfile && (setup.kind === 'claude' || setup.kind === 'claude-agents')
      ? topSource
          .accounts('claude')
          .find((p) => p.id === (setup.claudeProfileId ?? topSource.selectedAccountId('claude')))
          ?.label
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
      setMenuOpen(open)
    },
    [serversKey, serverSettings]
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

  const launchAgent = (next: AgentSetup, cwd: LaunchCwd): void => {
    setMenuOpen(false)
    if (activeWorkspaceId && next.launchProfileId && !activeServerId) {
      const family: LauncherFamily = next.kind === 'claude-agents' ? 'claude' : next.kind
      void setWorkspaceLaunchProfile(activeWorkspaceId, family, next.launchProfileId)
    }
    void run({ setup: next, cwd, remember: true, onServer: serverLaunchPick(topSource, next) })
  }

  /** A Claude or Codex entry in the caret menu: one level per choice left to
   *  make. With a single launch profile and a single account it launches on a
   *  click. Otherwise hovering it opens the launch profiles — the terminal
   *  CLI, its chat view, every saved profile and its chat twin — and, with
   *  more than one account, hovering a profile opens that provider's accounts
   *  beside it, each with its headroom. With one profile and several accounts
   *  the accounts come straight after the entry. The profiles and the
   *  accounts are the source's: this Mac's, or the server's the row runs on. */
  const renderPooledEntry = (entry: {
    family: PooledFamily
    label: string
    shortcut: string | undefined
    Logo: typeof ClaudeLogo
    binaryProfiles: LaunchProfile[]
    selectedBinaryId: string
    accounts: LaunchAccount[]
    selectedAccountId: string | null
    disabled: boolean
    launch: (launchProfileId: string, accountId?: string) => void
  }): React.JSX.Element => {
    const {
      family,
      label,
      shortcut,
      Logo,
      binaryProfiles,
      selectedBinaryId,
      accounts,
      selectedAccountId,
      disabled,
      launch
    } = entry
    const multiAccount = accounts.length > 1
    const entryAttr = { [`data-${family}-entry`]: label }
    if (!multiAccount && binaryProfiles.length === 1) {
      return (
        <DropdownMenuItem
          {...entryAttr}
          disabled={disabled}
          onSelect={() => launch(binaryProfiles[0].id)}
        >
          <Logo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
          <span className="flex-1">{label}</span>
          {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
        </DropdownMenuItem>
      )
    }
    const accountRows = (binaryId: string): React.JSX.Element[] =>
      accounts.map((account) => (
        <DropdownMenuItem
          key={account.id}
          {...{ [`data-${family}-account`]: account.id }}
          onSelect={() => launch(binaryId, account.id)}
          title={account.title}
        >
          <span className="flex-1 truncate">{account.label}</span>
          {account.headroom && (
            <span className="text-[11px] text-text-tertiary tabular-nums flex-shrink-0">
              {account.headroom}
            </span>
          )}
          {binaryId === selectedBinaryId && account.id === selectedAccountId && (
            <CheckIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
          )}
        </DropdownMenuItem>
      ))
    const profileCheck = (binaryId: string): React.JSX.Element | null =>
      binaryId === selectedBinaryId ? (
        <CheckIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
      ) : null
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger {...entryAttr} disabled={disabled}>
          <Logo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
          <span className="flex-1">{label}</span>
          <ChevronRightIcon className="w-3 h-3 flex-shrink-0 text-text-tertiary" />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {binaryProfiles.length === 1 ? (
            <>
              <DropdownMenuLabel>Account</DropdownMenuLabel>
              {accountRows(binaryProfiles[0].id)}
            </>
          ) : (
            <>
              <DropdownMenuLabel>Launch profile</DropdownMenuLabel>
              {binaryProfiles.map((binary) =>
                multiAccount ? (
                  <DropdownMenuSub key={binary.id}>
                    <DropdownMenuSubTrigger data-launch-profile-entry={binary.id}>
                      <span className="flex-1 truncate">{binary.name}</span>
                      {profileCheck(binary.id)}
                      <ChevronRightIcon className="w-3 h-3 flex-shrink-0 text-text-tertiary" />
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuLabel>Account</DropdownMenuLabel>
                      {accountRows(binary.id)}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : (
                  <DropdownMenuItem
                    key={binary.id}
                    data-launch-profile-entry={binary.id}
                    onSelect={() => launch(binary.id)}
                  >
                    <span className="flex-1 truncate">{binary.name}</span>
                    {profileCheck(binary.id)}
                  </DropdownMenuItem>
                )
              )}
            </>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )
  }

  /** An Antigravity or Pi entry: no account, one level for the profile. */
  const renderAgentEntry = (entry: {
    kind: Exclude<AgentKind, 'claude' | 'claude-agents' | 'codex'>
    label: string
    shortcut: string | undefined
    binaryProfiles: LaunchProfile[]
    selectedBinaryId: string
    disabled: boolean
    launch: (launchProfileId: string) => void
  }): React.JSX.Element => {
    const { kind, label, shortcut, binaryProfiles, selectedBinaryId, disabled, launch } = entry
    const Logo = AGENT_LOGOS[kind]
    if (binaryProfiles.length === 1) {
      return (
        <DropdownMenuItem disabled={disabled} onSelect={() => launch(binaryProfiles[0].id)}>
          <Logo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
          <span className="flex-1">{label}</span>
          {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
        </DropdownMenuItem>
      )
    }
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={disabled}>
          <Logo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
          <span className="flex-1">{label}</span>
          <ChevronRightIcon className="w-3 h-3 flex-shrink-0 text-text-tertiary" />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuLabel>Launch profile</DropdownMenuLabel>
          {binaryProfiles.map((profile) => (
            <DropdownMenuItem
              key={profile.id}
              data-launch-profile-entry={profile.id}
              onSelect={() => launch(profile.id)}
            >
              <span className="flex-1 truncate">{profile.name}</span>
              {profile.id === selectedBinaryId && (
                <CheckIcon className="w-3.5 h-3.5 text-text-tertiary" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )
  }

  /** The seven agent rows of ONE machine, from its source: the one function
   *  the top section and every "Run on <server>" section render with, so a
   *  server offers exactly what it can start (PRDCT-4162). `launch` is where
   *  the setup goes: the launcher's own path for the top section, an explicit
   *  server for a server section. Shortcuts are shown for the top section
   *  alone: they fire the machine the active workspace lives on. */
  const renderSourceEntries = (
    source: LaunchSource,
    launch: (setup: AgentSetup) => void,
    options: { shortcuts: boolean; disabled: boolean }
  ): React.JSX.Element => {
    const shortcut = (label: string | null): string | undefined =>
      options.shortcuts ? (label ?? undefined) : undefined
    const claudeEntry = (
      kind: AgentKind,
      label: string,
      key: string | null,
      dangerousMode: boolean
    ): React.JSX.Element =>
      renderPooledEntry({
        family: 'claude',
        label,
        shortcut: shortcut(key),
        Logo: ClaudeLogo,
        binaryProfiles: source.profilesFor('claude'),
        selectedBinaryId: source.selectedProfileId('claude'),
        accounts: source.accounts('claude'),
        selectedAccountId: source.selectedAccountId('claude'),
        disabled: options.disabled,
        launch: (launchProfileId, claudeProfileId) =>
          launch({ kind, dangerousMode, claudeProfileId, launchProfileId })
      })
    const codexEntry = (
      label: string,
      key: string | null,
      dangerousMode: boolean
    ): React.JSX.Element =>
      renderPooledEntry({
        family: 'codex',
        label,
        shortcut: shortcut(key),
        Logo: CodexLogo,
        binaryProfiles: source.profilesFor('codex'),
        selectedBinaryId: source.selectedProfileId('codex'),
        accounts: source.accounts('codex'),
        selectedAccountId: source.selectedAccountId('codex'),
        disabled: options.disabled,
        launch: (launchProfileId, codexAccountId) =>
          launch({ kind: 'codex', dangerousMode, codexAccountId, launchProfileId })
      })
    const agentEntry = (
      kind: 'antigravity' | 'pi',
      label: string,
      key: string | null
    ): React.JSX.Element =>
      renderAgentEntry({
        kind,
        label,
        shortcut: shortcut(key),
        binaryProfiles: source.profilesFor(kind),
        selectedBinaryId: source.selectedProfileId(kind),
        disabled: options.disabled,
        launch: (launchProfileId) => launch({ kind, dangerousMode: false, launchProfileId })
      })
    return (
      <>
        {claudeEntry('claude', 'Claude Code', claudeShortcut, false)}
        {claudeEntry('claude', 'Claude Code (skip permissions)', dangerousShortcut, true)}
        {claudeEntry('claude-agents', 'Claude Agents', agentsShortcut, false)}
        {agentEntry('antigravity', 'Antigravity CLI', antigravityShortcut)}
        {codexEntry('Codex CLI', codexShortcut, false)}
        {codexEntry('Codex CLI (YOLO)', yoloCodexShortcut, true)}
        {agentEntry('pi', 'Pi', piShortcut)}
      </>
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
              title={`${describeSetup(setup, [binaryProfile?.name, profileLabel].filter(Boolean).join(' · '))} — workspace root (⌥ to choose a folder)`}
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
                  (next) => launchAgent(next, { kind: 'workspace-root' }),
                  { shortcuts: true, disabled: false }
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
                          workspaceId: server.workspace!.id,
                          onServer: serverLaunchPick(sourceFor(server.serverId), next)
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
                      <span className="flex-1">Antigravity CLI</span>
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
                      <span className="flex-1">Codex CLI</span>
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
            title={`${describeSetup(setup, profileLabel)} — in another folder…`}
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

import { useCallback, useRef, useState } from 'react'
import { useAgentStore } from '../../store/agent-store'
import { useLocationStore } from '../../store/location-store'
import { useClaudeProfileStore, describeClaudeProfileAuth } from '../../store/claude-profile-store'
import {
  useClaudeAccountsUsage,
  useCodexAccountsUsage,
  headroomLabel
} from '../../store/usage-store'
import { useCodexAccountStore, describeCodexAccountAuth } from '../../store/codex-account-store'
import { useWorkspaceStore } from '../../store/workspace-store'
import {
  useLaunchPrefsStore,
  getLastAgentSetup,
  type AgentSetup,
  type AgentKind
} from '../../store/launch-prefs'
import { launchSession, type LaunchCwd } from '../../lib/launch-session'
import {
  profilesFor,
  selectedLaunchProfile,
  setWorkspaceLaunchProfile,
  useLaunchProfileStore
} from '../../store/launch-profile-store'
import type { LauncherFamily } from '../../../../shared/agent-launch'
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

/** What the caret's remote entries hand back to the sidebar, which owns the
 *  remote directory picker (remote launches never touch the local cwd rules). */
export interface RemoteLaunchRequest {
  locationId: string
  locationName: string
  claudeMode: boolean
  antigravityMode: boolean
  codexMode: boolean
}

/** An account row in the caret menu, whichever provider's pool it is from. */
interface PooledAccount {
  id: string
  label: string
  title: string
  headroom: string | null
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
  const profiles = useClaudeProfileStore((s) => s.profiles)
  const selectedProfileId = useClaudeProfileStore((s) => s.selectedProfileId)
  const accountsUsage = useClaudeAccountsUsage((s) => s.byAccount)
  const codexAccounts = useCodexAccountStore((s) => s.accounts)
  const selectedCodexAccountId = useCodexAccountStore((s) => s.selectedAccountId)
  const codexAccountsUsage = useCodexAccountsUsage((s) => s.byAccount)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const launchProfilePreferences = useLaunchProfileStore((s) => s.preferences)
  void launchProfilePreferences
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
  const hasRemoteLocations = connectedRemoteLocations.length > 0
  const hasAgentLocations = agents.length > 0
  const multiProfile = profiles.length > 1

  const AgentLogo = AGENT_LOGOS[setup.kind]
  const setupFamily: LauncherFamily = setup.kind === 'claude-agents' ? 'claude' : setup.kind
  const binaryProfile = selectedLaunchProfile(setupFamily, activeWorkspaceId, setup.launchProfileId)
  const profileLabel =
    multiProfile && (setup.kind === 'claude' || setup.kind === 'claude-agents')
      ? profiles.find((p) => p.id === (setup.claudeProfileId ?? selectedProfileId))?.label
      : undefined

  /** Opening measures the agent button so the menu hangs off its left edge,
   *  not the caret's — see MENU_ICON_INSET. */
  const openMenu = useCallback((open: boolean) => {
    if (open && agentButtonRef.current && caretRef.current) {
      const button = agentButtonRef.current.getBoundingClientRect()
      const caret = caretRef.current.getBoundingClientRect()
      setMenuAlignOffset(Math.round(button.left - caret.left - MENU_ICON_INSET))
    }
    setMenuOpen(open)
  }, [])

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

  const launchAgent = useCallback(
    (next: AgentSetup, cwd: LaunchCwd) => {
      setMenuOpen(false)
      if (activeWorkspaceId && next.launchProfileId) {
        const family: LauncherFamily = next.kind === 'claude-agents' ? 'claude' : next.kind
        void setWorkspaceLaunchProfile(activeWorkspaceId, family, next.launchProfileId)
      }
      void run({ setup: next, cwd, remember: true })
    },
    [activeWorkspaceId, run]
  )

  /** A Claude or Codex entry in the caret menu: one level per choice left to
   *  make. With a single launch profile and a single account it launches on a
   *  click. Otherwise hovering it opens the launch profiles — the terminal
   *  CLI, its chat view, every saved profile and its chat twin — and, with
   *  more than one account, hovering a profile opens that provider's accounts
   *  beside it, each with its headroom. With one profile and several accounts
   *  the accounts come straight after the entry. */
  const renderPooledEntry = useCallback(
    (entry: {
      family: 'claude' | 'codex'
      label: string
      shortcut: string | undefined
      Logo: typeof ClaudeLogo
      accounts: PooledAccount[]
      selectedAccountId: string | null
      launch: (launchProfileId: string, accountId?: string) => void
    }) => {
      const { family, label, shortcut, Logo, accounts, selectedAccountId, launch } = entry
      const binaryProfiles = profilesFor(family)
      const selectedBinaryId = selectedLaunchProfile(family, activeWorkspaceId).id
      const multiAccount = accounts.length > 1
      const entryAttr = { [`data-${family}-entry`]: label }
      if (!multiAccount && binaryProfiles.length === 1) {
        return (
          <DropdownMenuItem onSelect={() => launch(binaryProfiles[0].id)}>
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
          <DropdownMenuSubTrigger {...entryAttr}>
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
    },
    [activeWorkspaceId]
  )

  const claudeAccounts: PooledAccount[] = profiles.map((account) => ({
    id: account.id,
    label: account.label,
    title: `${account.label} · ${describeClaudeProfileAuth(account)}`,
    headroom: headroomLabel(accountsUsage[account.id])
  }))
  const codexPooledAccounts: PooledAccount[] = codexAccounts.map((account) => ({
    id: account.id,
    label: account.label,
    title: `${account.label} · ${describeCodexAccountAuth(account)}`,
    headroom: headroomLabel(codexAccountsUsage[account.id])
  }))

  const renderClaudeEntry = (
    kind: AgentKind,
    label: string,
    shortcut: string | undefined,
    dangerousMode: boolean
  ): React.JSX.Element =>
    renderPooledEntry({
      family: 'claude',
      label,
      shortcut,
      Logo: ClaudeLogo,
      accounts: claudeAccounts,
      selectedAccountId: selectedProfileId,
      launch: (launchProfileId, claudeProfileId) =>
        launchAgent(
          { kind, dangerousMode, claudeProfileId, launchProfileId },
          { kind: 'workspace-root' }
        )
    })

  const renderCodexEntry = (
    label: string,
    shortcut: string | undefined,
    dangerousMode: boolean
  ): React.JSX.Element =>
    renderPooledEntry({
      family: 'codex',
      label,
      shortcut,
      Logo: CodexLogo,
      accounts: codexPooledAccounts,
      selectedAccountId: selectedCodexAccountId,
      launch: (launchProfileId, codexAccountId) =>
        launchAgent(
          { kind: 'codex', dangerousMode, codexAccountId, launchProfileId },
          { kind: 'workspace-root' }
        )
    })

  const renderAgentEntry = useCallback(
    (
      kind: Exclude<AgentKind, 'claude' | 'claude-agents'>,
      label: string,
      shortcut?: string,
      dangerousMode = false
    ) => {
      const binaryProfiles = profilesFor(kind)
      const Logo = AGENT_LOGOS[kind]
      const launch = (launchProfileId: string): void =>
        launchAgent({ kind, dangerousMode, launchProfileId }, { kind: 'workspace-root' })
      if (binaryProfiles.length === 1) {
        return (
          <DropdownMenuItem onSelect={() => launch(binaryProfiles[0].id)}>
            <Logo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
            <span className="flex-1">{label}</span>
            {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
          </DropdownMenuItem>
        )
      }
      const selected = selectedLaunchProfile(kind, activeWorkspaceId)
      return (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Logo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
            <span className="flex-1">{label}</span>
            <ChevronRightIcon className="w-3 h-3 flex-shrink-0 text-text-tertiary" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuLabel>Launch profile</DropdownMenuLabel>
            {binaryProfiles.map((profile) => (
              <DropdownMenuItem key={profile.id} onSelect={() => launch(profile.id)}>
                <span className="flex-1 truncate">{profile.name}</span>
                {profile.id === selected.id && (
                  <CheckIcon className="w-3.5 h-3.5 text-text-tertiary" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )
    },
    [activeWorkspaceId, launchAgent]
  )

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
              title={`${describeSetup(setup, [binaryProfile.name, profileLabel].filter(Boolean).join(' · '))} — workspace root (⌥ to choose a folder)`}
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
                {hasRemoteLocations && <DropdownMenuLabel>This Mac</DropdownMenuLabel>}

                {renderClaudeEntry('claude', 'Claude Code', claudeShortcut ?? undefined, false)}
                {renderClaudeEntry(
                  'claude',
                  'Claude Code (skip permissions)',
                  dangerousShortcut ?? undefined,
                  true
                )}
                {renderClaudeEntry(
                  'claude-agents',
                  'Claude Agents',
                  agentsShortcut ?? undefined,
                  false
                )}
                {renderAgentEntry(
                  'antigravity',
                  'Antigravity CLI',
                  antigravityShortcut ?? undefined
                )}
                {renderCodexEntry('Codex CLI', codexShortcut ?? undefined, false)}
                {renderCodexEntry('Codex CLI (YOLO)', yoloCodexShortcut ?? undefined, true)}
                {renderAgentEntry('pi', 'Pi', piShortcut ?? undefined)}

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

import { useState, useRef, useEffect, type ReactNode } from 'react'
import { type Theme, TREE_RULE_INTENSITIES, PANEL_ROOTS, useSessionStore } from '../../store/session-store'
import { useWorkTrackerStore } from '../../store/work-tracker-store'
import { useUserStore, USER_ICONS } from '../../store/user-store'
import { PALETTE_KEYS, PALETTE_LABELS, fieldInk } from '../../lib/brand-field'
import { BrandField } from '../ui/BrandField'
import { useWorkspaceStore } from '../../store/workspace-store'
import {
  addWorkspace,
  removeWorkspace,
  setActiveWorkspace,
  renameWorkspace,
  setWorkspaceProfile,
  describeWorkspaceRemoval
} from '../../lib/workspace-actions'
import { UserIconDisplay, ICON_MAP } from '../ui/UserIconDisplay'
import { CheckIcon } from '@heroicons/react/24/solid'
import { TrashIcon, PlusIcon, PencilIcon, FolderIcon, ShieldCheckIcon, ExclamationTriangleIcon, ArrowPathIcon } from '@heroicons/react/24/outline'
import { LocationsTab } from './LocationsTab'
import { UpdatesTab } from './UpdatesTab'
import { UsagePanel } from '../usage/UsagePanel'
import { SettingsSection, SettingsCard, SettingsRow, ToggleRow } from './primitives'
import { cn } from '../../lib/utils'
import { KeymapSettings } from './KeymapSettings'
import { AgentsSettings } from './AgentsSettings'

const themes: { id: Theme; label: string; colors: { bg: string; surface: string; text: string; border: string } }[] = [
  {
    id: 'dark',
    label: 'Dark',
    colors: { bg: '#0a0a0a', surface: '#1a1a1a', text: 'rgba(255,255,255,0.9)', border: 'rgba(255,255,255,0.1)' }
  },
  {
    id: 'charcoal',
    label: 'Charcoal',
    colors: { bg: '#34302c', surface: '#4c4743', text: '#efece9', border: 'rgba(255,243,232,0.1)' }
  },
  {
    id: 'light',
    label: 'Light',
    colors: { bg: '#f9f9f9', surface: '#e6e6e6', text: 'rgba(0,0,0,0.85)', border: 'rgba(0,0,0,0.12)' }
  },
  {
    id: 'coffee',
    label: 'Coffee',
    colors: { bg: '#eeebe5', surface: '#ddd9d1', text: '#1b1610', border: 'rgba(120,100,80,0.15)' }
  }
]

/** One seed for every swatch in the field picker: the row is a comparison of
 *  palettes, and twelve different draws would compare the draws instead. */
const PREVIEW_SEED = 976086463

function ProfileSection() {
  const name = useUserStore((s) => s.name)
  const avatarIcon = useUserStore((s) => s.avatarIcon)
  const avatarField = useUserStore((s) => s.avatarField)
  const avatarSeed = useUserStore((s) => s.avatarSeed)
  const setName = useUserStore((s) => s.setName)
  const setAvatarIcon = useUserStore((s) => s.setAvatarIcon)
  const setAvatarField = useUserStore((s) => s.setAvatarField)
  const reseedAvatar = useUserStore((s) => s.reseedAvatar)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleStartEdit = () => {
    setEditName(name)
    setEditing(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const handleSave = () => {
    if (editName.trim()) setName(editName.trim())
    setEditing(false)
  }

  return (
    <SettingsSection title="Profile">
      <SettingsCard>
        {/* Identity row: avatar + editable name */}
        <div className="settings-row">
          <div className="flex items-center gap-3 min-w-0">
            <UserIconDisplay icon={avatarIcon} field={avatarField} seed={avatarSeed} size="md" />
            {editing ? (
              <input
                ref={inputRef}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleSave}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSave()
                  if (e.key === 'Escape') setEditing(false)
                }}
                className="input-xs max-w-[220px]"
              />
            ) : (
              <button
                onClick={handleStartEdit}
                className="text-sm font-semibold text-text-primary hover:text-accent transition-colors flex items-center gap-1.5"
              >
                {name}
                <PencilIcon className="w-3 h-3 text-text-tertiary" />
              </button>
            )}
          </div>
        </div>

        {/* Twelve of each, laid out as two rows of six rather than left to
            wrap where the panel happens to end: the icons and the fields are
            the same kind of choice and should read as the same grid. */}
        <SettingsRow label="Icon">
          <div className="grid grid-cols-6 gap-1.5">
            {USER_ICONS.map((iconName) => {
              const Icon = ICON_MAP[iconName]
              const isSelected = avatarIcon === iconName
              return (
                <button
                  key={iconName}
                  onClick={() => setAvatarIcon(iconName)}
                  className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${
                    isSelected
                      ? 'bg-accent/15 ring-1 ring-accent'
                      : 'bg-surface-200 hover:bg-surface-300'
                  }`}
                  title={iconName}
                >
                  <Icon
                    className="w-3 h-3"
                    style={{ color: isSelected ? 'var(--color-accent)' : 'var(--text-secondary)' }}
                  />
                </button>
              )
            })}
          </div>
        </SettingsRow>

        {/* The field, not a colour. Each swatch is the palette actually
            painted — same engine, same grain, one seed for all twelve so they
            differ by palette alone and the row reads as a spectrum. Choosing by
            looking at the thing is the whole point: these are Antasphere
            fields, and no hex describes one. */}
        <SettingsRow label="Field">
          <div className="grid grid-cols-6 gap-1.5">
            {PALETTE_KEYS.map((key) => {
              const isSelected = avatarField === key
              return (
                <button
                  key={key}
                  onClick={() => setAvatarField(key)}
                  className="relative w-6 h-6 rounded-md overflow-hidden hover:scale-110 transition-transform flex items-center justify-center"
                  style={{
                    boxShadow: isSelected
                      ? '0 0 0 1.5px var(--color-accent)'
                      : 'inset 0 0 0 1px rgba(0,0,0,0.2)'
                  }}
                  title={PALETTE_LABELS[key]}
                >
                  <BrandField
                    palette={key}
                    seed={PREVIEW_SEED}
                    className="absolute inset-0 w-full h-full"
                  />
                  {isSelected && (
                    <CheckIcon
                      className="relative w-3 h-3"
                      style={{
                        color: fieldInk(key),
                        filter:
                          fieldInk(key) === '#1C1915'
                            ? 'drop-shadow(0 0 2px rgba(255,255,255,0.6))'
                            : 'drop-shadow(0 0 2px rgba(0,0,0,0.5))'
                      }}
                    />
                  )}
                </button>
              )
            })}
          </div>
        </SettingsRow>

        <SettingsRow label="Draw">
          <button
            onClick={reseedAvatar}
            className="btn-secondary inline-flex items-center gap-1.5"
            title="Draw the field again"
          >
            <ArrowPathIcon className="w-3.5 h-3.5" />
            Redraw
          </button>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  )
}

export function SettingsPanel() {
  const settingsSection = useSessionStore((s) => s.settingsSection)

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className={cn(settingsSection === 'keymaps' ? 'max-w-3xl' : 'max-w-xl', 'mx-auto w-full')}>
        {settingsSection === 'general' && <GeneralSettings />}
        {settingsSection === 'agents' && <AgentsSettings />}
        {settingsSection === 'appearance' && <AppearanceSettings />}
        {settingsSection === 'keymaps' && <KeymapSettings />}
        {settingsSection === 'updates' && <UpdatesTab />}
        {settingsSection === 'usage' && <UsageSettings />}
      </div>
    </div>
  )
}

function GeneralSettings() {
  return (
    <>
      <h2 className="text-lg font-semibold text-text-primary mb-6">General</h2>
      <div className="space-y-7">
        <ProfileSection />
        <WorkspacesSection />
        <LocationsTab />
        <SidePanelSection />
        <GitSection />
        <SessionsSection />
        <PrivacySection />
      </div>
    </>
  )
}

function AppearanceSettings() {
  const theme = useSessionStore((s) => s.theme)
  const setTheme = useSessionStore((s) => s.setTheme)

  return (
    <>
      <h2 className="text-lg font-semibold text-text-primary mb-6">Appearance</h2>
      <div className="space-y-7">
        <SettingsSection title="Theme">
          <SettingsCard>
            <div className="settings-row">
              <div className="flex gap-3 flex-1">
                {themes.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTheme(t.id)}
                    className="flex-1 rounded-xl p-1 transition-all duration-200"
                    style={{
                      boxShadow: theme === t.id
                        ? '0 0 0 2px var(--color-accent)'
                        : '0 0 0 1px var(--border-color)',
                      background: 'var(--surface-100)'
                    }}
                  >
                    {/* Mini preview */}
                    <div
                      className="rounded-lg p-3 mb-2"
                      style={{ background: t.colors.bg, border: `1px solid ${t.colors.border}` }}
                    >
                      <div
                        className="h-1.5 w-10 rounded-full mb-2"
                        style={{ background: t.colors.text, opacity: 0.7 }}
                      />
                      <div className="flex gap-1.5">
                        <div
                          className="h-6 flex-1 rounded"
                          style={{ background: t.colors.surface }}
                        />
                        <div
                          className="h-6 flex-1 rounded"
                          style={{ background: t.colors.surface }}
                        />
                      </div>
                      <div
                        className="h-1.5 w-14 rounded-full mt-2"
                        style={{ background: t.colors.text, opacity: 0.4 }}
                      />
                    </div>
                    <div className="text-xs font-medium text-text-primary text-center pb-1">
                      {t.label}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </SettingsCard>
        </SettingsSection>

        <TreeSeparatorsSection />
        <SidebarWidgetsSection />
        <MissionControlSection />
      </div>
    </>
  )
}

/**
 * The weight of the hairlines every tree rules its rows with. One control for
 * all of them — the Files tab, the git panel's repo tree, the changed files
 * inside a repo — because they are one list at different depths of the same
 * window, and a tree ruled harder than the tree beside it reads as a bug.
 *
 * The sample under the control is the point of it: these lines are deliberately
 * near the floor of what the eye picks up, and a setting whose whole range is
 * invisible from the settings pane is a setting nobody can judge.
 */
function TreeSeparatorsSection(): React.JSX.Element {
  const treeRuleIntensity = useSessionStore((s) => s.treeRuleIntensity)
  const setTreeRuleIntensity = useSessionStore((s) => s.setTreeRuleIntensity)

  return (
    <SettingsSection
      title="Tree separators"
      description="The hairlines between rows in the Files tab and in the git panel — the repo tree and the changed files inside it. Off draws none of them."
    >
      <SettingsCard>
        <SettingsRow label="Weight" description="Applies to every tree in the app at once.">
          <div className="segmented">
            {TREE_RULE_INTENSITIES.map((level) => (
              <button
                key={level.id}
                onClick={() => setTreeRuleIntensity(level.id)}
                data-active={treeRuleIntensity === level.id}
                className="segmented-item"
              >
                {level.label}
              </button>
            ))}
          </div>
        </SettingsRow>
        <div className="settings-row">
          <div className="w-full rounded-lg bg-surface-0 py-1" aria-hidden>
            {['src', 'components', 'main.css'].map((name, i) => (
              <div key={name}>
                {i > 0 && (
                  <div className="tree-rule" style={{ marginLeft: 12 + i * 12, marginRight: 12 }} />
                )}
                <div
                  className="h-6 flex items-center text-[11px] text-text-tertiary"
                  style={{ paddingLeft: 12 + i * 12 }}
                >
                  {name}
                </div>
              </div>
            ))}
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

function UsageSettings() {
  return (
    <>
      <h2 className="text-lg font-semibold text-text-primary mb-6">Usage</h2>
      <UsagePanel />
    </>
  )
}

function SessionsSection() {
  const tmuxMode = useSessionStore((s) => s.tmuxMode)
  const setTmuxMode = useSessionStore((s) => s.setTmuxMode)
  const [tmuxAvailable, setTmuxAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI?.tmuxAvailable().then((available) => {
      if (!cancelled) setTmuxAvailable(available)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const unavailable = tmuxAvailable === false

  return (
    <SettingsSection title="Sessions">
      <SettingsCard>
        <ToggleRow
          label="Persistent sessions (tmux)"
          description={
            unavailable
              ? 'Install tmux (e.g. `brew install tmux`) to enable. New sessions then keep running after you quit Clave and reattach on next launch.'
              : 'Run new sessions inside tmux so agents keep running after you quit Clave, survive crashes, and reattach on next launch. Also reachable from any terminal via `tmux -L clave attach`.'
          }
          checked={tmuxMode && !unavailable}
          onChange={setTmuxMode}
          disabled={unavailable}
        />
      </SettingsCard>
    </SettingsSection>
  )
}

function PrivacySection(): ReactNode {
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    let cancelled = false
    window.electronAPI?.telemetryGetState().then((state) => {
      if (!cancelled) setEnabled(state.enabled)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleToggle = (value: boolean): void => {
    setEnabled(value)
    window.electronAPI?.telemetrySetEnabled(value)
  }

  return (
    <SettingsSection title="Privacy">
      <SettingsCard>
        <ToggleRow
          label="Share anonymous usage ping"
          description="One ping a day: random ID, app version, platform. Nothing else."
          checked={enabled}
          onChange={handleToggle}
        />
      </SettingsCard>
    </SettingsSection>
  )
}

function MissionControlSection(): ReactNode {
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    let cancelled = false
    window.electronAPI?.missionControlGetEnabled().then((value) => {
      if (!cancelled) setEnabled(value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleToggle = (value: boolean): void => {
    setEnabled(value)
    window.electronAPI?.missionControlSetEnabled(value)
  }

  if (!navigator.platform.toUpperCase().includes('MAC')) return null

  return (
    <SettingsSection title="Mission Control">
      <SettingsCard>
        <ToggleRow
          label="Show overlay in Mission Control"
          description="Displays a 'Clave is here' badge over the window while Mission Control is open, so Clave is easy to spot among the thumbnails."
          checked={enabled}
          onChange={handleToggle}
        />
      </SettingsCard>
    </SettingsSection>
  )
}

function SidePanelSection(): ReactNode {
  const defaultPanelRoot = useSessionStore((s) => s.defaultPanelRoot)
  const setDefaultPanelRoot = useSessionStore((s) => s.setDefaultPanelRoot)

  return (
    <SettingsSection title="Side panel">
      <SettingsCard>
        <SettingsRow
          label="Default root"
          description="Which folder the Files and Git panels open a tab on. A tab with nothing on the chosen root falls to the next one down — a tab outside any group opens on its own folder — and the panel's root chip still overrides it per tab."
        >
          <div className="segmented">
            {PANEL_ROOTS.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setDefaultPanelRoot(id)}
                className="segmented-item"
                data-active={defaultPanelRoot === id ? 'true' : undefined}
                data-panel-root-option={id}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  )
}

function GitSection() {
  const livePollLimit = useSessionStore((s) => s.gitLivePollLimit)
  const livePollAlways = useSessionStore((s) => s.gitLivePollAlways)
  const setLivePollLimit = useSessionStore((s) => s.setGitLivePollLimit)
  const setLivePollAlways = useSessionStore((s) => s.setGitLivePollAlways)

  // Local string state so the field can be edited freely; commit on blur.
  const [draft, setDraft] = useState(String(livePollLimit))
  useEffect(() => {
    setDraft(String(livePollLimit))
  }, [livePollLimit])

  const commitLimit = () => {
    const n = Number(draft)
    if (Number.isFinite(n) && n > 0) setLivePollLimit(n)
    else setDraft(String(livePollLimit))
  }

  return (
    <SettingsSection title="Git">
      <SettingsCard>
        <ToggleRow
          label="Always keep live updates on"
          description="Never pause auto-refresh, regardless of how many repositories a folder contains. May be heavy on very large folders (e.g. opening '/')."
          checked={livePollAlways}
          onChange={setLivePollAlways}
        />
        <SettingsRow
          label="Pause live updates above"
          description="When a folder has more repositories than this, the git panel stops auto-polling and refreshes on demand (and when an agent finishes or the window regains focus)."
          disabled={livePollAlways}
        >
          <input
            type="number"
            min={1}
            value={draft}
            disabled={livePollAlways}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitLimit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            className="input-xs w-16 text-right"
          />
          <span className="text-xs text-text-tertiary">repos</span>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  )
}

function SidebarWidgetsSection() {
  const workTrackerEnabled = useWorkTrackerStore((s) => s.enabled)
  const setWorkTrackerEnabled = useWorkTrackerStore((s) => s.setEnabled)

  return (
    <SettingsSection title="Sidebar Widgets">
      <SettingsCard>
        <ToggleRow
          label="Work Tracker"
          description="Track daily work time, break reminders, and weekly trends"
          checked={workTrackerEnabled}
          onChange={setWorkTrackerEnabled}
        />
      </SettingsCard>
    </SettingsSection>
  )
}

function WorkspacesSection() {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)

  const [trustedRoots, setTrustedRoots] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  /** Add flow: a folder with several .clave candidates awaits ONE profile pick. */
  const [pendingAdd, setPendingAdd] = useState<{
    rootDir: string
    candidates: { name: string; path: string }[]
    selected: string | null
  } | null>(null)
  const [profileCandidates, setProfileCandidates] = useState<Record<string, { name: string; path: string }[]>>({})
  const [profileMissing, setProfileMissing] = useState<Record<string, boolean>>({})
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)

  const refreshTrustedRoots = () => {
    window.electronAPI?.listTrustedRoots().then((r) => setTrustedRoots(r ?? []))
  }
  useEffect(() => {
    refreshTrustedRoots()
  }, [])

  // Profile candidates per workspace (for the selector) + missing-file warnings.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const cands: Record<string, { name: string; path: string }[]> = {}
      const missing: Record<string, boolean> = {}
      for (const ws of workspaces) {
        const files = (await window.electronAPI?.discoverClaveFiles(ws.rootDir)) ?? []
        cands[ws.id] = files.map((f) => ({ name: f.name, path: f.path }))
        missing[ws.id] =
          !!ws.profileFile && !(await window.electronAPI?.claveFileExists(ws.profileFile))
      }
      if (!cancelled) {
        setProfileCandidates(cands)
        setProfileMissing(missing)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspaces])

  const flashError = (msg: string) => {
    setError(msg)
    setTimeout(() => setError(null), 4000)
  }

  const handleAddWorkspace = async () => {
    setError(null)
    setPendingAdd(null)
    const folder = await window.electronAPI?.openFolderDialog()
    if (!folder) return

    const files = (await window.electronAPI?.discoverClaveFiles(folder)) ?? []
    if (files.length <= 1) {
      // Zero candidates → bare workspace (sessions scope to it, no pins).
      const added = await addWorkspace(folder, files[0]?.path ?? null)
      if (!added) flashError('This folder overlaps an already-registered workspace.')
      refreshTrustedRoots()
      return
    }
    // Several candidates → pick exactly one profile (default.clave preselected).
    const preselected = files.find((f) => f.name === 'default')?.path ?? files[0].path
    setPendingAdd({
      rootDir: folder,
      candidates: files.map((f) => ({ name: f.name, path: f.path })),
      selected: preselected
    })
  }

  const handleConfirmAdd = async () => {
    if (!pendingAdd) return
    const added = await addWorkspace(pendingAdd.rootDir, pendingAdd.selected)
    if (!added) flashError('This folder overlaps an already-registered workspace.')
    setPendingAdd(null)
    refreshTrustedRoots()
  }

  const startRename = (id: string, current: string) => {
    setRenamingId(id)
    setRenameValue(current)
  }
  const commitRename = () => {
    if (renamingId && renameValue.trim()) void renameWorkspace(renamingId, renameValue)
    setRenamingId(null)
  }

  const removal = confirmRemoveId ? describeWorkspaceRemoval(confirmRemoveId) : null
  const removalWs = confirmRemoveId ? workspaces.find((w) => w.id === confirmRemoveId) : null

  return (
    <SettingsSection
      title="Workspaces"
      description={
        <>
          A workspace is a root folder: its sessions, groups, pinned templates, and toolbar are
          scoped together, and the switcher at the top of the sidebar flips between them. Each
          workspace reads one <code className="text-text-secondary">.clave</code> profile file.
        </>
      }
    >
      <SettingsCard>
        {workspaces.map((ws) => {
          const isActive = ws.id === activeWorkspaceId
          const candidates = profileCandidates[ws.id] ?? []
          const missing = profileMissing[ws.id] === true
          const orphanProfile =
            ws.profileFile && !candidates.some((c) => c.path === ws.profileFile)
          return (
            <div
              key={ws.id}
              className={cn(
                'settings-row transition-colors',
                isActive ? 'bg-accent/5' : 'hover:bg-surface-100/60'
              )}
            >
              <div
                className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer"
                onClick={() => {
                  if (!isActive) void setActiveWorkspace(ws.id)
                }}
                title={isActive ? 'Active workspace' : 'Switch to this workspace'}
              >
                <FolderIcon className="w-4 h-4 flex-shrink-0 text-text-tertiary" />
                <div className="flex-1 min-w-0">
                  {renamingId === ws.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename()
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      className="input-compact w-40"
                    />
                  ) : (
                    <p className="settings-row-title truncate">{ws.name}</p>
                  )}
                  <p className="settings-row-description truncate" title={ws.rootDir}>
                    {ws.rootDir}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {missing && (
                  <span title="The selected profile file no longer exists — pins are frozen at their last state.">
                    <ExclamationTriangleIcon className="w-3.5 h-3.5 text-amber-400" />
                  </span>
                )}
                <select
                  value={ws.profileFile ?? ''}
                  onChange={(e) => void setWorkspaceProfile(ws.id, e.target.value || null)}
                  onClick={(e) => e.stopPropagation()}
                  className="input-compact text-xs max-w-28"
                  title="Profile file defining this workspace's groups and toolbar"
                >
                  {orphanProfile && (
                    <option value={ws.profileFile!}>
                      {ws.profileFile!.split('/').pop()?.replace('.clave', '')} (missing)
                    </option>
                  )}
                  {candidates.map((c) => (
                    <option key={c.path} value={c.path}>
                      {c.name}
                    </option>
                  ))}
                  <option value="">No profile</option>
                </select>
                {isActive && <div className="w-2 h-2 rounded-full bg-accent" />}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    startRename(ws.id, ws.name)
                  }}
                  className="btn-icon btn-icon-xs"
                  title="Rename workspace"
                  aria-label="Rename workspace"
                >
                  <PencilIcon className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmRemoveId(ws.id)
                  }}
                  className="btn-icon btn-icon-xs hover:text-red-400"
                  title="Remove workspace"
                  aria-label="Remove workspace"
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )
        })}

        <button onClick={handleAddWorkspace} className="settings-row-action">
          <PlusIcon className="w-4 h-4" />
          Add Workspace
        </button>
      </SettingsCard>

      {/* Removal confirmation — spells out the cascade before anything happens */}
      {removal && removalWs && (
        <div className="mt-2 p-3 rounded-lg border border-red-400/30 bg-red-400/5">
          <p className="text-xs text-text-primary font-medium mb-1">
            Remove workspace “{removalWs.name}”?
          </p>
          <p className="text-xs text-text-secondary">
            {removal.pinCount > 0
              ? `${removal.pinCount} pinned template${removal.pinCount === 1 ? '' : 's'} will be removed (recoverable from their .clave files). `
              : ''}
            {removal.sessionCount > 0
              ? `${removal.sessionCount} running session${removal.sessionCount === 1 ? '' : 's'} will be kept and moved to ${removal.target ? `“${removal.target.name}”` : 'the unscoped view'}.`
              : 'No running sessions are affected.'}
          </p>
          <div className="flex gap-2 mt-2.5">
            <button
              onClick={() => {
                void removeWorkspace(confirmRemoveId!)
                setConfirmRemoveId(null)
              }}
              className="btn-primary btn-compact flex-1"
            >
              Remove
            </button>
            <button
              onClick={() => setConfirmRemoveId(null)}
              className="btn-secondary btn-compact border border-border-subtle"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Profile picker for a freshly added folder with several candidates */}
      {pendingAdd && (
        <div className="mt-2 p-3 rounded-lg border border-accent/30 bg-accent/5">
          <p className="text-xs text-text-secondary mb-2 font-medium">
            Pick the profile for this workspace ({pendingAdd.candidates.length} found):
          </p>
          <div className="space-y-1">
            {pendingAdd.candidates.map((file) => {
              const isSelected = pendingAdd.selected === file.path
              return (
                <label
                  key={file.path}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                    isSelected ? 'bg-accent/10' : 'hover:bg-surface-200'
                  }`}
                >
                  <input
                    type="radio"
                    name="workspace-profile"
                    checked={isSelected}
                    onChange={() => setPendingAdd({ ...pendingAdd, selected: file.path })}
                    className="border-border text-accent focus:ring-accent/30 w-3.5 h-3.5"
                  />
                  <span className="text-xs text-text-primary font-medium">{file.name}</span>
                </label>
              )
            })}
          </div>
          <div className="flex gap-2 mt-2.5">
            <button onClick={handleConfirmAdd} className="btn-primary btn-compact flex-1">
              Add Workspace
            </button>
            <button
              onClick={() => setPendingAdd(null)}
              className="btn-secondary btn-compact border border-border-subtle"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Error message */}
      {error && <p className="mt-2 text-xs text-red-400 px-1">{error}</p>}

      {/* Trusted workspace folders */}
      {trustedRoots.length > 0 && (
        <>
          <div className="settings-row-title px-1 pt-4 pb-1 flex items-center gap-2">
            <ShieldCheckIcon className="w-4 h-4 text-text-tertiary" />
            Trusted workspace folders
          </div>
          <p className="settings-row-description px-1 pb-2">
            Workspace files inside these folders run their auto commands without prompting.
          </p>
          <SettingsCard>
            {trustedRoots.map((root) => (
              <div key={root} className="settings-row">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <FolderIcon className="w-4 h-4 flex-shrink-0 text-text-tertiary" />
                  <p className="settings-row-description truncate" title={root}>{root}</p>
                </div>
                <button
                  onClick={async () => {
                    await window.electronAPI?.untrustWorkspaceRoot(root)
                    setTrustedRoots((r) => r.filter((x) => x !== root))
                  }}
                  className="btn-icon btn-icon-xs hover:text-red-400 flex-shrink-0"
                  title="Revoke trust"
                  aria-label="Revoke trust"
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </SettingsCard>
        </>
      )}
    </SettingsSection>
  )
}

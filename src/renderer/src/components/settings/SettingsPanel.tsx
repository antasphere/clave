import { PluginsTab } from './PluginsTab'
import { useSkinStore, skinAction } from '../../lib/skin'
import { useState, useEffect, type ReactNode } from 'react'
import {
  TREE_RULE_INTENSITIES,
  DENSITY_LEVELS,
  TEXT_SIZE_LEVELS,
  PANEL_ROOTS,
  densityIndex,
  useSessionStore
} from '../../store/session-store'
import { useWorkTrackerStore } from '../../store/work-tracker-store'
import { UI_FONTS } from '../../lib/ui-font'
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
import {
  TrashIcon,
  PlusIcon,
  PencilIcon,
  FolderIcon,
  ShieldCheckIcon,
  ExclamationTriangleIcon,
  ArrowPathIcon
} from '@heroicons/react/24/outline'
import { LocationsTab } from './LocationsTab'
import { UpdatesTab } from './UpdatesTab'
import { UsagePanel, UsageRefresh } from '../usage/UsagePanel'
import { AccountsSettings } from './AccountsSettings'
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsSelect,
  SettingsCallout,
  ToggleRow,
  Radio
} from './primitives'
import { KeymapSettings } from './KeymapSettings'
import { AgentsSettings } from './AgentsSettings'

/** One seed for every swatch in the field picker: the row is a comparison of
 *  palettes, and twelve different draws would compare the draws instead. */
const PREVIEW_SEED = 976086463

/** The sentinel a select needs for "no profile": a select's value is a string,
 *  and the workspace's profile is null when it has none. */
const NO_PROFILE = '__none__'

function ProfileSection(): React.JSX.Element {
  const name = useUserStore((s) => s.name)
  const avatarIcon = useUserStore((s) => s.avatarIcon)
  const avatarField = useUserStore((s) => s.avatarField)
  const avatarSeed = useUserStore((s) => s.avatarSeed)
  const setName = useUserStore((s) => s.setName)
  const setAvatarIcon = useUserStore((s) => s.setAvatarIcon)
  const setAvatarField = useUserStore((s) => s.setAvatarField)
  const reseedAvatar = useUserStore((s) => s.reseedAvatar)
  const [editName, setEditName] = useState(name)
  // Follow a rename made elsewhere (another window): derive during render,
  // the React-sanctioned shape, rather than a setState inside an effect.
  const [syncedName, setSyncedName] = useState(name)
  if (syncedName !== name) {
    setSyncedName(name)
    setEditName(name)
  }

  // Commit on blur or Enter; an empty field falls back to the saved name.
  const handleSave = (): void => {
    if (editName.trim()) setName(editName.trim())
    else setEditName(name)
  }

  return (
    <SettingsSection
      title="Profile"
      description="Your name and the avatar at the foot of the sidebar."
    >
      <SettingsCard>
        <SettingsRow label="Name" description="Shown at the foot of the sidebar and to the agents.">
          <input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleSave}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') {
                setEditName(name)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            className="input-compact w-48"
            aria-label="Your name"
          />
        </SettingsRow>

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
                  className="avatar-cell"
                  data-selected={isSelected ? 'true' : undefined}
                  title={iconName}
                  aria-label={iconName}
                >
                  <Icon className="w-3 h-3" />
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
                  className="avatar-cell"
                  data-selected={isSelected ? 'true' : undefined}
                  title={PALETTE_LABELS[key]}
                  aria-label={PALETTE_LABELS[key]}
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
                        // The ink the field itself asks for, so the check
                        // reads on a pale field and on a dark one alike.
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

        <SettingsRow
          label="Avatar"
          description="The field is drawn from a seed. Draw it again for another picture of the same palette."
        >
          <UserIconDisplay icon={avatarIcon} field={avatarField} seed={avatarSeed} size="md" />
          <button onClick={reseedAvatar} className="btn-secondary" title="Draw the field again">
            <ArrowPathIcon className="w-3.5 h-3.5" />
            Redraw
          </button>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  )
}

export function SettingsPanel(): React.JSX.Element {
  const settingsSection = useSessionStore((s) => s.settingsSection)

  return (
    <div className="settings-scroller">
      <div className="max-w-3xl mx-auto w-full">
        {settingsSection === 'general' && <GeneralSettings />}
        {settingsSection === 'agents' && <AgentsSettings />}
        {settingsSection === 'appearance' && <AppearanceSettings />}
        {settingsSection === 'keymaps' && <KeymapSettings />}
        {settingsSection === 'updates' && <UpdatesTab />}
        {settingsSection === 'plugins' && <PluginsTab />}
        {settingsSection === 'usage' && <UsageSettings />}
        {settingsSection === 'accounts' && <AccountsSettings />}
      </div>
    </div>
  )
}

function GeneralSettings(): React.JSX.Element {
  return (
    <SettingsPage
      title="General"
      description="Your profile, the workspaces Clave opens, the machines it reaches, and how sessions run."
    >
      <ProfileSection />
      <WorkspacesSection />
      <LocationsTab />
      <SidePanelSection />
      <GitSection />
      <SessionsSection />
      <PrivacySection />
    </SettingsPage>
  )
}

function AppearanceSettings(): React.JSX.Element {
  const { skins: themes, activeId: theme, error, errors } = useSkinStore()

  return (
    <SettingsPage
      title="Appearance"
      description="The theme, how tight the app is drawn, the hairlines every tree is ruled with, and what the sidebar shows."
    >
      <SettingsSection
        title="Theme"
        description="Installed skins share their tokens with every panel and terminal."
      >
        <SettingsCard>
          <div className="settings-row">
            <div className="flex flex-wrap gap-3 flex-1">
              {themes.map((t) => (
                <button
                  key={t.id}
                  onClick={() => void skinAction(() => window.electronAPI.skinsActivate(t.id))}
                  className="theme-swatch"
                  data-selected={theme === t.id ? 'true' : undefined}
                  data-theme-option={t.id}
                  aria-pressed={theme === t.id}
                >
                  {/* The preview carries the theme, so it is painted with
                      that theme's own surfaces and ink. */}
                  <div
                    className="theme-swatch-preview"
                    data-theme={t.skin.base}
                    style={t.tokens as React.CSSProperties}
                  >
                    <div className="theme-swatch-line w-10 mb-2" style={{ opacity: 0.7 }} />
                    <div className="flex gap-1.5">
                      <div className="theme-swatch-tile" />
                      <div className="theme-swatch-tile" />
                    </div>
                    <div className="theme-swatch-line w-14 mt-2" style={{ opacity: 0.4 }} />
                  </div>
                  <div className="theme-swatch-label">{t.name}</div>
                </button>
              ))}
            </div>
          </div>
          <SettingsRow label="Import skin" description="Choose a skin folder or a skin.json file.">
            <button
              className="btn-secondary"
              onClick={() => void skinAction(() => window.electronAPI.skinsImport())}
            >
              Import skin
            </button>
          </SettingsRow>
          {themes
            .filter((skin) => !skin.bundled)
            .map((skin) => (
              <SettingsRow key={skin.id} label={skin.name}>
                <button
                  className="btn-secondary"
                  onClick={() => void skinAction(() => window.electronAPI.skinsRemove(skin.id))}
                >
                  Remove {skin.name}
                </button>
              </SettingsRow>
            ))}
        </SettingsCard>
        {(error || errors.length > 0) && (
          <SettingsCallout role="alert" tone="danger" text={error || errors.join('; ')} />
        )}
      </SettingsSection>

      <DensitySection />
      <TreeSeparatorsSection />
      <SidebarWidgetsSection />
      <MissionControlSection />
    </SettingsPage>
  )
}

/**
 * How tight the app's chrome is drawn, and how large its labels are.
 *
 * Density picks one of five presets (`data-density` on the root element,
 * resolved in packages/ui/src/density.css). Compact and Comfortable are two
 * hand-tuned designs reproduced exactly; the other three are derived from
 * them. It is a real range input: five ordered stops are a continuum, arrow
 * keys and Home/End come free, and `aria-valuetext` carries the stop's name.
 *
 * Text size is separate and additive: it moves every label by the same few
 * px on top of the preset, so the presets keep their own sizes at Default.
 */
function DensitySection(): React.JSX.Element {
  const density = useSessionStore((s) => s.density)
  const setDensity = useSessionStore((s) => s.setDensity)
  const index = densityIndex(density)
  const level = DENSITY_LEVELS[index]

  return (
    <SettingsSection
      title="Density"
      description="How tight every control, bar and row is drawn, this page included."
    >
      <SettingsCard>
        <SettingsRow label="Spacing" description="Comfortable is the default.">
          <span className="settings-row-value" data-testid="density-value">
            {level.label}
          </span>
        </SettingsRow>
        <div className="settings-row">
          <div
            className="range-stepped w-full flex flex-col gap-1"
            style={{ '--n': DENSITY_LEVELS.length - 1 } as React.CSSProperties}
          >
            <div className="range-rail" aria-hidden>
              {DENSITY_LEVELS.map((stop, i) => (
                <span
                  key={stop.id}
                  className="range-dot"
                  style={{ '--i': i } as React.CSSProperties}
                />
              ))}
            </div>
            <input
              type="range"
              className="range-field"
              min={0}
              max={DENSITY_LEVELS.length - 1}
              step={1}
              value={index}
              aria-label="Density"
              aria-valuetext={level.label}
              data-testid="density-slider"
              onChange={(e) => setDensity(DENSITY_LEVELS[Number(e.target.value)].id)}
            />
            <div className="range-ticks" aria-hidden>
              {DENSITY_LEVELS.map((stop, i) => (
                <span
                  key={stop.id}
                  className="range-tick"
                  data-active={stop.id === level.id}
                  data-density-tick={stop.id}
                  style={{ '--i': i } as React.CSSProperties}
                >
                  {stop.label}
                </span>
              ))}
            </div>
          </div>
        </div>
        <TextSizeRow />
        <FontRow />
      </SettingsCard>
    </SettingsSection>
  )
}

function TextSizeRow(): React.JSX.Element {
  const textSize = useSessionStore((s) => s.textSize)
  const setTextSize = useSessionStore((s) => s.setTextSize)

  return (
    <SettingsRow label="Text size" description="Every label in the app, on top of the density.">
      <div className="segmented" role="radiogroup" aria-label="Text size">
        {TEXT_SIZE_LEVELS.map((level) => (
          <button
            key={level.id}
            role="radio"
            aria-checked={textSize === level.id}
            onClick={() => setTextSize(level.id)}
            data-active={textSize === level.id}
            data-text-size={level.id}
            className="segmented-item"
          >
            {level.label}
          </button>
        ))}
      </div>
    </SettingsRow>
  )
}

function FontRow(): React.JSX.Element {
  const uiFont = useSessionStore((s) => s.uiFont)
  const setUiFont = useSessionStore((s) => s.setUiFont)
  const fonts = UI_FONTS.filter((font) => font.available)
  if (fonts.length < 2) return <></>

  return (
    <SettingsRow label="Font" description="The typeface of the app. The terminal keeps its own.">
      <div className="segmented" role="radiogroup" aria-label="Font">
        {fonts.map((font) => (
          <button
            key={font.id}
            role="radio"
            aria-checked={uiFont === font.id}
            onClick={() => setUiFont(font.id)}
            data-active={uiFont === font.id}
            data-ui-font-option={font.id}
            className="segmented-item"
          >
            {font.label}
          </button>
        ))}
      </div>
    </SettingsRow>
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
      description="The hairlines between rows in the Files tab and the git panel."
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
                  className="h-control-sm flex items-center text-[11px] text-text-tertiary"
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

function UsageSettings(): React.JSX.Element {
  return (
    <SettingsPage
      title="Usage"
      description="How much of each account's limits is used, and when each one resets. Read every five minutes; accounts are added under Accounts."
      actions={<UsageRefresh />}
    >
      <UsagePanel />
    </SettingsPage>
  )
}

function SessionsSection(): React.JSX.Element {
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
              ? 'Needs tmux (brew install tmux). Sessions then survive quitting Clave and reattach on the next launch.'
              : 'Sessions keep running after you quit Clave and reattach on the next launch. Reachable from any terminal with tmux -L clave attach.'
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
          description="Where the Files and Git panels open for a new tab. The panel's root chip still changes it per tab."
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

function GitSection(): React.JSX.Element {
  const livePollLimit = useSessionStore((s) => s.gitLivePollLimit)
  const livePollAlways = useSessionStore((s) => s.gitLivePollAlways)
  const setLivePollLimit = useSessionStore((s) => s.setGitLivePollLimit)
  const setLivePollAlways = useSessionStore((s) => s.setGitLivePollAlways)

  // Local string state so the field can be edited freely; commit on blur.
  const [draft, setDraft] = useState(String(livePollLimit))
  useEffect(() => {
    setDraft(String(livePollLimit))
  }, [livePollLimit])

  const commitLimit = (): void => {
    const n = Number(draft)
    if (Number.isFinite(n) && n > 0) setLivePollLimit(n)
    else setDraft(String(livePollLimit))
  }

  return (
    <SettingsSection title="Git">
      <SettingsCard>
        <ToggleRow
          label="Always keep live updates on"
          description="Never pause auto-refresh, however many repositories a folder holds. Heavy on very large folders."
          checked={livePollAlways}
          onChange={setLivePollAlways}
        />
        <SettingsRow
          label="Pause live updates above"
          description="Past this many repositories the git panel refreshes on demand instead of polling."
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
            className="input-compact w-16 text-right"
            aria-label="Repositories above which live updates pause"
          />
          <span className="settings-row-value">repos</span>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  )
}

function SidebarWidgetsSection(): React.JSX.Element {
  const workTrackerEnabled = useWorkTrackerStore((s) => s.enabled)
  const setWorkTrackerEnabled = useWorkTrackerStore((s) => s.setEnabled)

  return (
    <SettingsSection title="Sidebar widgets">
      <SettingsCard>
        <ToggleRow
          label="Work Tracker"
          description="Daily work time, break reminders and weekly trends in the sidebar."
          checked={workTrackerEnabled}
          onChange={setWorkTrackerEnabled}
        />
      </SettingsCard>
    </SettingsSection>
  )
}

function WorkspacesSection(): React.JSX.Element {
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
  const [profileCandidates, setProfileCandidates] = useState<
    Record<string, { name: string; path: string }[]>
  >({})
  const [profileMissing, setProfileMissing] = useState<Record<string, boolean>>({})
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)

  const refreshTrustedRoots = (): void => {
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

  const flashError = (msg: string): void => {
    setError(msg)
    setTimeout(() => setError(null), 4000)
  }

  const handleAddWorkspace = async (): Promise<void> => {
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

  const handleConfirmAdd = async (): Promise<void> => {
    if (!pendingAdd) return
    const added = await addWorkspace(pendingAdd.rootDir, pendingAdd.selected)
    if (!added) flashError('This folder overlaps an already-registered workspace.')
    setPendingAdd(null)
    refreshTrustedRoots()
  }

  const startRename = (id: string, current: string): void => {
    setRenamingId(id)
    setRenameValue(current)
  }
  const commitRename = (): void => {
    if (renamingId && renameValue.trim()) void renameWorkspace(renamingId, renameValue)
    setRenamingId(null)
  }

  const removal = confirmRemoveId ? describeWorkspaceRemoval(confirmRemoveId) : null
  const removalWs = confirmRemoveId ? workspaces.find((w) => w.id === confirmRemoveId) : null

  return (
    <>
      <SettingsSection
        title="Workspaces"
        description={
          <>
            A root folder with its own sessions, groups, pinned templates and toolbar, each read
            from one <code className="text-text-primary">.clave</code> profile file.
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
            const profileOptions = [
              ...(orphanProfile
                ? [
                    {
                      value: ws.profileFile!,
                      label: `${ws.profileFile!.split('/').pop()?.replace('.clave', '')} (missing)`
                    }
                  ]
                : []),
              ...candidates.map((c) => ({ value: c.path, label: c.name })),
              { value: NO_PROFILE, label: 'No profile' }
            ]
            return (
              <div key={ws.id} className="settings-row" data-workspace-row={ws.id}>
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
                        aria-label="Workspace name"
                      />
                    ) : (
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="settings-row-title truncate">{ws.name}</p>
                        {isActive && <span className="badge badge-muted">Active</span>}
                      </div>
                    )}
                    <p className="settings-row-description truncate" title={ws.rootDir}>
                      {ws.rootDir}
                    </p>
                  </div>
                </div>
                <div className="settings-row-controls">
                  {missing && (
                    <span title="The selected profile file no longer exists — pins are frozen at their last state.">
                      <ExclamationTriangleIcon className="w-3.5 h-3.5 text-warning" />
                    </span>
                  )}
                  <SettingsSelect
                    value={ws.profileFile ?? NO_PROFILE}
                    options={profileOptions}
                    onChange={(value) =>
                      void setWorkspaceProfile(ws.id, value === NO_PROFILE ? null : value)
                    }
                    ariaLabel={`Profile file for ${ws.name}`}
                    className="max-w-36"
                    testId="workspace-profile"
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      startRename(ws.id, ws.name)
                    }}
                    className="btn-icon btn-icon-sm"
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
                    className="btn-icon btn-icon-sm btn-icon--danger"
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
            Add workspace
          </button>
        </SettingsCard>

        {/* Removal confirmation — spells out the cascade before anything happens */}
        {removal && removalWs && (
          <SettingsCallout
            tone="danger"
            title={<>Remove workspace “{removalWs.name}”?</>}
            text={
              <>
                {removal.pinCount > 0
                  ? `${removal.pinCount} pinned template${removal.pinCount === 1 ? '' : 's'} will be removed (recoverable from their .clave files). `
                  : ''}
                {removal.sessionCount > 0
                  ? `${removal.sessionCount} running session${removal.sessionCount === 1 ? '' : 's'} will be kept and moved to ${removal.target ? `“${removal.target.name}”` : 'the unscoped view'}.`
                  : 'No running sessions are affected.'}
              </>
            }
            actions={
              <>
                <button onClick={() => setConfirmRemoveId(null)} className="btn-secondary">
                  Cancel
                </button>
                <button
                  onClick={() => {
                    void removeWorkspace(confirmRemoveId!)
                    setConfirmRemoveId(null)
                  }}
                  className="btn-primary"
                >
                  Remove
                </button>
              </>
            }
          />
        )}

        {/* Profile picker for a freshly added folder with several candidates */}
        {pendingAdd && (
          <SettingsCallout
            tone="accent"
            title="Which profile should this workspace read?"
            text={`${pendingAdd.candidates.length} .clave files found in the folder.`}
            actions={
              <>
                <button onClick={() => setPendingAdd(null)} className="btn-secondary">
                  Cancel
                </button>
                <button onClick={handleConfirmAdd} className="btn-primary">
                  Add workspace
                </button>
              </>
            }
          >
            <div className="mt-2" role="radiogroup" aria-label="Profile file">
              {pendingAdd.candidates.map((file) => {
                const isSelected = pendingAdd.selected === file.path
                return (
                  <button
                    key={file.path}
                    type="button"
                    className="menu-item"
                    data-selected={isSelected ? 'true' : undefined}
                    onClick={() => setPendingAdd({ ...pendingAdd, selected: file.path })}
                  >
                    <Radio
                      checked={isSelected}
                      onSelect={() => setPendingAdd({ ...pendingAdd, selected: file.path })}
                      ariaLabel={file.name}
                    />
                    <span>{file.name}</span>
                  </button>
                )
              })}
            </div>
          </SettingsCallout>
        )}

        {error && <SettingsCallout tone="danger" text={error} role="alert" />}
      </SettingsSection>
      <TrustedFoldersSection
        roots={trustedRoots}
        onRevoke={(root) => {
          void window.electronAPI?.untrustWorkspaceRoot(root)
          setTrustedRoots((r) => r.filter((x) => x !== root))
        }}
      />
    </>
  )
}

/** The folders whose .clave files run their auto commands without the review
 *  dialog. Its own section under Workspaces, since it is a list of a different
 *  thing: a grant, not a workspace. */
function TrustedFoldersSection({
  roots,
  onRevoke
}: {
  roots: string[]
  onRevoke: (root: string) => void
}): React.JSX.Element | null {
  if (roots.length === 0) return null
  return (
    <SettingsSection
      title={
        <>
          <ShieldCheckIcon />
          Trusted workspace folders
        </>
      }
      description="Workspace files inside these folders run their auto commands without asking."
    >
      <SettingsCard>
        {roots.map((root) => (
          <div key={root} className="settings-row">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <FolderIcon className="w-4 h-4 flex-shrink-0 text-text-tertiary" />
              <p className="settings-row-title truncate" title={root}>
                {root}
              </p>
            </div>
            <div className="settings-row-controls">
              <button
                onClick={() => onRevoke(root)}
                className="btn-icon btn-icon-sm btn-icon--danger"
                title="Revoke trust"
                aria-label="Revoke trust"
              >
                <TrashIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </SettingsCard>
    </SettingsSection>
  )
}

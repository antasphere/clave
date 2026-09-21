import { useEffect, useState, useCallback } from 'react'
import {
  ArrowPathIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  BuildingStorefrontIcon,
  ServerStackIcon,
  CubeTransparentIcon,
  SparklesIcon,
  CpuChipIcon,
  CommandLineIcon,
  FolderOpenIcon,
  PlusIcon,
  TrashIcon,
  ArrowDownTrayIcon,
  CheckCircleIcon,
  XCircleIcon
} from '@heroicons/react/24/outline'
import { useSessionStore } from '../../store/session-store'
import {
  useClaudeProfileStore,
  getClaudeProfile,
  DEFAULT_CLAUDE_PROFILE_ID
} from '../../store/claude-profile-store'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel
} from '@clave/ui/components'
import { ConfirmDialog } from '@clave/ui/components'
import { AddMarketplaceDialog } from './AddMarketplaceDialog'
import { cn } from '@clave/ui/components'
import type {
  ExtensionsInventory,
  PluginInfo,
  SkillInfo,
  AgentInfo,
  CommandInfo,
  McpServerInfo,
  MarketplaceInfo,
  MutationResult
} from '../../../../shared/extensions-types'

/** Drill position within the Marketplaces tab. */
type Drill =
  | { level: 'list' }
  | { level: 'marketplace'; name: string }
  | { level: 'plugin'; id: string }
  | { level: 'standalone' }

/** Mutating actions + the in-flight key, threaded down to the views. */
interface ExtensionActions {
  /** Key of the action currently running (e.g. "install:foo@bar"), or null. */
  pending: string | null
  install: (pluginId: string) => void
  uninstall: (plugin: PluginInfo) => void
  toggle: (plugin: PluginInfo) => void
  removeMarketplace: (name: string) => void
}

/** A small neutral count/label chip. */
function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('badge bg-surface-200 text-text-secondary', className)}>{children}</span>
  )
}

function EmptyState({
  icon: Icon,
  message
}: {
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
  message: string
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Icon className="w-8 h-8 text-text-tertiary/50 mb-3" />
      <p className="text-control text-text-tertiary max-w-xs">{message}</p>
    </div>
  )
}

function sourceLabel(source: string): string {
  return source === 'user' ? 'user' : source.split('@')[0]
}

function countSummary(c: PluginInfo['counts']): string {
  const parts: string[] = []
  if (c.skills) parts.push(`${c.skills} skill${c.skills > 1 ? 's' : ''}`)
  if (c.agents) parts.push(`${c.agents} agent${c.agents > 1 ? 's' : ''}`)
  if (c.commands) parts.push(`${c.commands} cmd${c.commands > 1 ? 's' : ''}`)
  if (c.mcpServers) parts.push(`${c.mcpServers} mcp`)
  return parts.join(' · ') || 'no capabilities'
}

// ── Level 1: marketplaces grid ────────────────────────────────────────────────

function MarketplacesGrid({
  inv,
  onOpen
}: {
  inv: ExtensionsInventory
  onOpen: (drill: Drill) => void
}) {
  const standaloneCount = inv.userSkills.length + inv.userAgents.length + inv.userCommands.length

  if (inv.marketplaces.length === 0 && standaloneCount === 0) {
    return (
      <EmptyState
        icon={BuildingStorefrontIcon}
        message="No marketplaces registered for this profile. Use “Add marketplace” to register one."
      />
    )
  }

  return (
    <div className="extension-grid">
      {inv.marketplaces.map((m: MarketplaceInfo) => (
        <button
          key={m.name}
          className="extension-card"
          onClick={() => onOpen({ level: 'marketplace', name: m.name })}
        >
          <div className="flex items-center gap-2">
            <BuildingStorefrontIcon className="w-4 h-4 text-text-tertiary flex-shrink-0" />
            <span className="text-control font-semibold text-text-primary truncate flex-1">
              {m.name}
            </span>
            {m.autoUpdate && <Chip className="!bg-green-500/15 !text-green-600">auto</Chip>}
          </div>
          <p className="text-[11px] text-text-tertiary font-mono truncate">
            {m.sourceType === 'github' ? `github:${m.sourceLabel}` : m.sourceLabel}
          </p>
          <div className="flex items-center gap-1 mt-auto pt-1">
            <Chip>
              {m.installedCount}/{m.offeredPlugins.length} installed
            </Chip>
          </div>
        </button>
      ))}

      {standaloneCount > 0 && (
        <button
          className="extension-card border-dashed"
          onClick={() => onOpen({ level: 'standalone' })}
        >
          <div className="flex items-center gap-2">
            <FolderOpenIcon className="w-4 h-4 text-text-tertiary flex-shrink-0" />
            <span className="text-control font-semibold text-text-primary truncate flex-1">
              Standalone
            </span>
          </div>
          <p className="text-[11px] text-text-tertiary">Items not from any plugin</p>
          <div className="flex items-center gap-1 mt-auto pt-1">
            <Chip>
              {countSummary({
                skills: inv.userSkills.length,
                agents: inv.userAgents.length,
                commands: inv.userCommands.length,
                mcpServers: 0
              })}
            </Chip>
          </div>
        </button>
      )}
    </div>
  )
}

// ── Level 2: one marketplace → its plugins ─────────────────────────────────────

function MarketplaceView({
  inv,
  marketplaceName,
  onOpenPlugin,
  actions
}: {
  inv: ExtensionsInventory
  marketplaceName: string
  onOpenPlugin: (id: string) => void
  actions: ExtensionActions
}) {
  const installed = inv.plugins.filter((p) => p.marketplace === marketplaceName)
  const installedNames = new Set(installed.map((p) => p.name))
  const market = inv.marketplaces.find((m) => m.name === marketplaceName)
  const notInstalled = (market?.offeredPlugins ?? []).filter((n) => !installedNames.has(n))

  const busy = actions.pending !== null

  return (
    <>
      {/* Marketplace action bar */}
      {market && (
        <div className="flex items-center justify-between gap-3 mb-4 px-3 py-2 rounded-xl bg-surface-100 border border-border-subtle">
          <p className="text-[11px] text-text-tertiary font-mono truncate min-w-0">
            {market.sourceType === 'github' ? `github:${market.sourceLabel}` : market.sourceLabel}
          </p>
          <button
            onClick={() => actions.removeMarketplace(market.name)}
            disabled={busy}
            className="btn-secondary btn-compact text-red-400 hover:text-red-300 flex-shrink-0 disabled:opacity-40"
          >
            {actions.pending === `mkt-remove:${market.name}` ? (
              <ArrowPathIcon className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <TrashIcon className="w-3.5 h-3.5" />
            )}
            Remove
          </button>
        </div>
      )}

      {installed.length === 0 && notInstalled.length === 0 ? (
        <EmptyState icon={CubeTransparentIcon} message="This marketplace offers no plugins." />
      ) : (
        <div className="extension-grid">
          {installed.map((p) => (
            <button key={p.id} className="extension-card" onClick={() => onOpenPlugin(p.id)}>
              <div className="flex items-center gap-2">
                <CubeTransparentIcon className="w-4 h-4 text-text-tertiary flex-shrink-0" />
                <span className="text-control font-semibold text-text-primary truncate flex-1">
                  {p.name}
                </span>
                {!p.enabled && <Chip className="!bg-amber-500/15 !text-amber-600">disabled</Chip>}
                <Chip>v{p.version}</Chip>
              </div>
              {p.description && (
                <p className="text-[11px] text-text-tertiary line-clamp-2">{p.description}</p>
              )}
              <div className="flex items-center gap-1 mt-auto pt-1">
                <Chip>{countSummary(p.counts)}</Chip>
              </div>
            </button>
          ))}

          {notInstalled.map((name) => {
            const id = `${name}@${marketplaceName}`
            const installing = actions.pending === `install:${id}`
            return (
              <div key={name} className="extension-card extension-card-muted">
                <div className="flex items-center gap-2">
                  <CubeTransparentIcon className="w-4 h-4 text-text-tertiary flex-shrink-0" />
                  <span className="text-control font-semibold text-text-primary truncate flex-1">
                    {name}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 mt-auto pt-1">
                  <span className="text-[11px] text-text-tertiary">Not installed</span>
                  <button
                    onClick={() => actions.install(id)}
                    disabled={busy}
                    className="btn-primary btn-compact disabled:opacity-40"
                  >
                    {installing ? (
                      <ArrowPathIcon className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <ArrowDownTrayIcon className="w-3.5 h-3.5" />
                    )}
                    Install
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

// ── Level 3: one plugin / standalone → sectioned capability lists ───────────────

function CapabilitySection({
  title,
  icon: Icon,
  rows
}: {
  title: string
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
  rows: { key: string; name: string; description?: string; trailing?: React.ReactNode }[]
}) {
  if (rows.length === 0) return null
  return (
    <section className="mb-5">
      <h3 className="flex items-center gap-1.5 mb-1.5 text-[12px] font-medium text-text-secondary">
        <Icon className="w-3.5 h-3.5 opacity-60" />
        <span>{title}</span>
        <span className="text-text-tertiary font-normal">({rows.length})</span>
      </h3>
      <div className="settings-card">
        {rows.map((r) => (
          <div key={r.key} className="settings-row">
            <div className="min-w-0">
              <p className="settings-row-title truncate">{r.name}</p>
              {r.description && (
                <p className="settings-row-description line-clamp-2">{r.description}</p>
              )}
            </div>
            {r.trailing}
          </div>
        ))}
      </div>
    </section>
  )
}

/** Action bar shown above a plugin's capabilities: enable/disable + uninstall. */
function PluginActionBar({ plugin, actions }: { plugin: PluginInfo; actions: ExtensionActions }) {
  const busy = actions.pending !== null
  const toggling = actions.pending === `toggle:${plugin.id}`
  const uninstalling = actions.pending === `uninstall:${plugin.id}`
  return (
    <div className="flex items-center justify-between gap-3 mb-4 px-3 py-2 rounded-xl bg-surface-100 border border-border-subtle">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[12px] text-text-secondary truncate">
          {plugin.enabled ? 'Enabled' : 'Disabled'}
        </span>
        {plugin.scope === 'local' && <Chip>local</Chip>}
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          onClick={() => actions.toggle(plugin)}
          disabled={busy}
          className="btn-secondary btn-compact border border-border-subtle disabled:opacity-40"
        >
          {toggling && <ArrowPathIcon className="w-3.5 h-3.5 animate-spin" />}
          {plugin.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          onClick={() => actions.uninstall(plugin)}
          disabled={busy}
          className="btn-secondary btn-compact text-red-400 hover:text-red-300 disabled:opacity-40"
        >
          {uninstalling ? (
            <ArrowPathIcon className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <TrashIcon className="w-3.5 h-3.5" />
          )}
          Uninstall
        </button>
      </div>
    </div>
  )
}

function CapabilityDetail({
  skills,
  agents,
  commands,
  mcp
}: {
  skills: SkillInfo[]
  agents: AgentInfo[]
  commands: CommandInfo[]
  mcp: McpServerInfo[]
}) {
  const total = skills.length + agents.length + commands.length + mcp.length
  if (total === 0) {
    return <EmptyState icon={CubeTransparentIcon} message="This item exposes no capabilities." />
  }
  return (
    <div>
      <CapabilitySection
        title="Skills"
        icon={SparklesIcon}
        rows={skills.map((s) => ({
          key: s.path,
          name: s.name,
          description: s.description,
          trailing: s.version ? <Chip>v{s.version}</Chip> : undefined
        }))}
      />
      <CapabilitySection
        title="Agents"
        icon={CpuChipIcon}
        rows={agents.map((a) => ({
          key: a.path,
          name: a.name,
          description: a.description,
          trailing: a.model ? <Chip>{a.model}</Chip> : undefined
        }))}
      />
      <CapabilitySection
        title="Commands"
        icon={CommandLineIcon}
        rows={commands.map((c) => ({
          key: c.path,
          name: `/${c.name}`,
          description: c.description
        }))}
      />
      <CapabilitySection
        title="MCP Servers"
        icon={ServerStackIcon}
        rows={mcp.map((m, i) => ({
          key: `${m.name}:${i}`,
          name: m.name,
          description:
            m.transport === 'stdio'
              ? [m.command, ...(m.args ?? [])].filter(Boolean).join(' ')
              : m.url,
          trailing: <Chip className="!bg-accent/12 !text-accent">{m.transport}</Chip>
        }))}
      />
    </div>
  )
}

// ── MCP tab: flat grid across all scopes ───────────────────────────────────────

function McpGrid({ inv }: { inv: ExtensionsInventory }) {
  if (inv.mcpServers.length === 0) {
    return (
      <EmptyState icon={ServerStackIcon} message="No MCP servers configured for this profile." />
    )
  }
  return (
    <div className="extension-grid">
      {inv.mcpServers.map((m: McpServerInfo, i) => (
        <div key={`${m.scope}:${m.name}:${i}`} className="extension-card">
          <div className="flex items-center gap-2">
            <ServerStackIcon className="w-4 h-4 text-text-tertiary flex-shrink-0" />
            <span className="text-control font-semibold text-text-primary truncate flex-1">
              {m.name}
            </span>
            <Chip className="!bg-accent/12 !text-accent">{m.transport}</Chip>
          </div>
          <p className="text-[11px] text-text-tertiary font-mono truncate">
            {m.transport === 'stdio'
              ? [m.command, ...(m.args ?? [])].filter(Boolean).join(' ')
              : m.url}
          </p>
          {m.envKeys && m.envKeys.length > 0 && (
            <p className="text-[10px] text-text-tertiary/70 truncate">
              env: {m.envKeys.join(', ')}
            </p>
          )}
          <div className="flex items-center gap-1 mt-auto pt-1">
            <Chip>{m.scope === 'plugin' && m.source ? sourceLabel(m.source) : m.scope}</Chip>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Breadcrumb ──────────────────────────────────────────────────────────────────

function Breadcrumb({ segments }: { segments: { label: string; onClick?: () => void }[] }) {
  return (
    <div className="flex items-center gap-1 text-control mb-4 min-w-0">
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1
        return (
          <span key={i} className="flex items-center gap-1 min-w-0">
            {seg.onClick && !isLast ? (
              <button
                onClick={seg.onClick}
                className="text-text-tertiary hover:text-text-primary transition-colors truncate"
              >
                {seg.label}
              </button>
            ) : (
              <span
                className={cn(
                  'truncate',
                  isLast ? 'font-semibold text-text-primary' : 'text-text-tertiary'
                )}
              >
                {seg.label}
              </span>
            )}
            {!isLast && (
              <ChevronRightIcon className="w-3.5 h-3.5 text-text-tertiary/50 flex-shrink-0" />
            )}
          </span>
        )
      })}
    </div>
  )
}

// ── Panel shell ──────────────────────────────────────────────────────────────────

export function ExtensionsPanel() {
  const section = useSessionStore((s) => s.extensionsSection)
  const profiles = useClaudeProfileStore((s) => s.profiles)
  const selectedProfileId = useClaudeProfileStore((s) => s.selectedProfileId)

  const [profileId, setProfileId] = useState(selectedProfileId)
  const [inv, setInv] = useState<ExtensionsInventory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [drill, setDrill] = useState<Drill>({ level: 'list' })

  // Mutation state.
  const [pending, setPending] = useState<string | null>(null)
  const [result, setResult] = useState<MutationResult | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [confirm, setConfirm] = useState<{
    title: string
    message: string
    confirmLabel: string
    run: () => void
  } | null>(null)

  const multiProfile = profiles.length > 1
  const activeProfile = getClaudeProfile(profileId)
  const configDir = activeProfile.configDir || undefined

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const profile = getClaudeProfile(profileId)
      const inventory = await window.electronAPI?.extensionsGetInventory(
        profile.configDir || undefined
      )
      setInv(inventory ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to read extensions.')
    } finally {
      setLoading(false)
    }
  }, [profileId])

  useEffect(() => {
    void load()
  }, [load])

  // Reset drill + transient state when switching tab or profile.
  useEffect(() => {
    setDrill({ level: 'list' })
    setResult(null)
  }, [section, profileId])

  /**
   * Run a mutation, then re-read the inventory. One at a time (the main process
   * also serializes), so we ignore overlapping clicks. `onSuccess` runs only
   * when the CLI reports success (e.g. to navigate away from a removed item).
   */
  const runMutation = useCallback(
    async (key: string, fn: () => Promise<MutationResult | undefined>, onSuccess?: () => void) => {
      if (pending) return
      setPending(key)
      setResult(null)
      try {
        const res = await fn()
        const outcome = res ?? { ok: false, message: 'No response from the app.' }
        setResult(outcome)
        if (outcome.ok) onSuccess?.()
      } catch (e) {
        setResult({ ok: false, message: e instanceof Error ? e.message : 'Operation failed.' })
      } finally {
        setPending(null)
        await load()
      }
    },
    [pending, load]
  )

  const actions: ExtensionActions = {
    pending,
    install: (pluginId) =>
      void runMutation(`install:${pluginId}`, () =>
        window.electronAPI?.extensionsInstallPlugin(pluginId, 'user', configDir)
      ),
    uninstall: (plugin) =>
      setConfirm({
        title: 'Uninstall plugin',
        message: `Uninstall “${plugin.name}” from ${plugin.marketplace}? Its files will be removed.`,
        confirmLabel: 'Uninstall',
        run: () =>
          void runMutation(
            `uninstall:${plugin.id}`,
            () => window.electronAPI?.extensionsUninstallPlugin(plugin.id, plugin.scope, configDir),
            // If we were viewing this plugin, drop back to its marketplace.
            () => setDrill({ level: 'marketplace', name: plugin.marketplace })
          )
      }),
    toggle: (plugin) =>
      void runMutation(`toggle:${plugin.id}`, () =>
        window.electronAPI?.extensionsSetPluginEnabled(
          plugin.id,
          !plugin.enabled,
          plugin.scope,
          configDir
        )
      ),
    removeMarketplace: (name) =>
      setConfirm({
        title: 'Remove marketplace',
        message: `Remove “${name}”? Plugins installed from it will no longer receive updates.`,
        confirmLabel: 'Remove',
        run: () =>
          void runMutation(
            `mkt-remove:${name}`,
            () => window.electronAPI?.extensionsRemoveMarketplace(name, configDir),
            () => setDrill({ level: 'list' })
          )
      })
  }

  const handleAddMarketplace = (source: string) => {
    void runMutation(
      'mkt-add',
      () => window.electronAPI?.extensionsAddMarketplace(source, configDir),
      () => setAddOpen(false)
    )
  }

  // Resolve the active plugin for the plugin level.
  const activePlugin =
    drill.level === 'plugin' ? (inv?.plugins.find((p) => p.id === drill.id) ?? null) : null

  // Build the breadcrumb for the marketplaces tab.
  const crumbs: { label: string; onClick?: () => void }[] = [
    { label: 'Marketplaces', onClick: () => setDrill({ level: 'list' }) }
  ]
  if (drill.level === 'marketplace') crumbs.push({ label: drill.name })
  if (drill.level === 'standalone') crumbs.push({ label: 'Standalone' })
  if (drill.level === 'plugin' && activePlugin) {
    crumbs.push({
      label: activePlugin.marketplace,
      onClick: () => setDrill({ level: 'marketplace', name: activePlugin.marketplace })
    })
    crumbs.push({ label: activePlugin.name })
  }

  const showAddMarketplace = section === 'marketplaces' && drill.level === 'list'

  return (
    <div className="settings-scroller">
      <div className="max-w-4xl mx-auto w-full">
        {/* Header: title/breadcrumb + profile picker + actions */}
        <div className="flex items-center justify-between mb-5 gap-3">
          <div className="min-w-0">
            {section === 'mcp' ? (
              <h2 className="text-lg font-semibold text-text-primary">MCP Servers</h2>
            ) : (
              <Breadcrumb segments={crumbs} />
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {showAddMarketplace && (
              <button
                onClick={() => setAddOpen(true)}
                disabled={pending !== null}
                className="btn-secondary btn-compact border border-border-subtle disabled:opacity-40"
              >
                <PlusIcon className="w-3.5 h-3.5" />
                Add marketplace
              </button>
            )}
            {multiProfile && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="btn-secondary btn-compact border border-border-subtle">
                    {activeProfile.label}
                    {activeProfile.id === DEFAULT_CLAUDE_PROFILE_ID && (
                      <span className="text-text-tertiary"> · default</span>
                    )}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Profile</DropdownMenuLabel>
                  {profiles.map((p) => (
                    <DropdownMenuItem key={p.id} onSelect={() => setProfileId(p.id)}>
                      <span className="flex-1 truncate">{p.label}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <button
              onClick={() => void load()}
              className="btn-icon btn-icon-sm"
              title="Refresh"
              aria-label="Refresh extensions"
            >
              <ArrowPathIcon className={cn('w-4 h-4', loading && 'animate-spin')} />
            </button>
          </div>
        </div>

        {/* Mutation result banner */}
        {result && (
          <div
            className={cn(
              'flex items-start gap-2 mb-4 px-3 py-2 rounded-xl border text-[12px]',
              result.ok
                ? 'bg-green-500/8 border-green-500/20 text-text-secondary'
                : 'bg-red-500/8 border-red-500/20 text-red-500'
            )}
          >
            {result.ok ? (
              <CheckCircleIcon className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
            ) : (
              <XCircleIcon className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            )}
            <div className="min-w-0 space-y-0.5">
              {result.ok ? (
                <p>Done. Restart your Claude sessions to apply the change.</p>
              ) : (
                <p className="whitespace-pre-wrap break-words">{result.message}</p>
              )}
            </div>
          </div>
        )}

        {inv && inv.warnings.length > 0 && (
          <div className="flex items-start gap-2 mb-4 px-3 py-2 rounded-xl bg-amber-500/8 border border-amber-500/20">
            <ExclamationTriangleIcon className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-[12px] text-text-secondary space-y-0.5">
              {inv.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="px-3 py-2 rounded-xl bg-red-500/8 border border-red-500/20 text-control text-red-500">
            {error}
          </div>
        )}

        {!error && loading && !inv && (
          <p className="text-control text-text-tertiary py-16 text-center">Reading extensions…</p>
        )}

        {!error && inv && section === 'mcp' && <McpGrid inv={inv} />}

        {!error && inv && section === 'marketplaces' && (
          <>
            {drill.level === 'list' && <MarketplacesGrid inv={inv} onOpen={setDrill} />}
            {drill.level === 'marketplace' && (
              <MarketplaceView
                inv={inv}
                marketplaceName={drill.name}
                onOpenPlugin={(id) => setDrill({ level: 'plugin', id })}
                actions={actions}
              />
            )}
            {drill.level === 'standalone' && (
              <CapabilityDetail
                skills={inv.userSkills}
                agents={inv.userAgents}
                commands={inv.userCommands}
                mcp={inv.mcpServers.filter((m) => m.scope === 'user')}
              />
            )}
            {drill.level === 'plugin' &&
              (activePlugin ? (
                <>
                  <PluginActionBar plugin={activePlugin} actions={actions} />
                  <CapabilityDetail
                    skills={activePlugin.skills}
                    agents={activePlugin.agents}
                    commands={activePlugin.commands}
                    mcp={activePlugin.mcpServers}
                  />
                </>
              ) : (
                <EmptyState icon={CubeTransparentIcon} message="Plugin not found." />
              ))}
          </>
        )}
      </div>

      <AddMarketplaceDialog
        isOpen={addOpen}
        busy={pending === 'mkt-add'}
        onAdd={handleAddMarketplace}
        onCancel={() => setAddOpen(false)}
      />

      <ConfirmDialog
        isOpen={confirm !== null}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmLabel={confirm?.confirmLabel}
        onConfirm={() => {
          confirm?.run()
          setConfirm(null)
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  )
}

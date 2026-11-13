/**
 * What the launcher menu offers on one machine, as data: the harnesses
 * listed (and the ones detection says are absent), each with its models,
 * the connections that pay for them (the suggested one marked, each with its
 * headroom in the launcher's own words) and its launch profiles.
 *
 * ONE pure function behind every road that answers "what can I launch
 * here?" for an agent (`clave_launch_options`): the daemon's tool, the Mac's
 * served tool and the window's dispatcher each assemble plain inputs and call
 * `launchOptions`. The menu itself (`SessionLauncher.tsx`) keeps its own
 * code; the rules here are read from it and from the served road's
 * `accountForLaunch` (`src/main/mcp/served-accounts.ts`), and must say the
 * same thing.
 *
 * Pure: the clock is `input.now`, nothing is imported from main or the
 * renderer.
 */
import {
  HARNESSES,
  HARNESS_BY_ID,
  type Harness,
  type HarnessId,
  type HarnessSettingsById,
  type InteractionMode
} from './harness'
import { chatProfileSource, type LaunchProfile } from './agent-launch'
import {
  isExhausted,
  pickAccount,
  type AccountUsageSummary,
  type PoolAccount
} from './account-pool'
import { usageSummaryForModel } from './usage-summary'
import {
  isAccountPoolId,
  poolAccountOf,
  type AccountPoolId,
  type Connection,
  type ConnectionPoolId
} from './connection'
import { isChatProfileRef } from './open-session-modes'
import { pickProviderConnection } from './provider-connection-pick'
import { capName, capStatusLine, formatResetIn } from './cap-status'

/** What agent-updates knows of a harness on the machine; undefined when this road never checks (the Mac's view of a server). */
export interface HarnessPresence {
  readonly installed: boolean
  readonly version: string | null
  readonly checkedAt: number | null
}
/** A pool member with its usage: a `ServedPoolAccount` (served-core.ts) or a
 *  `Connection` (connection.ts); the facts give both at once, so a row keeps
 *  `pool`, `company`, `kind`, `reportsUsage` and `usage` as the pool states them. */
export type PooledConnection = PoolAccount & {
  readonly label: string
  readonly usage?: AccountUsageSummary | undefined
  readonly reportsUsage?: boolean
}
export interface LaunchModel {
  readonly id: string | null
  readonly label: string
  readonly family: string
}
export interface LaunchOptionsInput {
  readonly machine: { readonly id: string; readonly name: string }
  /** HARNESSES, in table order. */
  readonly harnesses: readonly Harness[]
  readonly presence: (harness: HarnessId) => HarnessPresence | undefined
  /** Built-ins + the person's, of that family, chat forms included. */
  readonly profiles: (harness: HarnessId) => readonly LaunchProfile[]
  readonly defaultProfileId: (harness: HarnessId) => string | undefined
  /** The launch profile an open that names no profile and no chat flag
   *  resolves on this road: the harness's chat default under a chat
   *  interaction mode, else its default profile. `defaultModel` is judged on
   *  it, never on `defaultProfileId` (a chat open runs the remembered chat
   *  model, a terminal profile has none: verifier, round 2). */
  readonly openProfileId: (harness: HarnessId) => string | undefined
  /** The harness's list; 'unavailable' when the list could not be read. */
  readonly models: (harness: HarnessId) => readonly LaunchModel[] | 'unavailable'
  readonly harnessSettings: HarnessSettingsById
  readonly interactionMode: InteractionMode
  /** A pool's rows for `harness`: an account pool its accounts; a provider
   *  pool (PRDCT-4496) the stored connections of that company serving a wire
   *  format the harness speaks (`servesHarnessPool`), as its open reads them. */
  readonly connections: (pool: ConnectionPoolId, harness: Harness) => readonly PooledConnection[]
  readonly selectedConnectionId: (pool: ConnectionPoolId) => string | undefined
  readonly preferRecommended: boolean
  /** The remembered chat model when none is named. */
  readonly launchModel: (pool: string, profileId: string | undefined) => string | undefined
  readonly now: number
}
export interface ConnectionWindow {
  readonly name: string
  readonly kind: string
  readonly scope: string | null
  readonly leftPercent: number
  readonly resetsAt: number | null
  readonly resetIn: string | null
}
export type ConnectionOption = PooledConnection & {
  readonly pool: string
  readonly suggested: boolean
  readonly exhausted: boolean
  readonly headroom: string | null
  readonly windows: readonly ConnectionWindow[]
}
export interface ModelOption extends LaunchModel {
  readonly served: boolean
  readonly reason: string | null
}
export interface ProfileOption {
  readonly id: string
  readonly name: string
  readonly form: 'chat' | 'terminal'
  readonly default: boolean
}
export interface HarnessOptions {
  readonly id: HarnessId
  readonly name: string
  readonly installed: boolean | null
  readonly version: string | null
  readonly takesModel: boolean
  readonly chatView: boolean
  /** The model a tab opens on when the open passes none (the remembered
   *  chat model), null for the harness's own default. The connections are
   *  judged on it. */
  readonly defaultModel: string | null
  /** The model the launcher's row opens on; pass it as model to get the same tab. */
  readonly launcherModel: string | null
  readonly models: readonly ModelOption[]
  readonly connections: readonly ConnectionOption[]
  readonly connectionNote: string | null
  readonly profiles: readonly ProfileOption[]
}
export interface LaunchOptions {
  readonly machine: { readonly id: string; readonly name: string }
  readonly interactionMode: InteractionMode
  readonly harnesses: readonly HarnessOptions[]
  readonly notInstalled: readonly string[]
}

/** The launcher's DEFAULT_MODEL (`SessionLauncher.tsx`): the harness's own
 *  default, no flag passed. */
const DEFAULT_MODEL: LaunchModel = { id: null, label: 'Default', family: 'Default' }

/** The connection pools a harness runs on, in order: the one accessor the
 *  listing, the routines and the daemon's tools read (`connectionPools`). */
export function poolsOf(harness: Pick<Harness, 'connectionPools'>): readonly ConnectionPoolId[] {
  return harness.connectionPools
}

/** The pools of a harness backed by an account list (Claude, Codex): the
 *  ones a launch naming no connection picks from, and a running tab moves
 *  along. Pi's and OpenCode's provider pools are not: an `account` names one
 *  of their stored connections (`provider-connection-pick.ts`, PRDCT-4496),
 *  and naming none runs on the harness's own login. */
export function accountPoolsOf(
  harness: Pick<Harness, 'connectionPools'>
): readonly AccountPoolId[] {
  return harness.connectionPools.filter(isAccountPoolId)
}

/** The refusal of an `account` on an open whose mode has no pool, in the one
 *  sentence every open road says (the Mac's served road, the window's local
 *  and server opens; the daemon's and a routine's read the same words): the
 *  harnesses that take one, then why this mode does not (its harness signs
 *  in by itself, a terminal runs none). `gemini` is Antigravity's alias. */
export function accountArgumentRefusal(mode: string): string {
  const pooled = HARNESSES.filter((h) => poolsOf(h).length > 0)
    .map((h) => h.name)
    .join(', ')
  const harness = HARNESS_BY_ID[(mode === 'gemini' ? 'antigravity' : mode) as HarnessId]
  const why = harness
    ? `${harness.name} runs on the login inside the harness.`
    : `a ${mode} runs no harness.`
  return `The account argument applies to harnesses with a connection pool (${pooled}); ${why}`
}

/** The connection a launch naming none would start on: the served road's
 *  `accountForLaunch` rule (`served-accounts.ts`). Each connection judged
 *  for `model`'s caps; the selected one (else `default`) kept while it has
 *  headroom, the menu's recommendation when the person opted in. */
export function suggestedConnection(
  connections: readonly PooledConnection[],
  selectedId: string | undefined,
  preferRecommended: boolean,
  model: string | undefined
): string {
  return pickAccount({
    accounts: connections.map((c) =>
      'reportsUsage' in c
        ? poolAccountOf(c as unknown as Connection)
        : { id: c.id, usable: c.usable, ...(c.fallback ? { fallback: true } : {}) }
    ),
    usage: Object.fromEntries(connections.map((c) => [c.id, usageSummaryForModel(c.usage, model)])),
    preferredId: selectedId ?? 'default',
    preferRecommended
  })
}

/** Listed unless a CHECK said the harness is absent, or listed anyway when
 *  the person saved a profile of their own for it (the launcher's
 *  `harnessPresent`, `harness-presence.ts`). */
function listed(
  presence: HarnessPresence | undefined,
  profiles: readonly LaunchProfile[]
): boolean {
  if (!presence || presence.installed || presence.checkedAt === null) return true
  return profiles.some((profile) => !profile.builtIn && !chatProfileSource(profile.id))
}

function windowsOf(usage: AccountUsageSummary | undefined, now: number): ConnectionWindow[] {
  return (usage?.windows ?? []).map((w) => ({
    name: capName(w),
    kind: w.kind,
    scope: w.scope ?? null,
    leftPercent: Math.max(0, Math.round(100 - w.usedPercentage)),
    resetsAt: w.resetsAt ?? null,
    resetIn: formatResetIn(w.resetsAt ?? null, now)
  }))
}

function harnessOptions(
  input: LaunchOptionsInput,
  harness: Harness,
  presence: HarnessPresence | undefined,
  profiles: readonly LaunchProfile[]
): HarnessOptions {
  const { id } = harness
  const pools = poolsOf(harness)
  // Lane C of the harness wave (PRDCT-4496): Pi and OpenCode list the stored
  // provider connections of their pools, and still run on the login inside
  // the harness when none is named: only an account pool remembers a model
  // or holds every model up to its connections.
  const accountPool = accountPoolsOf(harness)[0]
  const defaultProfileId = input.defaultProfileId(id)
  // What an open passing no model lands on: the remembered chat model of
  // the profile that open resolves (the chat default under a chat
  // interaction mode), else the harness's own default (null). The
  // launcher's row passes its preferred model instead (`launcherModel`).
  const defaultModel =
    harness.takesModel && accountPool
      ? (input.launchModel(accountPool, input.openProfileId(id)) ?? null)
      : null
  const launcherModel = input.harnessSettings[id]?.preferredModel ?? null
  const model = defaultModel ?? undefined

  // The provider pools (PRDCT-4496) suggest ONE connection across them, the
  // one an open naming `account: "any"` lands on (`pickProviderConnection`
  // over the same rows in the same order); naming none still runs on the
  // harness's own login.
  const providerPick = pickProviderConnection(
    pools
      .filter((pool) => !isAccountPoolId(pool))
      .flatMap((pool) => input.connections(pool, harness)),
    undefined
  )
  const providerSuggested = providerPick.ok ? providerPick.connection.id : null
  const connections: ConnectionOption[] = pools.flatMap((pool) => {
    const rows = input.connections(pool, harness)
    const suggested = isAccountPoolId(pool)
      ? suggestedConnection(rows, input.selectedConnectionId(pool), input.preferRecommended, model)
      : providerSuggested
    return rows.map((c) => ({
      ...c,
      pool,
      suggested: c.id === suggested,
      exhausted: isExhausted(usageSummaryForModel(c.usage, model)),
      // With no model named, the account view: its shared headroom and
      // every family that is out ("72% left · Overall · Fable out · …").
      headroom: c.usage
        ? capStatusLine(model ? usageSummaryForModel(c.usage, model) : c.usage, {
            now: input.now,
            reset: 'in'
          })
        : null,
      windows: windowsOf(c.usage, input.now)
    }))
  })
  const all = pools.flatMap((pool) => input.connections(pool, harness))

  const listedModels = harness.takesModel ? input.models(id) : []
  const models: ModelOption[] = (
    listedModels === 'unavailable' ? [DEFAULT_MODEL] : listedModels
  ).map((m) => {
    const served =
      listedModels === 'unavailable' ||
      !accountPool ||
      all.length === 0 ||
      all.some((c) => c.usable && !isExhausted(usageSummaryForModel(c.usage, m.id ?? undefined)))
    return { ...m, served, reason: served ? null : `No connection with ${m.family} credits` }
  })

  return {
    id,
    name: harness.name,
    installed: presence ? presence.installed : null,
    version: presence?.version ?? null,
    takesModel: harness.takesModel,
    chatView: harness.chatAdapterId !== null,
    defaultModel,
    launcherModel,
    models,
    connections,
    connectionNote:
      pools.length === 0 || (!accountPool && all.length === 0)
        ? `Clave holds no connection for ${harness.name}: it runs on the login inside the harness.`
        : !accountPool
          ? `Clave holds stored connections for ${harness.name}: name one as account (a label, an id, or "any" for the suggested one, the first with a key); with no account, it runs on the login inside the harness.`
          : null,
    profiles: profiles.map((p) => ({
      id: p.id,
      name: p.name,
      form: isChatProfileRef(id, p.id) || chatProfileSource(p.id) ? 'chat' : 'terminal',
      default: p.id === defaultProfileId
    }))
  }
}

/** What the launcher offers on the machine the input describes. */
export function launchOptions(input: LaunchOptionsInput): LaunchOptions {
  const harnesses: HarnessOptions[] = []
  const notInstalled: string[] = []
  for (const harness of input.harnesses) {
    const presence = input.presence(harness.id)
    const profiles = input.profiles(harness.id)
    if (!listed(presence, profiles)) {
      notInstalled.push(harness.name)
      continue
    }
    harnesses.push(harnessOptions(input, harness, presence, profiles))
  }
  return {
    machine: { id: input.machine.id, name: input.machine.name },
    interactionMode: input.interactionMode,
    harnesses,
    notInstalled
  }
}

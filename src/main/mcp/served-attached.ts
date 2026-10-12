/**
 * The attached road of the last seven agent tools (wave 4, PRDCT-3377). An
 * app attached to a server running apart from it keeps its windows and its
 * sidebar in the shell, while the sessions, their records, the accounts, the
 * launch profiles and the pins are the server's. The tools read the shell's
 * facts through `ServedShell`; attached, the facts a tool needs are fetched
 * from the server once per call, before the tool runs, and the shell is
 * answered from them (`attachedShell`): the records the host lists, with
 * the serving sessions found by their link; the accounts of a provider with
 * their usage summarized; the launch profiles; the pins. What the shell owns
 * either way (the windows, the preferences, the lineage, the capture) stays
 * the base shell's. Lane C of this wave made the records and the agent
 * tokens the server's; this file is what the tools stand on there.
 */
import type { ClaveApiClient } from '@clave/client'
import type { SessionRecord as WireRecord } from '@clave/contract/sessions'
import type { SessionRecord } from '../sessions/adapters/pty-backend'
import { BUILT_IN_LAUNCH_PROFILES } from '../../shared/agent-launch'
import type { PinnedBlueprint } from '../../shared/pinned-blueprint'
import { usageSummaryOf } from '../../shared/usage-summary'
import type { AccountProvider, ServedPoolAccount, ServedShell, ToolWindow } from './served-core'

/** What each command reads of the server before it runs. */
const NEEDS: Record<string, ReadonlyArray<'records' | 'accounts' | 'profiles' | 'pins'>> = {
  rename: [],
  setSessionView: ['records'],
  readSession: ['records'],
  sendToSession: ['records'],
  switchAccount: ['records', 'accounts'],
  openSession: ['records', 'accounts', 'profiles'],
  launchGroup: ['records', 'accounts', 'pins']
}

/** The commands that take the attached road: the wave 4 seven. The wave 3
 *  tools keep the window attached, as their record says. */
export const ATTACHED_COMMANDS: ReadonlySet<string> = new Set(Object.keys(NEEDS))

const asRecord = (wire: WireRecord): SessionRecord => wire as unknown as SessionRecord

async function fetchAccounts(
  api: ClaveApiClient
): Promise<Record<AccountProvider, ServedPoolAccount[]>> {
  const [claude, codex, claudeUsage, codexUsage] = await Promise.all([
    api.settings.claudeAccounts.list(),
    api.settings.codexAccounts.list(),
    api.settings.usage.claudeSnapshot().catch(() => ({})),
    api.settings.usage.codexSnapshot().catch(() => ({}))
  ])
  const summary = (
    snapshot: Record<string, { windows?: ReadonlyArray<never> } | { error: string }>,
    id: string
  ): { usage?: ServedPoolAccount['usage'] } => {
    const read = snapshot[id]
    const usage = read && 'windows' in read ? usageSummaryOf(read) : undefined
    return usage ? { usage } : {}
  }
  return {
    claude: claude.map((a) => ({
      id: a.id,
      label: a.label,
      usable: a.id === 'default' || (a.hasToken && !a.tokenInvalid),
      ...summary(claudeUsage as never, a.id)
    })),
    codex: codex.map((a) => ({
      id: a.id,
      label: a.label,
      usable: a.hasCredential,
      ...(a.kind === 'apiKey' ? { fallback: true } : {}),
      ...summary(codexUsage as never, a.id)
    }))
  }
}

/** The base shell with the server's facts in front of it, for one call. */
export async function attachedShell<W extends ToolWindow>(
  base: ServedShell<W>,
  api: ClaveApiClient,
  command: string
): Promise<ServedShell<W>> {
  const needs = NEEDS[command] ?? []
  const records = new Map<string, SessionRecord>()
  const loadRecords = async (): Promise<void> => {
    const all = (await api.sessions.listAdoptable().catch(() => [])) ?? []
    records.clear()
    for (const r of all) records.set(r.id, asRecord(r))
  }
  const [accounts, profiles, pins] = await Promise.all([
    needs.includes('records') ? loadRecords() : Promise.resolve(),
    needs.includes('accounts') ? fetchAccounts(api) : Promise.resolve(null),
    needs.includes('profiles')
      ? api.settings.launchProfiles.list().then((p) => p.customProfiles)
      : Promise.resolve(null),
    needs.includes('pins')
      ? api.settings.workspaces.load().then((s) => s.pins as unknown as PinnedBlueprint[])
      : Promise.resolve(null)
  ]).then(([, a, p, pins]) => [a, p, pins] as const)
  return {
    ...base,
    record: (id) => base.record(id) ?? records.get(id),
    servingSessionsOf: (ownerId) => [
      ...base.servingSessionsOf(ownerId),
      ...[...records.values()]
        .filter((r) => r.link?.kind === 'session-view' && r.link.ownerId === ownerId)
        .map((r) => r.id)
    ],
    syncRecords: () => loadRecords(),
    accounts: (provider) => accounts?.[provider] ?? base.accounts(provider),
    launchProfiles: (family) =>
      profiles
        ? [...BUILT_IN_LAUNCH_PROFILES, ...profiles]
            .filter((p) => p.family === family)
            .map(({ id, name }) => ({ id, name }))
        : base.launchProfiles(family),
    pins: () => pins ?? base.pins()
  }
}

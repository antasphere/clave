/**
 * What Pi and OpenCode tabs used, per connection (PRDCT-4551), computed on
 * the host that runs the tabs (this Mac, or a Clave server) and answered
 * through the settings source and one query (`ReadHarnessUsage`), the way
 * `readPi` and `ReadProviderUsage` travel.
 *
 * The figures are the harnesses' own records, read and never copied: Pi's
 * session files (`pi-usage.ts`), OpenCode's sessions through its own
 * commands (`opencode-usage.ts`). The ledger of starts (`usage-ledger.ts`)
 * says which connection each session ran on when; the rule of attribution
 * (`usage-attribution.ts`) counts each record to one row. Local reads only:
 * nothing here spends, and nothing reads on a clock of its own.
 */
import path from 'path'
import { execFile } from 'child_process'
import fs from 'fs'
import {
  type HarnessUsageBilling,
  type HarnessUsageRange,
  type HarnessUsageRow,
  type HarnessUsageView,
  type UsageHarness,
  EMPTY_FIGURES,
  USAGE_HARNESSES
} from '@clave/contract/settings/harness-usage-view'
import type { ProviderCompanyId } from '@clave/contract/settings/provider-catalogue'
import {
  attributeUsage,
  rangeStart,
  rowKey,
  type LedgerLine,
  type UsageRecord
} from './usage-attribution'
import { usageLedger } from './usage-ledger'
import { PiSessionRecords, type PiSessionRecord } from './pi-usage'
import {
  OpencodeSessionRecords,
  type OpencodeSessionRecord,
  type OpencodeRun
} from './opencode-usage'
import { PROVIDER_USAGE_ROADS } from './provider-usage'
import { connectionModelProvider } from './provider-injection'

/** A stored connection as the usage rows list it: no value. */
export interface UsageConnection {
  id: string
  label: string
  company: string
}

export const SIGN_IN_LABEL: Readonly<Record<UsageHarness, string>> = {
  pi: 'Pi sign-in',
  opencode: 'OpenCode sign-in'
}

/** How a connection of this company is paid for, from its provider line
 *  (`PROVIDER_USAGE_ROADS`): a coding plan or a local model bills nothing
 *  per token; every other provider is paid per use. */
export function billingOf(company: string | null | undefined): HarnessUsageBilling {
  const road = company ? PROVIDER_USAGE_ROADS[company as ProviderCompanyId] : undefined
  if (road && 'kind' in road) {
    if (road.kind === 'plan') return 'plan'
    if (road.kind === 'local') return 'local'
  }
  return 'payPerUse'
}

/** The provider a connection of this company gives a harness. */
export function providerOfCompany(company: string, harness: UsageHarness): string | undefined {
  try {
    return connectionModelProvider(company as ProviderCompanyId, harness)
  } catch {
    return undefined
  }
}

export interface HarnessUsageInputs {
  range: HarnessUsageRange
  now: Date
  ledger: readonly LedgerLine[]
  records: readonly UsageRecord[]
  /** The current connections serving each harness, in the store's order. */
  connections: (harness: UsageHarness) => readonly UsageConnection[]
  unavailable?: HarnessUsageView['unavailable']
}

/**
 * The rows a person reads, pure over its inputs: per harness, every current
 * connection serving it (zeros included), its own sign-in, then each
 * removed connection that counted something in the range, under the label
 * the ledger recorded last.
 */
export function harnessUsageRows(input: HarnessUsageInputs): HarnessUsageView {
  const attributed = attributeUsage({
    records: input.records,
    ledger: input.ledger,
    range: input.range,
    now: input.now,
    providerOf: providerOfCompany
  })
  const current = new Set(USAGE_HARNESSES.flatMap((h) => input.connections(h).map((c) => c.id)))
  const lastLine = new Map<string, LedgerLine>()
  for (const line of [...input.ledger].sort((a, b) => a.at - b.at))
    if (line.connectionId) lastLine.set(line.connectionId, line)
  const rows: HarnessUsageRow[] = []
  for (const harness of USAGE_HARNESSES) {
    const figuresOf = (connectionId: string | null): typeof EMPTY_FIGURES => ({
      ...(attributed.get(rowKey(harness, connectionId))?.figures ?? EMPTY_FIGURES)
    })
    for (const c of input.connections(harness))
      rows.push({
        harness,
        connectionId: c.id,
        label: c.label,
        billing: billingOf(c.company),
        removed: false,
        ...figuresOf(c.id)
      })
    rows.push({
      harness,
      connectionId: null,
      label: SIGN_IN_LABEL[harness],
      billing: 'signIn',
      removed: false,
      ...figuresOf(null)
    })
    for (const row of attributed.values()) {
      if (row.harness !== harness || !row.connectionId) continue
      if (input.connections(harness).some((c) => c.id === row.connectionId)) continue
      const line = lastLine.get(row.connectionId)
      rows.push({
        harness,
        connectionId: row.connectionId,
        label: line?.label ?? 'Removed connection',
        billing: billingOf(line?.company),
        // Gone from this host, or no longer serving this harness: listed
        // here alone, as Settings → Usage keeps the past.
        removed: !current.has(row.connectionId),
        ...row.figures
      })
    }
  }
  return { range: input.range, rows, unavailable: [...(input.unavailable ?? [])] }
}

export interface HarnessUsageDeps {
  ledger: () => readonly LedgerLine[]
  /** Pi's session folders on this host. */
  piRoots: () => readonly string[]
  /** OpenCode's records since a moment; null when OpenCode is not here, a
   *  rejection when its records could not be read. */
  opencode: (() => ((since: number) => Promise<OpencodeSessionRecord[]>) | null) | null
  connections: (harness: UsageHarness) => readonly UsageConnection[]
  now?: () => Date
  /** How long an answer waits on OpenCode's read; 1.5 s when absent. */
  opencodeWaitMs?: number
}

const OPENCODE_ABSENT = 'OpenCode is not installed here.'
const OPENCODE_FAILED = "OpenCode's records could not be read."

export class HarnessUsage {
  private readonly pi = new PiSessionRecords()
  private opencodeRead: { since: number; read: Promise<OpencodeSessionRecord[]> } | null = null
  /** The records of the last OpenCode read that finished. */
  private lastOpencode: OpencodeSessionRecord[] = []

  constructor(private readonly deps: HarnessUsageDeps) {}

  /** OpenCode's records since a moment. Reads that overlap share one when it
   *  covers the range asked (the commands are a process each); a wider range
   *  waits for the read in flight, then reads what that one skipped. */
  private opencodeFor(
    reader: (since: number) => Promise<OpencodeSessionRecord[]>,
    since: number
  ): Promise<OpencodeSessionRecord[]> {
    const current = this.opencodeRead
    if (current && current.since <= since) return current.read
    const read = (current ? current.read.catch(() => []) : Promise.resolve([]))
      .then(() => reader(since))
      .finally(() => {
        if (this.opencodeRead?.read === read) this.opencodeRead = null
      })
    this.opencodeRead = { since, read }
    return read
  }

  async read(range: HarnessUsageRange): Promise<HarnessUsageView> {
    const now = (this.deps.now ?? (() => new Date()))()
    const unavailable: { harness: UsageHarness; reason: string }[] = []
    const records: UsageRecord[] = []
    let piRecords: PiSessionRecord[] = []
    try {
      piRecords = this.pi.read(this.deps.piRoots())
    } catch {
      unavailable.push({ harness: 'pi', reason: "Pi's records could not be read." })
    }
    for (const r of piRecords) records.push({ harness: 'pi', ...r })
    const reader = this.deps.opencode?.() ?? null
    const reading: UsageHarness[] = []
    if (!reader) unavailable.push({ harness: 'opencode', reason: OPENCODE_ABSENT })
    else {
      // A first read of many sessions is a process per session (150 took
      // 21 s on 2.3.0): the answer never waits past the budget. It carries
      // the records last read and says OpenCode is still being read; the
      // read runs on, and the window asks again.
      const since = rangeStart(range, now)
      const read = this.opencodeFor(reader, since)
      const TIMEOUT = Symbol('timeout')
      let timer: ReturnType<typeof setTimeout> | undefined
      const waited = await Promise.race([
        read.then(
          (r) => r,
          () => null
        ),
        new Promise<typeof TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT), this.deps.opencodeWaitMs ?? 1500)
        })
      ])
      clearTimeout(timer)
      if (waited === TIMEOUT) {
        reading.push('opencode')
        for (const r of this.lastOpencode) records.push({ harness: 'opencode', ...r })
      } else if (waited === null) {
        unavailable.push({ harness: 'opencode', reason: OPENCODE_FAILED })
      } else {
        this.lastOpencode = waited
        for (const r of waited) records.push({ harness: 'opencode', ...r })
      }
    }
    return {
      ...harnessUsageRows({
        range,
        now,
        ledger: this.deps.ledger(),
        records,
        connections: this.deps.connections,
        unavailable
      }),
      reading
    }
  }
}

// ── The app's instance ──────────────────────────────────────────────────────

/** `opencode <args>` on the login shell's environment, its output answered. */
export function opencodeRunner(binary: string, env: NodeJS.ProcessEnv): OpencodeRun {
  return (args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(
        binary,
        args,
        { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL' },
        (error, stdout) => (error ? reject(new Error('opencode failed')) : resolve(stdout))
      )
    })
}

/** Pi's session folders: Clave's override or the person's own (the login
 *  shell's `PI_CODING_AGENT_DIR`, else `~/.pi/agent`), and each connection
 *  directory whose `sessions` is a folder of its own (a person whose first
 *  Pi ran on a connection, `provider-injection-pi-dir.ts`). Under the test
 *  flag the person's own folder is read only when a spec names one. */
export function piSessionRoots(input: {
  override: string | undefined
  homeAgentDir: () => string
  connectionsRoot: string
  testMode: boolean
}): string[] {
  const roots: string[] = []
  if (input.override) roots.push(input.override)
  else if (!input.testMode) roots.push(path.join(input.homeAgentDir(), 'sessions'))
  let ids: string[] = []
  try {
    ids = fs.readdirSync(input.connectionsRoot)
  } catch {
    ids = []
  }
  for (const id of ids) {
    const sessions = path.join(input.connectionsRoot, id, 'sessions')
    try {
      if (fs.lstatSync(sessions).isDirectory()) roots.push(sessions)
    } catch {
      // No session of its own.
    }
  }
  return roots
}

let instance: HarnessUsage | null = null

/** The host's reader, built on first use: its graph reaches the terminal
 *  backend (the login shell's environment), which the settings source's own
 *  graph must not load at boot. */
export async function harnessUsage(): Promise<HarnessUsage> {
  if (instance) return instance
  const ledger = usageLedger
  const { lazySettingsPorts } = await import('./ports/registry')
  const { getLoginShellEnv } = await import('./sessions/adapters/pty-backend')
  const { piHomeAgentDir, providerConnectionsForListing } =
    await import('./provider-injection-spawn')
  const { findExecutable } = await import('./shell-launch')
  const { TEST_NO_ACTIVATE } = await import('./test-mode')
  const runners = new Map<string, OpencodeSessionRecords>()
  instance = new HarnessUsage({
    ledger: () => ledger.read(),
    piRoots: () =>
      piSessionRoots({
        override: process.env.CLAVE_PI_ROOT,
        homeAgentDir: () => piHomeAgentDir(),
        connectionsRoot: lazySettingsPorts.storage.pathOf('pi-connections'),
        testMode: TEST_NO_ACTIVATE
      }),
    opencode: () => {
      // An instance under test reads OpenCode only where a spec put a stand-in.
      if (TEST_NO_ACTIVATE && process.env.CLAVE_E2E_OPENCODE_USAGE !== '1') return null
      const env = getLoginShellEnv()
      const binary = findExecutable('opencode', env.PATH)
      if (!binary) return null
      let reader = runners.get(binary)
      if (!reader) {
        reader = new OpencodeSessionRecords(opencodeRunner(binary, env))
        runners.set(binary, reader)
      }
      const r = reader
      return (since) => r.read(since)
    },
    connections: (harness) =>
      providerConnectionsForListing(harness).map((c) => ({
        id: c.id,
        label: c.label,
        company: c.company
      }))
  })
  return instance
}

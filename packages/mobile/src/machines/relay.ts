/**
 * The machines of the person, from the relay (decision 4 of the spec, lane
 * E's contract, verbatim from its brief): `GET <relay>/machines` with the
 * hub's access token as bearer answers `{machines: [{id, name, platform,
 * version, online, lastSeen, direct: [{url}]}]}`; a machine is reached at
 * `<relay>/m/<id>/<path>` over HTTP and `<relay>/m/<id>/push` for the
 * socket, the device session's bearer travelling through; 401 on a bad hub
 * token, 404 on an unknown machine, 503 on an offline one.
 *
 * The hub token is lane D's (the sign-in): this source takes a supplier.
 * The Machine shape carries one base URL, so it is the relay road; trying
 * a direct address first (decision 4) is owed to the integration.
 */
import type { FetchLike } from '../api/client'
import { ServerError } from '../api/errors'
import { assertCredentialMayTravelTo, type BuildKind } from './transport-policy'
import type { Machine, MachinePlatform, MachineSource } from './types'

export type TokenSupplier = () => Promise<string>

export interface RelayMachineSourceOptions {
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  /** Which build this is (`transport-policy.ts`); release by default. */
  readonly build?: BuildKind
}

const platformOf = (value: unknown): MachinePlatform =>
  value === 'macos' || value === 'linux' ? value : 'unknown'

const lastSeenOf = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

export const machineBaseUrl = (relayUrl: string, machineId: string): string =>
  `${relayUrl.replace(/\/+$/, '')}/m/${encodeURIComponent(machineId)}`
export const machinePushUrl = (relayUrl: string, machineId: string): string =>
  `${machineBaseUrl(relayUrl, machineId)}/push`

export class RelayMachineSource implements MachineSource {
  private readonly fetch: FetchLike
  private readonly timeoutMs: number

  constructor(
    private readonly relayUrl: string,
    private readonly token: TokenSupplier,
    options: RelayMachineSourceOptions = {}
  ) {
    assertCredentialMayTravelTo(relayUrl, options.build ?? 'release')
    const f =
      options.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike | undefined)
    if (!f) throw new Error('No fetch in this environment: pass one in the options')
    this.fetch = f
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  async list(): Promise<Machine[]> {
    const bearer = await this.token()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let status: number
    let text: string
    try {
      const response = await this.fetch(`${this.relayUrl.replace(/\/+$/, '')}/machines`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
        signal: controller.signal
      })
      status = response.status
      text = await response.text()
    } catch (cause) {
      if (controller.signal.aborted)
        throw new ServerError('timeout', 'The relay did not answer in time.', { cause })
      throw new ServerError('network', 'The relay could not be reached.', { cause })
    } finally {
      clearTimeout(timer)
    }
    if (status === 401)
      throw new ServerError('unauthenticated', 'The relay refused the sign-in.', { status })
    if (status < 200 || status >= 300)
      throw new ServerError('protocol', `The relay answered ${status}.`, { status })
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new ServerError('protocol', 'The relay answered something unreadable.', { status })
    }
    const machines = (body as { machines?: unknown })?.machines
    if (!Array.isArray(machines))
      throw new ServerError('protocol', 'The relay answered no machine list.', { status })
    return machines.map((raw, index) => {
      const m = raw as Record<string, unknown>
      if (typeof m?.id !== 'string' || !m.id)
        throw new ServerError('protocol', `The relay's machine ${index} has no id.`, { status })
      return {
        id: m.id,
        name: typeof m.name === 'string' && m.name ? m.name : m.id,
        platform: platformOf(m.platform),
        version: typeof m.version === 'string' ? m.version : '',
        online: m.online === true,
        lastSeen: lastSeenOf(m.lastSeen),
        baseUrl: machineBaseUrl(this.relayUrl, m.id),
        pushUrl: machinePushUrl(this.relayUrl, m.id)
      }
    })
  }
}

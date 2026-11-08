/**
 * Which tailnet machine of the scan is already one of this Mac's saved
 * servers (PRDCT-4163). A saved server is an address; a machine of the
 * tailnet answers to several names (its IPv4, its DNS name, its host name).
 * The machine IS the saved server when the saved address's host is one of
 * those names and its port is the port the scan probed: one address and
 * port is one server process, so a server saved under another port is
 * another server and the machine stays offerable. Pure: the page decides
 * what to draw from the answer.
 */
import type { SavedServerConnection } from '@clave/contract/fleet'
import type { TailnetMachine } from '../../../shared/server-setup-types'

function parsed(url: string): { host: string; port: string } | null {
  try {
    const u = new URL(url)
    const port = u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '')
    return { host: u.hostname.toLowerCase(), port }
  } catch {
    return null
  }
}

/** The names a tailnet machine answers to, lowercased, the DNS name without
 *  its trailing dot. */
export function tailnetNamesOf(machine: Pick<TailnetMachine, 'name' | 'dnsName' | 'ip'>): string[] {
  return [machine.ip, machine.dnsName.replace(/\.$/, ''), machine.name]
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0)
}

/** The saved server this machine already is, or undefined. A machine with
 *  no address of its own (no IPv4) matches nothing: without a port there is
 *  no way to be sure it is the same server process. */
export function savedServerOf(
  machine: TailnetMachine,
  connections: readonly SavedServerConnection[]
): SavedServerConnection | undefined {
  const own = machine.url ? parsed(machine.url) : null
  if (!own) return undefined
  const names = new Set(tailnetNamesOf(machine))
  return connections.find((connection) => {
    const saved = parsed(connection.url)
    return saved !== null && saved.port === own.port && names.has(saved.host)
  })
}

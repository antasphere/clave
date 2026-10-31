import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const INVALID_HOST = '--host must name one explicit interface IP or hostname, never a wildcard'

/** WHATWG parsing canonicalizes the numeric forms getaddrinfo accepts, such
 *  as IPv4 integers/octal/hex and compressed or expanded IPv6 addresses. */
export function normalizeListenHost(input: string): string {
  if (
    !input ||
    (!isIP(input) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.?$/.test(input))
  )
    throw new Error(INVALID_HOST)
  let host: string
  try {
    const parsed = new URL(`http://${isIP(input) === 6 ? `[${input}]` : input}`)
    host = parsed.hostname.replace(/^\[|\]$/g, '')
  } catch {
    throw new Error(INVALID_HOST)
  }
  // IPv4-mapped zero also listens on every IPv4 interface on supported OSes.
  if (host === '0.0.0.0' || host === '::' || host === '::ffff:0:0') {
    throw new Error(INVALID_HOST)
  }
  return host
}

export type ListenHostLookup = (
  hostname: string
) => Promise<ReadonlyArray<{ address: string; family: number }>>

/** Bind the checked numeric address, never a second DNS answer. A hostname
 *  with any unspecified result fails closed, including mixed DNS answers. */
export async function resolveListenHost(
  input: string,
  resolve: ListenHostLookup = (hostname) => lookup(hostname, { all: true }),
  timeoutMs = 5000
): Promise<string> {
  const host = normalizeListenHost(input)
  if (isIP(host)) return host
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const results = await Promise.race([
      resolve(host),
      new Promise<never>((_done, reject) => {
        timer = setTimeout(
          () => reject(new Error('The listen hostname resolution timed out')),
          timeoutMs
        )
      })
    ])
    if (!results.length) throw new Error('The listen hostname resolved to no address')
    const addresses = results.map(({ address }) => {
      const value = normalizeListenHost(address)
      if (!isIP(value)) throw new Error('The listen hostname did not resolve to an IP address')
      return value
    })
    return addresses[0]
  } finally {
    clearTimeout(timer)
  }
}

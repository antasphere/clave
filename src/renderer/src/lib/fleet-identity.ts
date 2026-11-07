import {
  LOCAL_SERVER_ID,
  resourceKey,
  parseResourceKey,
  type ResourceKind
} from '@clave/contract/fleet'

/** All renderer caches keep the encoded key. Decode only at a routing boundary. */
export function ownerOf(key: string | null | undefined): string {
  if (!key?.startsWith('clave-owner:')) return LOCAL_SERVER_ID
  const kind = key.split(':')[1] as ResourceKind
  if (!['session', 'group', 'workspace', 'file', 'request'].includes(kind))
    throw new Error('Invalid resource identity.')
  return parseResourceKey(kind, key).serverId
}
export const isRemoteKey = (key: string | null | undefined): boolean =>
  ownerOf(key) !== LOCAL_SERVER_ID

export function partitionLayout<
  T extends { groups: Array<{ id: string }>; displayOrder: string[] }
>(state: T, serverId: string): T {
  return {
    ...state,
    groups: state.groups.filter((g) => ownerOf(g.id) === serverId),
    displayOrder: state.displayOrder.filter((id) => ownerOf(id) === serverId)
  }
}

/** A server's loopback or local file URL never names a preview on this Mac. */
export function canOpenRemotePage(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname.replace(/\.$/, '').replace(/^\[|\]$/g, '')
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      host !== 'localhost' &&
      !host.endsWith('.localhost') &&
      !/^127\./.test(host) &&
      !['::1', '::', '0.0.0.0'].includes(host)
    )
  } catch {
    return false
  }
}

export function ownedFilePath(root: string, file: string): string {
  const ref = parseResourceKey('file', root)
  const path = file.startsWith('/') ? file : `${ref.id.replace(/\/$/, '')}/${file}`
  return resourceKey('file', ref.serverId, path)
}

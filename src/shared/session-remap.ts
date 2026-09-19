/** Only identity references move. Names, commands, paths and group IDs do not. */
export function remapSessionId(id: string, mappings: Readonly<Record<string, string>>): string {
  return mappings[id] ?? id
}

export function remapSessionLayout<T extends { groups: unknown[]; displayOrder: string[] }>(
  layout: T,
  mappings: Readonly<Record<string, string>>
): T {
  let changed = false
  const remap = (id: unknown): unknown => {
    const next = typeof id === 'string' ? remapSessionId(id, mappings) : id
    if (next !== id) changed = true
    return next
  }
  const result = {
    ...layout,
    displayOrder: [...new Set(layout.displayOrder.map((id) => remap(id) as string))],
    groups: layout.groups.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value
      const group = value as Record<string, unknown>
      return {
        ...group,
        ...(Array.isArray(group.sessionIds)
          ? { sessionIds: [...new Set(group.sessionIds.map(remap))] }
          : {}),
        ...(Array.isArray(group.terminals)
          ? {
              terminals: group.terminals.map((value) => {
                if (!value || typeof value !== 'object' || Array.isArray(value)) return value
                const terminal = value as Record<string, unknown>
                return { ...terminal, sessionId: remap(terminal.sessionId) }
              })
            }
          : {})
      }
    })
  } as T
  return changed ? result : layout
}

export function remapHiddenOwner<T extends { link?: unknown }>(
  record: T,
  mappings: Readonly<Record<string, string>>
): T {
  const link = record.link as { kind?: string; ownerId?: string } | undefined
  return link?.kind === 'session-view' && link.ownerId
    ? { ...record, link: { ...link, ownerId: remapSessionId(link.ownerId, mappings) } }
    : record
}

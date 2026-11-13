/**
 * Lane C of the harness wave (PRDCT-4496): the stored connection a Pi or
 * OpenCode tab runs on. A clone of such a tab (the sidebar's Duplicate)
 * carries the connection id and label from its source, as a Codex clone
 * carries its account (`codexAccountSessionFields`): main resolves the key by
 * the id at spawn, so leaving it out would put the clone on the person's own
 * provider login while every readout still named the connection. Never the
 * value: only the id and the label travel.
 */
export function connectionSessionFields(session: {
  piMode?: boolean
  opencodeMode?: boolean
  connectionId?: string
  connectionLabel?: string
}): { connectionId?: string; connectionLabel?: string } {
  if (!(session.piMode || session.opencodeMode) || !session.connectionId) return {}
  return { connectionId: session.connectionId, connectionLabel: session.connectionLabel }
}

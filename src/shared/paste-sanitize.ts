/**
 * What a message typed into another tab may carry. Newlines and tabs are
 * kept (they are text inside a bracketed paste); every other byte below
 * 0x20, and DEL, is removed, so the whole message stays pasted text under
 * its provenance header and the one trailing submit sends it as one turn.
 * The renderer's dispatcher and main's typing sequence (wave 4) use the
 * same filter, so what is recorded is what was delivered.
 */
export function sanitizeForPaste(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

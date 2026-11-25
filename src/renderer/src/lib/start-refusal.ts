/**
 * The sentence of a start the spawn refused, as the window's road of
 * `clave_open_session` says it (PRDCT-5166): an unknown writing style, a
 * folder that is not there. The refusal reaches the window in three shapes:
 * an Error (the server's `SessionStartFailed`, decoded), a plain tagged object
 * with its `message` (a failure that crossed a boundary as data), or main's
 * IPC error, whose message Electron prefixes with the channel. Each is said
 * in the spawn's own words; until then a tagged object read "[object Object]".
 */
export function startRefusalText(err: unknown): string {
  const message =
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message
      : String(err)
  return (
    message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '').trim() ||
    'The session could not start'
  )
}

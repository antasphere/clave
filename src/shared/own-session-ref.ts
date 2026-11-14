/**
 * `"mine"` is the calling tab, on every agent tool that takes a session id
 * and on every road (PRDCT-4507): the Mac's own tool server, the window's,
 * and a Clave server's. Each road resolves it here, once, and nowhere else,
 * so a tab names itself the same way to `clave_rename` as to
 * `clave_close_session`. Any other reference is returned as given: an id, a
 * name, `"parent"` stay the tool's own to resolve.
 */
export function ownSessionRef(
  ref: string,
  callerSessionId: string | undefined,
  field = 'sessionId'
): string {
  if (ref !== 'mine') return ref
  if (!callerSessionId)
    throw new Error(`${field} "mine" needs a calling tab — this request has no tab identity`)
  return callerSessionId
}

/** Match only the two answer routes, including the installed HTTP router's
 * case, slash, percent-encoding and query normalization. */
export const privateAnswerPath = (
  url: string
): '/sessions/write' | '/requests/resolve' | undefined => {
  try {
    const raw = url.replace(/^https?:\/\/.*?\//, '/').split(/[;?#]/, 1)[0]
    const path = decodeURI(raw.replace(/\/+/g, '/')).replace(/\/$/, '').toLowerCase()
    return path === '/sessions/write' || path === '/requests/resolve' ? path : undefined
  } catch {
    return undefined
  }
}

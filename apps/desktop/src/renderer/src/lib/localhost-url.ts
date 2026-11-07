// Shared terminal-output helpers for localhost dev-server detection, used by
// use-terminal.ts (group sessions), use-remote-terminal.ts (remote sessions),
// and use-server-button.ts (toolbar server buttons).

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g

export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '')
}

const LOCALHOST_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})(?:\/\S*)?/i

export function detectLocalhostUrl(buffer: string): string | null {
  const match = buffer.match(LOCALHOST_URL_RE)
  if (!match) return null
  try {
    new URL(match[0])
    return match[0]
  } catch {
    return null
  }
}

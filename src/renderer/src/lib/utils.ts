export { cn } from '@clave/ui/components'

export function fileUrl(absolutePath: string): string {
  return 'file://' + absolutePath.split('/').map(encodeURIComponent).join('/')
}

export function shortenPath(fullPath: string): string {
  // A registry entry without a root (a hand-edited or legacy
  // workspace-state.json, read raw over IPC when the server is named late)
  // used to take the whole window down from the toolbar's workspace popover,
  // the first render throwing on undefined; it answers an empty label now.
  if (typeof fullPath !== 'string') return ''
  // Replace /Users/<name> with ~
  return fullPath.replace(/^\/Users\/[^/]+/, '~')
}

export function safePort(url: string): number | null {
  try {
    const p = Number(new URL(url).port)
    return p || null
  } catch {
    return null
  }
}

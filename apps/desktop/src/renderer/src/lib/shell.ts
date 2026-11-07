import { writeUserInput } from './user-input'

export function shellEscape(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`
}

/** Insert a shell-escaped path into the session's input as USER input (file
 *  palette) — through the shared helper so the draft shadow tracks it. */
export function insertPath(sessionId: string, filePath: string): void {
  writeUserInput(sessionId, shellEscape(filePath))
}

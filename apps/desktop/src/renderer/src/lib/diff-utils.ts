export interface DiffLine {
  type: 'add' | 'del' | 'context' | 'hunk' | 'binary'
  content: string
}

export function parseDiffLines(raw: string): DiffLine[] {
  const lines: DiffLine[] = []
  const rawLines = raw.split('\n')

  if (rawLines.some((l) => l.startsWith('Binary files') && l.includes('differ'))) {
    return [{ type: 'binary', content: 'Binary file' }]
  }

  let inHunk = false
  for (const line of rawLines) {
    if (line.startsWith('@@')) {
      inHunk = true
      lines.push({ type: 'hunk', content: line })
    } else if (inHunk) {
      if (line.startsWith('+')) {
        lines.push({ type: 'add', content: line.slice(1) })
      } else if (line.startsWith('-')) {
        lines.push({ type: 'del', content: line.slice(1) })
      } else {
        lines.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : line })
      }
    }
  }
  return lines
}

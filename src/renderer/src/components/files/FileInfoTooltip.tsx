import { useEffect, useState } from 'react'
import type { FileReadResult } from '../../../../preload/index.d'
import { Tooltip, TooltipTrigger, TooltipContent } from '@clave/ui/components'
import { formatSize, countLines } from './file-types'

interface FileInfoTooltipProps {
  cwd: string | null
  /** Path as the surface holds it — relative to cwd, or absolute. */
  filePath: string | null
  fileData: FileReadResult | null
  /** The live buffer, so the line count follows unsaved edits. */
  content: string
  children: React.ReactNode
}

/**
 * The file's metadata — size, lines, last modified, where it lives — shown on
 * hover over a file surface's title. It used to sit in a bar of its own along
 * the bottom of every file tab and preview sheet, permanently spending a row on
 * two numbers nobody reads twice; the title is where you look when you want to
 * know what this is, so that is where the answer waits.
 */
export function FileInfoTooltip({
  cwd,
  filePath,
  fileData,
  content,
  children
}: FileInfoTooltipProps): React.JSX.Element {
  // Modified time comes from a stat, not the read (which carries size only).
  // Re-stat when the read result changes: a save reloads fileData.
  const [modified, setModified] = useState<number | null>(null)
  useEffect(() => {
    if (!filePath || (!cwd && !filePath.startsWith('/'))) return
    let cancelled = false
    window.electronAPI
      ?.statFile(cwd ?? '/', filePath)
      .then((stat) => {
        if (!cancelled) setModified(stat.modified)
      })
      .catch(() => {
        if (!cancelled) setModified(null)
      })
    return () => {
      cancelled = true
    }
  }, [cwd, filePath, fileData])

  const abs = filePath ? (filePath.startsWith('/') ? filePath : `${cwd ?? ''}/${filePath}`) : ''
  const rows: [string, string][] = []
  if (fileData) rows.push(['Size', formatSize(fileData.size)])
  if (fileData && !fileData.binary) rows.push(['Lines', String(countLines(content))])
  if (fileData?.truncated) rows.push(['Shown', 'first 1 MB'])
  if (modified !== null) rows.push(['Modified', new Date(modified).toLocaleString()])
  if (abs) rows.push(['Path', abs.replace(/^\/Users\/[^/]+/, '~')])

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {rows.length > 0 && (
        <TooltipContent side="bottom" align="start" className="max-w-md">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-text-tertiary">{label}</dt>
                <dd className="truncate">{value}</dd>
              </div>
            ))}
          </dl>
        </TooltipContent>
      )}
    </Tooltip>
  )
}

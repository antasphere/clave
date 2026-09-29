import type { DiffLine } from '../../lib/diff-utils'

interface DiffLinesViewProps {
  lines: DiffLine[]
  loading: boolean
  error: string | null
  className?: string
}

export function DiffLinesView({
  lines,
  loading,
  error,
  className
}: DiffLinesViewProps): React.JSX.Element {
  return (
    <div className={`overflow-auto font-mono text-[11px] leading-[18px] ${className ?? ''}`}>
      {loading && (
        <div className="flex items-center justify-center py-8">
          <span className="text-xs text-text-tertiary">Loading diff...</span>
        </div>
      )}
      {error && <div className="px-3 py-2 text-xs text-red-400">{error}</div>}
      {!loading && !error && lines.length === 0 && (
        <div className="flex items-center justify-center py-8">
          <span className="text-xs text-text-tertiary">No changes</span>
        </div>
      )}
      {!loading &&
        !error &&
        lines.map((line, i) => {
          let bg = ''
          let textColor = 'text-text-secondary'
          if (line.type === 'add') {
            bg = 'bg-green-500/10'
            textColor = 'text-green-400'
          } else if (line.type === 'del') {
            bg = 'bg-red-500/10'
            textColor = 'text-red-400'
          } else if (line.type === 'hunk') {
            bg = 'bg-blue-500/10'
            textColor = 'text-blue-400'
          } else if (line.type === 'binary') {
            textColor = 'text-text-tertiary'
          }
          return (
            <div key={i} className={`px-3 whitespace-pre ${bg} ${textColor}`}>
              {line.type === 'add' && <span className="select-none mr-1">+</span>}
              {line.type === 'del' && <span className="select-none mr-1">-</span>}
              {line.type === 'context' && <span className="select-none mr-1"> </span>}
              {line.content}
            </div>
          )
        })}
    </div>
  )
}

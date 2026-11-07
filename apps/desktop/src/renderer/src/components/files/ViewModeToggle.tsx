import { MARKDOWN_MODES, type FileViewMode } from './file-types'

const LABELS: Record<FileViewMode, string> = {
  page: 'Page',
  preview: 'Preview',
  source: 'Source',
  rendered: 'Rendered'
}

/** Segmented view-mode switcher shown in file headers — Page / Preview / Source
 *  for markdown (default), Rendered / Source for HTML via `modes` (HTML_MODES). */
export function ViewModeToggle({
  mode,
  onChange,
  modes = MARKDOWN_MODES
}: {
  mode: FileViewMode
  onChange: (mode: FileViewMode) => void
  modes?: FileViewMode[]
}): React.JSX.Element {
  return (
    <div className="segmented flex-shrink-0">
      {modes.map((key) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          data-active={mode === key}
          className="segmented-item"
        >
          {LABELS[key]}
        </button>
      ))}
    </div>
  )
}

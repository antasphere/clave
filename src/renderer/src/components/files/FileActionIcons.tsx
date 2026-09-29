/** Shared inline SVG icons for file action buttons */

export function CopyIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8.5 3.5V2C8.5 1.45 8.05 1 7.5 1H2C1.45 1 1 1.45 1 2V7.5C1 8.05 1.45 8.5 2 8.5H3.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

export function FolderIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M1 3C1 2.45 1.45 2 2 2H4.5L6 3.5H10C10.55 3.5 11 3.95 11 4.5V9C11 9.55 10.55 10 10 10H2C1.45 10 1 9.55 1 9V3Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

export function ExternalLinkIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M7 1h4v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 1L5.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M9 7v3.5c0 .28-.22.5-.5.5h-7a.5.5 0 0 1-.5-.5v-7c0-.28.22-.5.5-.5H5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

export function CloseIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function EditIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M8.5 1.5L10.5 3.5L4 10H2V8L8.5 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M7 3L9 5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

export function OpenInTabIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2 4V2.5C2 2.22 2.22 2 2.5 2H9.5C9.78 2 10 2.22 10 2.5V4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M1 4h10v6.5c0 .28-.22.5-.5.5h-9a.5.5 0 0 1-.5-.5V4Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M4 2v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/** Standard button styling for file action icon buttons */
export const fileActionButtonClass = 'btn-icon btn-icon-sm'

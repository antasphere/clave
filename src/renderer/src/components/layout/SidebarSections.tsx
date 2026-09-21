export function SectionHeading({
  title,
  onToggle,
  actions
}: {
  title: string
  /** When provided, the whole label toggles the section (no disclosure arrow). */
  onToggle?: () => void
  actions?: React.ReactNode
}) {
  // Both paddings derive from the shared sidebar keyline (--sidebar-gutter) so
  // the label aligns with row text on the left and any action icons align with
  // the rows' trailing icons on the right.
  const label = <span className="text-control font-medium text-text-tertiary">{title}</span>
  return (
    <div className="w-full flex items-center px-[var(--sidebar-gutter)] pt-3.5 pb-1 flex-shrink-0">
      {onToggle ? (
        <button onClick={onToggle} className="text-left">{label}</button>
      ) : (
        label
      )}
      {actions && <div className="ml-auto flex items-center gap-0.5">{actions}</div>}
    </div>
  )
}

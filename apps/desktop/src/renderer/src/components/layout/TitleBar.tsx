export function TitleBar(): React.JSX.Element {
  return (
    <div
      className="fixed top-0 left-0 right-0 h-12 z-50"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    />
  )
}

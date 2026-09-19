export function ThemeToggle({
  theme,
  setTheme
}: {
  theme: string
  setTheme: (theme: 'dark' | 'light') => void
}): React.JSX.Element {
  const toggle = (): void => setTheme(theme === 'dark' ? 'light' : 'dark')

  return (
    <button
      onClick={toggle}
      className="btn-icon btn-icon-md"
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {theme === 'dark' ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.5" />
          <line
            x1="8"
            y1="1"
            x2="8"
            y2="3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="8"
            y1="13"
            x2="8"
            y2="15"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="1"
            y1="8"
            x2="3"
            y2="8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="13"
            y1="8"
            x2="15"
            y2="8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="3.05"
            y1="3.05"
            x2="4.46"
            y2="4.46"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="11.54"
            y1="11.54"
            x2="12.95"
            y2="12.95"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="3.05"
            y1="12.95"
            x2="4.46"
            y2="11.54"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="11.54"
            y1="4.46"
            x2="12.95"
            y2="3.05"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path
            d="M14 9.5A6.5 6.5 0 016.5 2c0-.5.06-1 .17-1.47A7 7 0 108.47 14.83c-.47.11-.97.17-1.47.17a6.47 6.47 0 007-4.5z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  )
}

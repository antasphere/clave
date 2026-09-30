import {
  Squares2X2Icon,
  SquaresPlusIcon,
  MagnifyingGlassIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import { resolveColorHex, type GroupTerminalColor } from '../../store/session-types'

/** One chip. A group the workspace knows about, whether or not it is running. */
export interface SwitcherEntry {
  /** Stable react key — a pin and a live group can share a name. */
  key: string
  name: string
  color: GroupTerminalColor | null
  /** The live group's id, or null when the group is declared but not spawned. */
  liveGroupId: string | null
  /** The pin to spawn when it is not live. */
  pinnedId: string | null
}

interface GroupSwitcherProps {
  /** Every group the workspace knows about, already narrowed by the search. */
  entries: SwitcherEntry[]
  /** The live group id the list is filtered to, or null for All. */
  value: string | null
  onPick: (entry: SwitcherEntry) => void
  onAll: () => void
  onAddGroup: () => void
  addGroupActive?: boolean
  search: string
  onSearchChange: (value: string) => void
  /** Enter: act on the first entry the search left standing. */
  onSearchSubmit: () => void
}

/**
 * The group switcher: a panel under the session launcher listing every group the
 * workspace knows about — All, a chip per group, and the `+` for the full picker.
 *
 * "Knows about" is the important part, and it is what this got wrong at first.
 * The chips are drawn from the workspace's PINNED groups (the ones declared in
 * `.clave` and auto-discovered from the tree), not from the handful currently
 * spawned. A workspace declares dozens and runs three; a switcher that lists the
 * three can only ever take you where you already are. Live groups without a pin
 * are listed too, so nothing on screen is missing from it.
 *
 * A chip therefore does one of two things. Not running: spawn it, exactly as the
 * picker dialog does. Running: filter the sidebar list to it, and back to All on
 * a second click. Filtering touches the LIST only and leaves the terminals you
 * are looking at where they are.
 *
 * The search narrows the chips, so typing a group's name is how you reach one of
 * the dozens that is not on screen; the same query narrows the session list
 * below. Enter acts on the first chip left standing — and that chip carries the
 * hover state from the moment you type, without the pointer. Enter had no
 * visible target before: you typed, the chips reordered, and the only way to
 * know which one Enter would take was to press it. The highlight is that answer,
 * drawn where the answer is.
 *
 * Its top row is fixed — All, the field, the `+`. None of the three belongs to
 * the wrapping set: All is the filter's off position, the field is never
 * "selected" the way a chip is, and the `+` is the panel's action. Pinning them
 * also keeps them still while the chips below change under the search.
 *
 * The chip row under it is the only part that comes and goes: with nothing to
 * show it collapses away entirely rather than reserving a line for a placeholder,
 * and it opens on a height transition when the first chip arrives — starting a
 * group, or a search reaching past the running ones.
 *
 * Named "switcher", not "rail": .group-rail is a group card's session list in
 * the sidebar below (once a coloured bar down it, hence the name).
 */
export function GroupSwitcher({
  entries,
  value,
  onPick,
  onAll,
  onAddGroup,
  addGroupActive,
  search,
  onSearchChange,
  onSearchSubmit
}: GroupSwitcherProps): React.JSX.Element {
  const searching = search.trim().length > 0
  return (
    <div className="group-switcher-panel">
      {/* Fixed top row: the filter's off position, the search field, the panel's
          action. The chips wrap under it. */}
      <div className="group-switcher-head">
        <button
          className="group-switcher-chip"
          data-selected={value === null ? 'true' : undefined}
          onClick={onAll}
          title="All sessions"
        >
          <Squares2X2Icon className="w-3.5 h-3.5 flex-shrink-0" />
          <span>All</span>
        </button>

        <div className="group-switcher-search">
          <MagnifyingGlassIcon className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
          <input
            type="text"
            // What Cmd+F reaches for. The shortcut has been aiming at this
            // attribute since before the field was dropped from the sidebar and
            // rebuilt here, and it found nothing in between.
            data-sidebar-search
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && search.trim()) {
                e.preventDefault()
                e.stopPropagation()
                onSearchSubmit()
              } else if (e.key === 'Escape' && search) {
                e.stopPropagation()
                onSearchChange('')
              }
            }}
            placeholder="Search groups"
            aria-label="Search groups and sessions"
            spellCheck={false}
          />
          {search && (
            <button
              className="group-switcher-search-clear"
              onClick={() => onSearchChange('')}
              title="Clear search"
              aria-label="Clear search"
            >
              <XMarkIcon className="w-3 h-3" />
            </button>
          )}
        </div>

        <button
          className="group-switcher-add launcher-icon-btn"
          data-active={addGroupActive ? 'true' : undefined}
          onClick={onAddGroup}
          title="Add a group"
          aria-label="Add a group"
        >
          <SquaresPlusIcon className="w-4 h-4" />
        </button>
      </div>

      {/* The chips' row exists only when it holds chips. Empty — a workspace with
          nothing running, a search that matched no group — it collapses to
          nothing and the panel sits at its head row's height, instead of holding
          a strip of placeholder text open under every sidebar forever: the row
          arriving IS the news that a group arrived, and the list below already
          says "No matching sessions" when a search finds nothing.

          A grid track is what makes that animatable — 0fr → 1fr transitions
          where height: auto does not — so the chips get an inner box of their
          own to be clipped by. */}
      <div className="group-switcher-wrap" data-empty={entries.length === 0 ? 'true' : undefined}>
        <div className="group-switcher-chips">
          {entries.map((entry, index) => {
            const hex = resolveColorHex(entry.color)
            const live = entry.liveGroupId !== null
            const selected = live && entry.liveGroupId === value
            // The chip Enter would act on, derived from the same array
            // `onSearchSubmit` reads its first element of — so the highlight
            // cannot drift from what the key actually does.
            const enterTarget = searching && index === 0
            return (
              <button
                key={entry.key}
                className="group-switcher-chip"
                data-selected={selected ? 'true' : undefined}
                data-enter-target={enterTarget ? 'true' : undefined}
                data-idle={live ? undefined : 'true'}
                onClick={() => onPick(entry)}
                title={
                  !live
                    ? `Start ${entry.name}${enterTarget ? ' — Enter' : ''}`
                    : selected
                      ? `Showing ${entry.name} only — click for all`
                      : `Show ${entry.name} only${enterTarget ? ' — Enter' : ''}`
                }
                // Selected takes the group's own colour at the same strength its
                // card uses in the list, so the chip and the group it filtered to
                // read as the same object.
                style={hex && selected ? { backgroundColor: `${hex}4d` } : undefined}
              >
                {/* A hollow dot for a group that is declared but not running, a
                    filled one once it is — the same distinction the chip's click
                    makes, readable before you click it. */}
                <span
                  className="group-switcher-dot"
                  style={
                    hex
                      ? live
                        ? { backgroundColor: hex }
                        : { backgroundColor: 'transparent', boxShadow: `inset 0 0 0 1.5px ${hex}` }
                      : undefined
                  }
                />
                <span className="truncate">{entry.name}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

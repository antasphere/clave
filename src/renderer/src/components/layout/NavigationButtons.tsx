import { useState } from 'react'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChatBubbleLeftEllipsisIcon,
  Cog6ToothIcon,
  DocumentIcon,
  DocumentTextIcon,
  GlobeAltIcon,
  PresentationChartBarIcon,
  PuzzlePieceIcon,
  RectangleGroupIcon,
  Squares2X2Icon,
  SquaresPlusIcon,
  UserGroupIcon,
  WindowIcon
} from '@heroicons/react/24/outline'
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu'
import { usePluginUIStore } from '../plugins/plugin-ui-store'
import { useNavigationStore } from '../../store/navigation-store'
import { useSessionStore } from '../../store/session-store'
import { useWorkspaceStore } from '../../store/workspace-store'
import { useShortcutLabel } from '../../store/keymap-store'
import { placesToward, stepTarget, type NavigationHistory } from '../../lib/navigation-history'
import { placeAlive, placeLabel, type PlaceKind } from '../../lib/navigation-place'

/** One glyph per kind of place, in the lists behind the buttons. */
const PLACE_ICONS: Record<PlaceKind, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  tab: WindowIcon,
  tabs: Squares2X2Icon,
  file: DocumentIcon,
  'group-page': RectangleGroupIcon,
  'tab-page': GlobeAltIcon,
  plugin: PuzzlePieceIcon,
  settings: Cog6ToothIcon,
  agents: UserGroupIcon,
  extensions: SquaresPlusIcon,
  ongoing: ChatBubbleLeftEllipsisIcon,
  artefact: PresentationChartBarIcon,
  document: DocumentTextIcon
}

/** The toolbar's menus open this far under their button (its popovers' `sideOffset`). */
const MENU_GAP = 8

type Direction = 'back' | 'forward'

const DELTA: Record<Direction, -1 | 1> = { back: -1, forward: 1 }

/** The list open behind one button: where it opens, and the history it lists. A move
 *  through the history (a step, a new place) closes it: its rows would be stale. */
interface OpenList {
  direction: Direction
  x: number
  y: number
  history: NavigationHistory
}

/**
 * Back and Forward (PRDCT-5155), in the toolbar's left cluster after the
 * sidebar toggle: a click steps to the nearest place in that direction that
 * still exists, a right-click lists those places by name. Disabled when
 * there is none.
 */
export function NavigationButtons(): React.JSX.Element {
  const history = useNavigationStore((s) => s.history)
  // What decides whether a recorded place still exists: the buttons are judged
  // again when one of these changes, not only when the history does.
  useSessionStore((s) => s.sessions)
  useSessionStore((s) => s.fileTabs)
  useSessionStore((s) => s.groups)
  useWorkspaceStore((s) => s.workspaces)
  useWorkspaceStore((s) => s.serverWorkspaces)
  usePluginUIStore((s) => s.records)
  const backShortcut = useShortcutLabel('navigateBack')
  const forwardShortcut = useShortcutLabel('navigateForward')
  const [list, setList] = useState<OpenList | null>(null)

  const enabled: Record<Direction, boolean> = {
    back: stepTarget(history, -1, placeAlive) !== null,
    forward: stepTarget(history, 1, placeAlive) !== null
  }
  const shown = list !== null && list.history === history ? list : null
  const items: ContextMenuItem[] = shown
    ? placesToward(history, DELTA[shown.direction], placeAlive).map(({ index, place }) => {
        const { label, kind } = placeLabel(place)
        const Icon = PLACE_ICONS[kind]
        return {
          id: String(index),
          label,
          content: (
            <span className="nav-history-row">
              <span className="menu-glyph">
                <Icon className="w-3.5 h-3.5" />
              </span>
              <span className="nav-history-name">{label}</span>
            </span>
          ),
          attributes: { 'data-nav-entry': '', 'data-nav-index': String(index) },
          onClick: () => void useNavigationStore.getState().go(index)
        }
      })
    : []

  const button = (direction: Direction): React.JSX.Element => {
    const name = direction === 'back' ? 'Back' : 'Forward'
    const shortcut = direction === 'back' ? backShortcut : forwardShortcut
    const title = shortcut ? `${name} (${shortcut})` : name
    const Icon = direction === 'back' ? ArrowLeftIcon : ArrowRightIcon
    return (
      <button
        className="btn-icon btn-icon-md"
        title={title}
        aria-label={title}
        data-nav={direction}
        disabled={!enabled[direction]}
        onClick={() => {
          const store = useNavigationStore.getState()
          void (direction === 'back' ? store.back() : store.forward())
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          if (!enabled[direction]) return
          const box = event.currentTarget.getBoundingClientRect()
          setList({ direction, x: box.left, y: box.bottom + MENU_GAP, history })
        }}
      >
        <Icon className="w-4 h-4" />
      </button>
    )
  }

  return (
    <div className="flex items-center gap-0.5">
      {button('back')}
      {button('forward')}
      {shown && items.length > 0 && (
        <ContextMenu
          items={items}
          x={shown.x}
          y={shown.y}
          onClose={() => setList(null)}
          className="nav-history-menu"
          attributes={{ 'data-nav-list': shown.direction }}
        />
      )}
    </div>
  )
}

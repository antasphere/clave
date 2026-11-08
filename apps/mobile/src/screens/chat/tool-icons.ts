import type { ToolKind } from '../../chat/tools'
import type { IconName } from '../../ui/Icon'

/** The glyph of each kind of call (the desktop's `tool-icons.ts`). */
export const KIND_ICONS: Record<ToolKind, IconName> = {
  read: 'document-text',
  search: 'magnifying-glass',
  edit: 'pencil-square',
  command: 'command-line',
  skill: 'book-open',
  web: 'globe-alt',
  agent: 'cpu-chip',
  other: 'wrench'
}

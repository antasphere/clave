import {
  BookOpenIcon,
  CommandLineIcon,
  CpuChipIcon,
  DocumentTextIcon,
  GlobeAltIcon,
  MagnifyingGlassIcon,
  PencilSquareIcon,
  WrenchIcon
} from '@heroicons/react/24/outline'
import type { ToolKind } from './tools'

/** The glyph of each kind of call, shared by the Chat view's rows and the
 *  Terminal view's calls. */
export const KIND_ICONS: Record<ToolKind, typeof WrenchIcon> = {
  read: DocumentTextIcon,
  search: MagnifyingGlassIcon,
  edit: PencilSquareIcon,
  command: CommandLineIcon,
  skill: BookOpenIcon,
  web: GlobeAltIcon,
  agent: CpuChipIcon,
  other: WrenchIcon
}

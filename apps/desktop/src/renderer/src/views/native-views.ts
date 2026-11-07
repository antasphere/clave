import type { ComponentType } from 'react'
import { ChatView, type ChatViewProps } from '../../../../../plugins/chat-view/src/ChatView'
import { TerminalView } from '../../../../../plugins/chat-view/src/TerminalView'
import { RoutineReportView } from '../../../../../plugins/routine-report/src/RoutineReportView'

/** Bundled native views, keyed by the id a session carries: `<pluginId>/<viewId>`.
 *  A plugin contributing several views has one entry per view, which is what
 *  lets the picker offer them and a session name one. */
export const nativeViews: Record<string, ComponentType<ChatViewProps>> = {
  'clave.chat-view/chat': ChatView,
  'clave.chat-view/terminal': TerminalView,
  // ADR 0004: a routine run's report, beside chat and terminal in the picker.
  'clave.routine-report/report': RoutineReportView
}
/** What this build can mount, handed to the pure resolution in `resolution.ts`. */
export const implemented: ReadonlySet<string> = new Set(Object.keys(nativeViews))

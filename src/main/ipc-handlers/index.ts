import { registerPluginHandlers } from './plugin-ipc'
import { registerSkinHandlers } from './skin-handlers'
import { registerLinkedDocumentHandlers } from '../linked-documents/runtime'
import { registerAppHandlers } from './app-handlers'
import { registerUsageHandlers } from './usage-handlers'
import { registerGitHandlers } from './git-handlers'
import { registerUpdaterHandlers } from './updater-handlers'
import { registerTelemetryHandlers } from './telemetry-handlers'
import { registerFeedbackHandlers } from './feedback-handlers'
import { registerFsHandlers } from './fs-handlers'
import { registerPtyHandlers } from './pty-handlers'
import { registerShellHandlers } from './shell-handlers'
import { registerLocationHandlers } from './location-handlers'
import { registerSshHandlers } from './ssh-handlers'
import { registerAgentHandlers } from './agent-handlers'
import { registerClaveFileHandlers } from './clave-file-handlers'
import { registerSessionExportHandlers } from './session-export-handlers'
import { registerDroppedFileHandlers } from './dropped-file-handlers'
import { registerAttachmentHandlers } from './attachment-handlers'
import { registerSidebarLayoutHandlers } from './sidebar-layout-handlers'
import { registerSecretHandlers } from './secret-handlers'
import { registerCopyOfferHandlers } from './copy-offer-handlers'
import { registerExtensionsHandlers } from './extensions-handlers'
import { registerMissionControlHandlers } from './mission-control-handlers'
import { registerWorkspaceHandlers } from './workspace-handlers'
import { registerExchangeHandlers } from './exchange-handlers'
import { registerPreviewHandlers } from './preview-handlers'
import { registerHistoryHandlers } from './history-handlers'
import { registerKeymapHandlers, type KeymapHandlerDeps } from './keymap-handlers'
import { registerLaunchProfileHandlers } from './launch-profile-handlers'
import { registerClaudeAccountHandlers } from './claude-accounts-handlers'

export function registerIpcHandlers(deps: KeymapHandlerDeps = {}): void {
  registerAppHandlers()
  registerPluginHandlers()
  registerSkinHandlers()
  registerClaudeAccountHandlers()
  registerUsageHandlers()
  registerGitHandlers()
  registerUpdaterHandlers()
  registerTelemetryHandlers()
  registerFeedbackHandlers()
  registerFsHandlers()
  registerPtyHandlers()
  registerShellHandlers()
  registerLocationHandlers()
  registerSshHandlers()
  registerAgentHandlers()
  registerClaveFileHandlers()
  registerSessionExportHandlers()
  registerDroppedFileHandlers()
  registerAttachmentHandlers()
  registerSidebarLayoutHandlers()
  registerSecretHandlers()
  registerCopyOfferHandlers()
  registerLinkedDocumentHandlers()
  registerExtensionsHandlers()
  registerMissionControlHandlers()
  registerWorkspaceHandlers()
  registerExchangeHandlers()
  registerPreviewHandlers()
  registerHistoryHandlers()
  registerKeymapHandlers(deps)
  registerLaunchProfileHandlers()
}

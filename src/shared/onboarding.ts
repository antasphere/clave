/** The first-run walk's contract between main (`src/main/onboarding.ts`) and
 *  the window (`components/onboarding/`). */
export type OnboardingAgentId = 'claude' | 'codex'

export interface OnboardingState {
  /** True until the walk is finished or skipped, on a first install only. */
  show: boolean
  /** Where the walk's first session starts when no workspace is open. */
  home: string
  /** The view new chats open in (`<pluginId>/<viewId>`), when one was picked. */
  chatView: string | null
  /** The skin chosen so far, or null when none ever was (the walk then
   *  starts on the one matching the Mac's own appearance). */
  skin: string | null
}

export interface OnboardingAgent {
  id: OnboardingAgentId
  /** Its command is on the login PATH. */
  installed: boolean
  installing: boolean
  /** What the one-click install runs, shown under the button; null when this
   *  Mac has nothing to install it with. */
  installCommand: string | null
  /** Where to read how to install it by hand, when there is no command. */
  helpUrl: string | null
}

export interface OnboardingInstallResult {
  ok: boolean
  /** Why it failed, in the installer's last words when it had any. */
  message: string | null
  agents: OnboardingAgent[]
}

export const ONBOARDING_IPC = {
  getState: 'onboarding:get-state',
  agents: 'onboarding:agents',
  install: 'onboarding:install',
  complete: 'onboarding:complete',
  createFolder: 'onboarding:create-folder',
  setChatView: 'onboarding:set-chat-view',
  /** Main → window: Help → Welcome to Clave… */
  open: 'onboarding:open'
} as const

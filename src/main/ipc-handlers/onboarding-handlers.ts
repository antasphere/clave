import { ipcMain } from 'electron'
import {
  completeOnboarding,
  createWorkspaceFolder,
  describeAgents,
  getOnboardingState,
  installAgent,
  setChatView
} from '../onboarding'
import { ONBOARDING_IPC, type OnboardingAgentId } from '../../shared/onboarding'

const IDS = new Set<string>(['claude', 'codex'])

export function registerOnboardingHandlers(): void {
  ipcMain.handle(ONBOARDING_IPC.getState, () => getOnboardingState())
  ipcMain.handle(ONBOARDING_IPC.agents, (_event, fresh: unknown) => describeAgents(fresh === true))
  ipcMain.handle(ONBOARDING_IPC.install, (_event, id: unknown) => {
    if (typeof id !== 'string' || !IDS.has(id)) throw new Error('Unknown agent')
    return installAgent(id as OnboardingAgentId)
  })
  ipcMain.handle(ONBOARDING_IPC.complete, () => completeOnboarding())
  ipcMain.handle(ONBOARDING_IPC.setChatView, (_event, viewId: unknown) => {
    if (typeof viewId === 'string') setChatView(viewId)
  })
  ipcMain.handle(ONBOARDING_IPC.createFolder, (_event, parent: unknown, name: unknown) => {
    if (typeof parent !== 'string' || typeof name !== 'string') throw new Error('Bad folder')
    return createWorkspaceFolder(parent, name)
  })
}
